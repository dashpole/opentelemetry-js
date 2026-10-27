/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

export { convertLegacyOtlpGrpcOptions } from './configuration/convert-legacy-otlp-grpc-options';
export {
  createOtlpGrpcExportDelegate,
  createOtlpGrpcExporterMetrics,
} from './otlp-grpc-export-delegate';
export {
  createEmptyMetadata,
  createInsecureCredentials,
  createSslCredentials,
} from './grpc-exporter-transport';
export type { OTLPGRPCExporterConfigNode } from './types';
export { OAuth2Authenticator } from '@opentelemetry/otlp-exporter-base';
export type {
  Authenticator,
  OAuth2AuthenticatorOptions,
} from '@opentelemetry/otlp-exporter-base';
