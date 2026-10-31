/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

export { registerInstrumentations } from './autoLoader';
export { InstrumentationBase, InstrumentationNodeModuleFile } from '#platform';
export { InstrumentationNodeModuleDefinition } from './instrumentationNodeModuleDefinition';
export type {
  Instrumentation,
  InstrumentationConfig,
  InstrumentationModuleDefinition,
  InstrumentationModuleFile,
  ShimWrapped,
  SpanCustomizationHook,
} from './types';
export type { AutoLoaderOptions, AutoLoaderResult } from './types_internal';
export {
  isWrapped,
  safeExecuteInTheMiddle,
  safeExecuteInTheMiddleAsync,
} from './utils';
export { SemconvStability, semconvStabilityFromStr } from './semconvStability';
export {
  Stability,
  STABILITY_WRAPPER_SYMBOL,
  normalizeStability,
  isStabilityEnabled,
  stabilityFromString,
  createSuppressedSpan,
  extractTracerStability,
  extractLoggerStability,
  normalizeStabilityMetricOptions,
  wrapTracerWithStability,
  wrapLoggerWithStability,
  wrapMeterWithStability,
} from './stability';
export type {
  StabilitySpanOptions,
  StabilityTracerEnabledOptions,
  StabilityTracer,
  StabilityMetricAdvice,
  StabilityMetricOptions,
  StabilitySyncInstrument,
  StabilityCounter,
  StabilityUpDownCounter,
  StabilityGauge,
  StabilityHistogram,
  StabilityMeter,
  StabilityLogRecord,
  StabilityLoggerEnabledOptions,
  StabilityLogger,
} from './stability';
