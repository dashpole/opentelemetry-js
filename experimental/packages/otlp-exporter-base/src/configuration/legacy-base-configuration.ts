/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { MeterProvider } from '@opentelemetry/api';
import type { HeadersFactory } from './otlp-http-configuration';
import type { Authenticator } from '../authenticator';

export interface OTLPExporterConfigBase {
  /**
   * Custom headers that will be attached to the HTTP request that's sent to the endpoint.
   *
   * @remarks
   * Prefer using a plain object over a factory function wherever possible.
   * A factory function may be async and MUST NOT throw errors.
   * It should return a string map containing the headers to add to the request.
   *
   * @example <caption> Using headers options directly: </caption>
   * headers: {
   *  Authorization: "Api-Token my-secret-token",
   * }
   *
   * @example <caption> Using a custom factory function </caption>
   * headers: async () => {
   *   return {
   *     Authorization: `Bearer ${token}`,
   *   };
   * };
   */
  headers?: Record<string, string> | HeadersFactory;
  /**
   * Authenticator responsible for dynamically acquiring, caching, refreshing,
   * and attaching client credentials to each outgoing export request.
   *
   * @remarks
   * Headers returned by `authenticator` are resolved per outgoing export request
   * (including retries) and take case-insensitive precedence over colliding
   * static `headers` without mutating the configured static `headers`.
   *
   * Implementations of {@link Authenticator} must adhere to:
   * 1. **Concurrency safety**: Safe for concurrent invocation across overlapping exports.
   * 2. **Non-blocking execution**: Authentication operations must not block indefinitely.
   * 3. **Credential redaction**: Never log sensitive credentials or dynamic header values.
   *
   * @experimental This feature is in development as per the OpenTelemetry specification and is subject to breaking changes in minor releases.
   */
  authenticator?: Authenticator;
  /**
   * Collector endpoint URL for the exporter.
   *
   * @remarks
   * Defaults to the signal-specific endpoint, such as
   * `http://localhost:4318/v1/traces`, `http://localhost:4318/v1/metrics`,
   * or `http://localhost:4318/v1/logs`.
   */
  url?: string;
  /**
   * Maximum number of in-flight export requests.
   *
   * @defaultValue 30
   */
  concurrencyLimit?: number;
  /**
   * Maximum time, in milliseconds, the OTLP exporter will wait for each batch export.
   *
   * @defaultValue 10000
   */
  timeoutMillis?: number;

  /**
   * MeterProvider to record metrics for the exporter itself.
   * @experimental This option is experimental and is subject to breaking changes in minor releases.
   */
  selfObsMeterProvider?: MeterProvider;
}
