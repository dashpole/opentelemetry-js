/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HeadersFactory } from './otlp-http-configuration';
import type { Authenticator } from '../authenticator';

/**
 * Configuration shared across all OTLP exporters
 *
 * Implementation note: anything added here MUST be
 * - platform-agnostic
 * - signal-agnostic
 * - transport-agnostic
 */
export interface OtlpSharedConfiguration {
  timeoutMillis: number;
  concurrencyLimit: number;
  compression: 'gzip' | 'none';
  /**
   * @experimental This feature is in development as per the OpenTelemetry specification and is subject to breaking changes in minor releases.
   */
  authenticator?: Authenticator;
}

export function validateTimeoutMillis(timeoutMillis: number) {
  if (Number.isFinite(timeoutMillis) && timeoutMillis > 0) {
    return timeoutMillis;
  }
  throw new Error(
    `Configuration: timeoutMillis is invalid, expected number greater than 0 (actual: '${timeoutMillis}')`
  );
}

export function wrapStaticHeadersInFunction(
  headers: Record<string, string> | undefined
): HeadersFactory | undefined {
  if (headers == null) {
    return undefined;
  }

  return async () => headers;
}

/**
 * @param userProvidedConfiguration  Configuration options provided by the user in code.
 * @param fallbackConfiguration Fallback to use when the {@link userProvidedConfiguration} does not specify an option.
 * @param defaultConfiguration The defaults as defined by the exporter specification
 */
export function mergeOtlpSharedConfigurationWithDefaults(
  userProvidedConfiguration: Partial<OtlpSharedConfiguration>,
  fallbackConfiguration: Partial<OtlpSharedConfiguration>,
  defaultConfiguration: OtlpSharedConfiguration
): OtlpSharedConfiguration {
  const authenticator =
    userProvidedConfiguration.authenticator ??
    fallbackConfiguration.authenticator ??
    defaultConfiguration.authenticator;

  return {
    timeoutMillis: validateTimeoutMillis(
      userProvidedConfiguration.timeoutMillis ??
        fallbackConfiguration.timeoutMillis ??
        defaultConfiguration.timeoutMillis
    ),
    concurrencyLimit:
      userProvidedConfiguration.concurrencyLimit ??
      fallbackConfiguration.concurrencyLimit ??
      defaultConfiguration.concurrencyLimit,
    compression:
      userProvidedConfiguration.compression ??
      fallbackConfiguration.compression ??
      defaultConfiguration.compression,
    ...(authenticator !== undefined ? { authenticator } : {}),
  };
}

export function getSharedConfigurationDefaults(): OtlpSharedConfiguration {
  return {
    timeoutMillis: 10000,
    concurrencyLimit: 30,
    compression: 'none',
  };
}
