/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { context as otelContext } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import type { Authenticator } from './authenticator';

const DEFAULT_REFRESH_MARGIN_MILLIS = 5000;
const DEFAULT_TOKEN_TIMEOUT_MILLIS = 10000;
const DEFAULT_FALLBACK_TTL_SECONDS = 3600;

/**
 * Configuration options for {@link OAuth2Authenticator}.
 *
 * @experimental This feature is in development as per the OpenTelemetry specification and is subject to breaking changes in minor releases.
 */
export interface OAuth2AuthenticatorOptions {
  /**
   * OAuth 2.0 token endpoint URL.
   */
  tokenUrl: string;
  /**
   * OAuth 2.0 client identifier.
   */
  clientId: string;
  /**
   * OAuth 2.0 client secret.
   */
  clientSecret: string;
  /**
   * Optional OAuth 2.0 scopes to request.
   */
  scopes?: string[];
  /**
   * Optional audience parameter to include in the token request body.
   */
  audience?: string;
  /**
   * Client authentication style: `'header'` (HTTP Basic authentication per
   * RFC 6749 Section 2.3.1, default) or `'body'` (`client_id` and
   * `client_secret` form fields).
   */
  authStyle?: 'header' | 'body';
  /**
   * Proactive refresh margin in milliseconds before token expiration.
   * @defaultValue 5000
   */
  refreshMarginMillis?: number;
  /**
   * Timeout in milliseconds for token endpoint HTTP requests.
   * @defaultValue 10000
   */
  timeoutMillis?: number;
  /**
   * Optional custom `fetch` implementation (defaults to `globalThis.fetch`).
   */
  fetch?: typeof globalThis.fetch;
}

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAtMillis: number;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(
    clientSecret
  )}`;
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(credentials, 'utf8').toString('base64');
  }
  return btoa(credentials);
}

/**
 * OAuth 2.0 Client Credentials {@link Authenticator} implementation with
 * singleflight token acquisition, in-memory caching, proactive expiry refresh,
 * credential redaction, and idempotent shutdown.
 *
 * @experimental This feature is in development as per the OpenTelemetry specification and is subject to breaking changes in minor releases.
 */
export class OAuth2Authenticator implements Authenticator {
  private readonly _tokenUrl: string;
  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private readonly _scopes?: string[];
  private readonly _audience?: string;
  private readonly _authStyle: 'header' | 'body';
  private readonly _refreshMarginMillis: number;
  private readonly _timeoutMillis: number;
  private readonly _customFetch?: typeof globalThis.fetch;

  private _cachedToken?: CachedToken;
  private _inFlightRefresh?: Promise<CachedToken>;
  private _isShutdown = false;
  private _shutdownController = new AbortController();

  constructor(options: OAuth2AuthenticatorOptions) {
    if (options == null || typeof options !== 'object') {
      throw new Error('OAuth2Authenticator: options are required');
    }
    if (
      typeof options.tokenUrl !== 'string' ||
      options.tokenUrl.trim() === ''
    ) {
      throw new Error('OAuth2Authenticator: tokenUrl is required');
    }
    try {
      this._tokenUrl = new URL(options.tokenUrl).href;
    } catch {
      throw new Error(
        `OAuth2Authenticator: invalid tokenUrl '${options.tokenUrl}'`
      );
    }
    if (typeof options.clientId !== 'string' || options.clientId.length === 0) {
      throw new Error('OAuth2Authenticator: clientId is required');
    }
    if (
      typeof options.clientSecret !== 'string' ||
      options.clientSecret.length === 0
    ) {
      throw new Error('OAuth2Authenticator: clientSecret is required');
    }
    if (
      options.refreshMarginMillis !== undefined &&
      (typeof options.refreshMarginMillis !== 'number' ||
        options.refreshMarginMillis < 0 ||
        !Number.isFinite(options.refreshMarginMillis))
    ) {
      throw new Error(
        'OAuth2Authenticator: refreshMarginMillis must be a non-negative number'
      );
    }
    if (
      options.timeoutMillis !== undefined &&
      (typeof options.timeoutMillis !== 'number' ||
        options.timeoutMillis <= 0 ||
        !Number.isFinite(options.timeoutMillis))
    ) {
      throw new Error(
        'OAuth2Authenticator: timeoutMillis must be a positive number'
      );
    }
    if (
      options.authStyle !== undefined &&
      options.authStyle !== 'header' &&
      options.authStyle !== 'body'
    ) {
      throw new Error(
        "OAuth2Authenticator: authStyle must be 'header' or 'body'"
      );
    }

    this._clientId = options.clientId;
    this._clientSecret = options.clientSecret;
    this._scopes =
      options.scopes && options.scopes.length > 0
        ? [...options.scopes]
        : undefined;
    this._audience = options.audience;
    this._authStyle = options.authStyle ?? 'header';
    this._refreshMarginMillis =
      options.refreshMarginMillis ?? DEFAULT_REFRESH_MARGIN_MILLIS;
    this._timeoutMillis = options.timeoutMillis ?? DEFAULT_TOKEN_TIMEOUT_MILLIS;
    this._customFetch = options.fetch;
  }

  async getHeaders(): Promise<Record<string, string>> {
    if (this._isShutdown) {
      throw new Error('OAuth2Authenticator: authenticator has been shut down');
    }

    const now = Date.now();
    if (this._cachedToken != null && now < this._cachedToken.expiresAtMillis) {
      return {
        Authorization: `${this._cachedToken.tokenType} ${this._cachedToken.accessToken}`,
      };
    }

    this._inFlightRefresh ??= this._fetchToken().finally(() => {
      this._inFlightRefresh = undefined;
    });
    const token = await this._inFlightRefresh;
    return {
      Authorization: `${token.tokenType} ${token.accessToken}`,
    };
  }

  async shutdown(): Promise<void> {
    if (this._isShutdown) {
      return;
    }
    this._isShutdown = true;
    this._cachedToken = undefined;
    this._inFlightRefresh = undefined;
    this._shutdownController.abort();
  }

  private async _fetchToken(): Promise<CachedToken> {
    const fetchApi = this._customFetch ?? globalThis.fetch;
    if (typeof fetchApi !== 'function') {
      throw new Error('OAuth2Authenticator: globalThis.fetch is not available');
    }

    const bodyParams = new URLSearchParams();
    bodyParams.set('grant_type', 'client_credentials');
    if (this._scopes && this._scopes.length > 0) {
      bodyParams.set('scope', this._scopes.join(' '));
    }
    if (this._audience) {
      bodyParams.set('audience', this._audience);
    }

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    if (this._authStyle === 'body') {
      bodyParams.set('client_id', this._clientId);
      bodyParams.set('client_secret', this._clientSecret);
    } else {
      requestHeaders['Authorization'] =
        `Basic ${encodeBasicAuth(this._clientId, this._clientSecret)}`;
    }

    const requestController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let onShutdownAbort: (() => void) | undefined;

    const suppressedContext = suppressTracing(otelContext.active());

    let response: Response;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          requestController.abort();
          reject(
            new Error(
              `OAuth2Authenticator: token request timed out after ${this._timeoutMillis}ms`
            )
          );
        }, this._timeoutMillis);
      });

      const shutdownPromise = new Promise<never>((_, reject) => {
        onShutdownAbort = () => {
          requestController.abort();
          reject(
            new Error('OAuth2Authenticator: authenticator has been shut down')
          );
        };
        if (this._shutdownController.signal.aborted) {
          onShutdownAbort();
          return;
        }
        this._shutdownController.signal.addEventListener(
          'abort',
          onShutdownAbort,
          { once: true }
        );
      });

      const fetchPromise = otelContext.with(suppressedContext, () =>
        fetchApi(this._tokenUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: bodyParams.toString(),
          signal: requestController.signal,
        })
      );
      fetchPromise.catch(() => {});

      response = await Promise.race([
        fetchPromise,
        timeoutPromise,
        shutdownPromise,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      if (onShutdownAbort) {
        this._shutdownController.signal.removeEventListener(
          'abort',
          onShutdownAbort
        );
      }
    }

    if (response.status < 200 || response.status > 299) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // Ignore body read error.
      }
      const sanitizedBody = this._redactSecrets(bodyText).slice(0, 256).trim();
      const detail = sanitizedBody.length > 0 ? `: ${sanitizedBody}` : '';
      throw new Error(
        `OAuth2 token request failed with HTTP status ${response.status}${detail}`
      );
    }

    let payload: TokenEndpointResponse;
    try {
      payload = (await response.json()) as TokenEndpointResponse;
    } catch {
      throw new Error('OAuth2 token response was not valid JSON');
    }

    if (
      payload == null ||
      typeof payload !== 'object' ||
      typeof payload.access_token !== 'string' ||
      payload.access_token.length === 0
    ) {
      throw new Error(
        'OAuth2 token response missing required string field access_token'
      );
    }

    const rawTokenType =
      typeof payload.token_type === 'string' && payload.token_type.length > 0
        ? payload.token_type
        : 'Bearer';
    const tokenType =
      rawTokenType.toLowerCase() === 'bearer' ? 'Bearer' : rawTokenType;

    const now = Date.now();
    const parsedExpiresIn =
      typeof payload.expires_in === 'number'
        ? payload.expires_in
        : typeof payload.expires_in === 'string' &&
            payload.expires_in.trim() !== ''
          ? Number(payload.expires_in)
          : NaN;
    const expiresInSeconds = Number.isFinite(parsedExpiresIn)
      ? parsedExpiresIn
      : DEFAULT_FALLBACK_TTL_SECONDS;
    const ttlMillis = expiresInSeconds * 1000;

    let expiresAtMillis: number;
    if (ttlMillis <= 0) {
      expiresAtMillis = 0;
    } else if (ttlMillis > this._refreshMarginMillis) {
      expiresAtMillis = now + ttlMillis - this._refreshMarginMillis;
    } else {
      expiresAtMillis = now + Math.floor(ttlMillis / 2);
    }

    const cachedToken: CachedToken = {
      accessToken: payload.access_token,
      tokenType,
      expiresAtMillis,
    };

    if (!this._isShutdown && expiresAtMillis > now) {
      this._cachedToken = cachedToken;
    }

    return cachedToken;
  }

  private _redactSecrets(text: string): string {
    if (!text || !this._clientSecret) {
      return text;
    }
    const rawBasicCreds = `${this._clientId}:${this._clientSecret}`;
    const rawBasicBase64 =
      typeof Buffer !== 'undefined'
        ? Buffer.from(rawBasicCreds, 'utf8').toString('base64')
        : btoa(rawBasicCreds);
    const candidates = [
      this._clientSecret,
      encodeURIComponent(this._clientSecret),
      encodeBasicAuth(this._clientId, this._clientSecret),
      rawBasicBase64,
    ];
    let result = text;
    for (const secret of candidates) {
      if (secret.length > 0 && result.includes(secret)) {
        result = result.split(secret).join('[REDACTED]');
      }
    }
    return result;
  }
}
