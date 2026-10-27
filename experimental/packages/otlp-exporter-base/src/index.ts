/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

export { OTLPExporterBase } from './OTLPExporterBase';
export { OTLPExporterError } from './types';

export type {
  ExportResponse,
  ExportResponseFailure,
  ExportResponseSuccess,
  ExportResponseRetryable,
} from './export-response';

export type { IExporterTransport } from './exporter-transport';

export {
  mergeOtlpSharedConfigurationWithDefaults,
  getSharedConfigurationDefaults,
} from './configuration/shared-configuration';
export type { OtlpSharedConfiguration } from './configuration/shared-configuration';

export { CompressionAlgorithm } from './configuration/compression';
export type { OTLPExporterConfigBase } from './configuration/legacy-base-configuration';
export type { IOtlpExportDelegate } from './otlp-export-delegate';
export { createOtlpNetworkExportDelegate } from './otlp-network-export-delegate';

export { ExporterMetrics } from './ExporterMetrics';

export {
  mergeHeadersCaseInsensitive,
  resolveAuthenticatorHeaders,
} from './authenticator';
export type { Authenticator } from './authenticator';

export { OAuth2Authenticator } from './oauth2-authenticator';
export type { OAuth2AuthenticatorOptions } from './oauth2-authenticator';
