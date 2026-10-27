/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { context as otelContext, diag } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

/**
 * An SDK extension component responsible for acquiring, caching, refreshing,
 * and attaching dynamic client credentials (such as OAuth 2.0 bearer tokens,
 * cloud provider ambient credentials, or rotating API tokens) to outgoing
 * telemetry export requests.
 *
 * Expectations for {@link Authenticator} implementations:
 * 1. **Concurrency safety**: Must be safe for concurrent invocation across
 *    overlapping asynchronous export operations.
 * 2. **Non-blocking execution**: Authentication operations must not block
 *    indefinitely and should bound out-of-band credential requests with a timeout.
 * 3. **Credential redaction**: Must never log sensitive credential values or
 *    dynamic authentication header values in diagnostic (`diag`) output.
 *
 * @experimental This feature is in development as per the OpenTelemetry specification and is subject to breaking changes in minor releases.
 */
export interface Authenticator {
  /**
   * Returns dynamic HTTP headers or gRPC metadata key-value pairs to attach
   * to an outgoing export request.
   *
   * Invoked once per outgoing export request attempt (including retries).
   */
  getHeaders(): Promise<Record<string, string>> | Record<string, string>;

  /**
   * Optional idempotent lifecycle hook to release background resources
   * when the owning exporter shuts down.
   */
  shutdown?(): Promise<void> | void;
}

/**
 * Merges `overrideHeaders` into `baseHeaders` case-insensitively without
 * mutating `baseHeaders`. If both define the same header name (compared
 * case-insensitively), the entry from `overrideHeaders` replaces the colliding
 * entry from `baseHeaders` using the key casing from `overrideHeaders`.
 *
 * @internal
 */
export function mergeHeadersCaseInsensitive(
  baseHeaders: Record<string, string>,
  overrideHeaders?: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  const lowerKeyMap = new Map<string, string>();

  for (const [key, value] of Object.entries(baseHeaders)) {
    const lower = key.toLowerCase();
    const existingKey = lowerKeyMap.get(lower);
    if (existingKey !== undefined && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = value;
    lowerKeyMap.set(lower, key);
  }

  if (overrideHeaders != null) {
    for (const [key, value] of Object.entries(overrideHeaders)) {
      const lower = key.toLowerCase();
      const existingKey = lowerKeyMap.get(lower);
      if (existingKey !== undefined && existingKey !== key) {
        delete merged[existingKey];
      }
      merged[key] = value;
      lowerKeyMap.set(lower, key);
    }
  }

  return merged;
}

/**
 * Invokes {@link Authenticator.getHeaders} with tracing suppressed, validates
 * and normalizes returned headers without logging sensitive values, and merges
 * them case-insensitively over `staticHeaders`.
 *
 * @internal
 */
export async function resolveAuthenticatorHeaders(
  authenticator: Authenticator | undefined,
  staticHeaders: Record<string, string> = {}
): Promise<Record<string, string>> {
  if (authenticator == null) {
    return { ...staticHeaders };
  }

  const suppressedContext = suppressTracing(otelContext.active());
  const rawHeaders = await new Promise<Record<string, string>>(
    (resolve, reject) => {
      otelContext.with(suppressedContext, () => {
        try {
          resolve(authenticator.getHeaders());
        } catch (err) {
          reject(err);
        }
      });
    }
  );

  if (
    rawHeaders == null ||
    typeof rawHeaders !== 'object' ||
    Array.isArray(rawHeaders)
  ) {
    throw new Error(
      'Authenticator.getHeaders() must return a key-value header object'
    );
  }

  const normalizedAuthHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value !== undefined && value !== null) {
      normalizedAuthHeaders[key] = String(value);
    } else {
      diag.warn(
        `Authenticator header "${key}" has an undefined/null value and will be ignored`
      );
    }
  }

  return mergeHeadersCaseInsensitive(staticHeaders, normalizedAuthHeaders);
}
