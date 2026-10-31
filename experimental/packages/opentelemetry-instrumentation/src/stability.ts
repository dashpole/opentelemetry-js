/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Attributes,
  Context,
  Counter,
  Gauge,
  Histogram,
  Logger,
  LogRecord,
  Meter,
  MetricAdvice,
  MetricAttributes,
  MetricOptions,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  SeverityNumber,
  Span,
  SpanOptions,
  Tracer,
  UpDownCounter,
} from '@opentelemetry/api';
import {
  context as apiContext,
  createNoopMeter,
  INVALID_SPAN_CONTEXT,
  trace as apiTrace,
} from '@opentelemetry/api';

/**
 * Stability maturity level for telemetry signals (spans, metrics, log records)
 * and SDK provider minimumStability configuration, ordered by maturity
 * (`DEVELOPMENT < STABLE`).
 *
 * @experimental
 */
export enum Stability {
  /**
   * Experimental telemetry that MAY change or be removed in minor versions of
   * a 1.x instrumentation library; disabled by default when the SDK provider's
   * minimumStability is Stability.STABLE.
   */
  DEVELOPMENT = 0,
  /**
   * Telemetry covered by backward-compatibility guarantees; emitted by default
   * when not marked optIn.
   */
  STABLE = 1,
}

/**
 * Symbol marking a Tracer, Meter, or Logger that already implements
 * Stability-aware filtering at the SDK provider level.
 *
 * @internal
 */
export const STABILITY_WRAPPER_SYMBOL = Symbol.for(
  'opentelemetry.js.experimental.stability_wrapper'
);

/**
 * Normalize an optional Stability value, defaulting to Stability.STABLE.
 */
export function normalizeStability(stability?: Stability): Stability {
  return stability === Stability.DEVELOPMENT
    ? Stability.DEVELOPMENT
    : Stability.STABLE;
}

/**
 * Return true when `stability` (defaulting to Stability.STABLE) meets or
 * exceeds `minimumStability` (defaulting to Stability.STABLE).
 */
export function isStabilityEnabled(
  stability?: Stability,
  minimumStability?: Stability
): boolean {
  return normalizeStability(stability) >= normalizeStability(minimumStability);
}

/**
 * Parse a declarative configuration or string representation of stability
 * ('development' | 'stable') into a {@link Stability} enum value.
 */
export function stabilityFromString(value?: string | null): Stability {
  if (value == null || value === '') {
    return Stability.STABLE;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'development') {
    return Stability.DEVELOPMENT;
  }
  if (normalized === 'stable') {
    return Stability.STABLE;
  }
  throw new Error(
    `unknown minimum_stability value in configuration: "${value}"`
  );
}

/**
 * Extended SpanOptions accepting an optional `stability` parameter.
 *
 * @experimental
 */
export interface StabilitySpanOptions extends SpanOptions {
  /**
   * The stability level of the span (`Stability.STABLE` or
   * `Stability.DEVELOPMENT`), defaulting to `Stability.STABLE`.
   */
  stability?: Stability;
}

/**
 * Options for `StabilityTracer.enabled()`.
 *
 * @experimental
 */
export interface StabilityTracerEnabledOptions {
  context?: Context;
  stability?: Stability;
}

/**
 * Extended Tracer interface accepting `stability` on `startSpan`,
 * `startActiveSpan`, and `enabled`.
 *
 * @experimental
 */
export interface StabilityTracer extends Tracer {
  startSpan(
    name: string,
    options?: StabilitySpanOptions,
    context?: Context
  ): Span;

  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: StabilitySpanOptions,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: StabilitySpanOptions,
    context: Context,
    fn: F
  ): ReturnType<F>;

  enabled(options?: StabilityTracerEnabledOptions | Stability): boolean;
}

/**
 * Extended MetricAdvice accepting `optIn` and `stability` advisory parameters.
 *
 * @experimental
 */
export interface StabilityMetricAdvice extends MetricAdvice {
  /**
   * Whether the instrument is opt-in only (disabled by default unless
   * explicitly enabled by a matching View with `enabled: true`).
   * @default false
   */
  optIn?: boolean;
  /**
   * The stability maturity level of the instrument (`Stability.STABLE` or
   * `Stability.DEVELOPMENT`).
   * @default Stability.STABLE
   */
  stability?: Stability;
}

/**
 * Extended MetricOptions accepting `optIn` and `stability` (either at the top
 * level of options or nested under `advice`).
 *
 * @experimental
 */
export interface StabilityMetricOptions extends MetricOptions {
  advice?: StabilityMetricAdvice;
  /**
   * Advisory parameter indicating that this instrument is opt-in only
   * (disabled by default unless explicitly enabled by a View).
   * @default false
   */
  optIn?: boolean;
  /**
   * Advisory parameter indicating the stability maturity level of the
   * instrument (`Stability.STABLE` or `Stability.DEVELOPMENT`).
   * @default Stability.STABLE
   */
  stability?: Stability;
}

/**
 * Synchronous instrument extension providing `enabled()`.
 *
 * @experimental
 */
export interface StabilitySyncInstrument {
  enabled(options?: { context?: Context; attributes?: Attributes }): boolean;
}

export type StabilityCounter<
  AttributesTypes extends MetricAttributes = MetricAttributes,
> = Counter<AttributesTypes> & StabilitySyncInstrument;

export type StabilityUpDownCounter<
  AttributesTypes extends MetricAttributes = MetricAttributes,
> = UpDownCounter<AttributesTypes> & StabilitySyncInstrument;

export type StabilityGauge<
  AttributesTypes extends MetricAttributes = MetricAttributes,
> = Gauge<AttributesTypes> & StabilitySyncInstrument;

export type StabilityHistogram<
  AttributesTypes extends MetricAttributes = MetricAttributes,
> = Histogram<AttributesTypes> & StabilitySyncInstrument;

/**
 * Extended Meter interface accepting `StabilityMetricOptions` on all
 * synchronous and asynchronous instrument creation operations.
 *
 * @experimental
 */
export interface StabilityMeter extends Meter {
  createGauge<AttributesTypes extends MetricAttributes = MetricAttributes>(
    name: string,
    options?: StabilityMetricOptions
  ): StabilityGauge<AttributesTypes>;
  createHistogram<AttributesTypes extends MetricAttributes = MetricAttributes>(
    name: string,
    options?: StabilityMetricOptions
  ): StabilityHistogram<AttributesTypes>;
  createCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(
    name: string,
    options?: StabilityMetricOptions
  ): StabilityCounter<AttributesTypes>;
  createUpDownCounter<
    AttributesTypes extends MetricAttributes = MetricAttributes,
  >(
    name: string,
    options?: StabilityMetricOptions
  ): StabilityUpDownCounter<AttributesTypes>;
  createObservableGauge<
    AttributesTypes extends MetricAttributes = MetricAttributes,
  >(
    name: string,
    options?: StabilityMetricOptions
  ): ObservableGauge<AttributesTypes>;
  createObservableCounter<
    AttributesTypes extends MetricAttributes = MetricAttributes,
  >(
    name: string,
    options?: StabilityMetricOptions
  ): ObservableCounter<AttributesTypes>;
  createObservableUpDownCounter<
    AttributesTypes extends MetricAttributes = MetricAttributes,
  >(
    name: string,
    options?: StabilityMetricOptions
  ): ObservableUpDownCounter<AttributesTypes>;
}

/**
 * Extended LogRecord accepting an optional `stability` parameter.
 *
 * @experimental
 */
export interface StabilityLogRecord extends LogRecord {
  /**
   * The stability level of the log record (`Stability.STABLE` or
   * `Stability.DEVELOPMENT`), defaulting to `Stability.STABLE`.
   */
  stability?: Stability;
}

/**
 * Options for `StabilityLogger.enabled()`.
 *
 * @experimental
 */
export interface StabilityLoggerEnabledOptions {
  context?: Context;
  severityNumber?: SeverityNumber;
  eventName?: string;
  stability?: Stability;
}

/**
 * Extended Logger interface accepting `stability` on `emit` and `enabled`.
 *
 * @experimental
 */
export interface StabilityLogger extends Logger {
  emit(logRecord: StabilityLogRecord): void;
  enabled(options?: StabilityLoggerEnabledOptions | Stability): boolean;
}

/**
 * Create a non-recording Span wrapping the parent SpanContext from `ctx`
 * unchanged (or `INVALID_SPAN_CONTEXT` if `ctx` contains no valid Span or
 * `root` is true), matching the OpenTelemetry No-op Tracer behavior.
 */
export function createSuppressedSpan(
  options?: StabilitySpanOptions,
  ctx: Context = apiContext.active()
): Span {
  const effectiveContext = options?.root ? apiTrace.deleteSpan(ctx) : ctx;
  const parentSpanContext = apiTrace.getSpanContext(effectiveContext);
  if (parentSpanContext && apiTrace.isSpanContextValid(parentSpanContext)) {
    return apiTrace.wrapSpanContext(parentSpanContext);
  }
  return apiTrace.wrapSpanContext(INVALID_SPAN_CONTEXT);
}

/**
 * Extract the `Stability` parameter from `StabilityTracerEnabledOptions | Stability`.
 */
export function extractTracerStability(
  options?: StabilityTracerEnabledOptions | Stability
): Stability {
  if (typeof options === 'number') {
    return normalizeStability(options);
  }
  return normalizeStability(options?.stability);
}

/**
 * Extract the `Stability` parameter from `StabilityLoggerEnabledOptions | Stability`.
 */
export function extractLoggerStability(
  options?: StabilityLoggerEnabledOptions | Stability
): Stability {
  if (typeof options === 'number') {
    return normalizeStability(options);
  }
  return normalizeStability(options?.stability);
}

interface MaybeProxyTracer {
  _getTracer?: () => Tracer;
  [STABILITY_WRAPPER_SYMBOL]?: boolean;
  enabled?: (options?: StabilityTracerEnabledOptions | Stability) => boolean;
}

/**
 * Wrap any {@link Tracer} (including a `ProxyTracer` or a plain SDK `Tracer`)
 * into a {@link StabilityTracer}. If the underlying resolved tracer was
 * produced by a `StabilityTracerProvider`, calls delegate directly to it so
 * its configured `minimumStability` is honored; otherwise, the default
 * `minimumStability = Stability.STABLE` is enforced.
 */
export function wrapTracerWithStability(
  tracer: Tracer,
  minimumStability: Stability = Stability.STABLE,
  hasSpanProcessors: () => boolean = () => true
): StabilityTracer {
  if ((tracer as unknown as MaybeProxyTracer)[STABILITY_WRAPPER_SYMBOL]) {
    return tracer as StabilityTracer;
  }

  const resolveDelegate = (): Tracer & MaybeProxyTracer => {
    const maybeProxy = tracer as unknown as MaybeProxyTracer;
    if (typeof maybeProxy._getTracer === 'function') {
      return maybeProxy._getTracer.call(tracer) as Tracer & MaybeProxyTracer;
    }
    return tracer as Tracer & MaybeProxyTracer;
  };

  const wrapped: StabilityTracer & { [STABILITY_WRAPPER_SYMBOL]: boolean } = {
    [STABILITY_WRAPPER_SYMBOL]: true,

    enabled(options?: StabilityTracerEnabledOptions | Stability): boolean {
      const delegate = resolveDelegate();
      if (delegate !== tracer && delegate[STABILITY_WRAPPER_SYMBOL]) {
        return delegate.enabled!(options);
      }
      if (!hasSpanProcessors()) {
        return false;
      }
      const stability = extractTracerStability(options);
      if (!isStabilityEnabled(stability, minimumStability)) {
        return false;
      }
      if (typeof delegate.enabled === 'function') {
        const arg = typeof options === 'number' ? { stability: options } : options;
        return delegate.enabled(arg);
      }
      // If delegate is NoopTracer (no _spanProcessor), return false
      if (
        delegate.constructor?.name === 'NoopTracer' ||
        (!('_spanProcessor' in delegate) && !hasSpanProcessors())
      ) {
        return false;
      }
      return true;
    },

    startSpan(
      name: string,
      options: StabilitySpanOptions = {},
      context: Context = apiContext.active()
    ): Span {
      const delegate = resolveDelegate();
      if (delegate !== tracer && delegate[STABILITY_WRAPPER_SYMBOL]) {
        return (delegate as StabilityTracer).startSpan(name, options, context);
      }
      if (!isStabilityEnabled(options?.stability, minimumStability)) {
        return createSuppressedSpan(options, context);
      }
      return delegate.startSpan(name, options, context);
    },

    startActiveSpan<F extends (span: Span) => unknown>(
      name: string,
      arg2?: F | StabilitySpanOptions,
      arg3?: F | Context,
      arg4?: F
    ): ReturnType<F> {
      let opts: StabilitySpanOptions | undefined;
      let ctx: Context | undefined;
      let fn: F;

      if (arguments.length < 2) {
        return undefined as ReturnType<F>;
      } else if (arguments.length === 2) {
        fn = arg2 as F;
      } else if (arguments.length === 3) {
        opts = arg2 as StabilitySpanOptions | undefined;
        fn = arg3 as F;
      } else {
        opts = arg2 as StabilitySpanOptions | undefined;
        ctx = arg3 as Context | undefined;
        fn = arg4 as F;
      }

      const parentContext = ctx ?? apiContext.active();
      const span = wrapped.startSpan(name, opts, parentContext);
      const contextWithSpanSet = apiTrace.setSpan(parentContext, span);

      return apiContext.with(
        contextWithSpanSet,
        fn as (span: Span) => ReturnType<F>,
        undefined,
        span
      );
    },
  };

  return wrapped;
}

interface MaybeProxyLogger {
  _getLogger?: () => Logger;
  [STABILITY_WRAPPER_SYMBOL]?: boolean;
}

/**
 * Wrap any {@link Logger} into a {@link StabilityLogger}.
 */
export function wrapLoggerWithStability(
  logger: Logger,
  minimumStability: Stability = Stability.STABLE
): StabilityLogger {
  if ((logger as unknown as MaybeProxyLogger)[STABILITY_WRAPPER_SYMBOL]) {
    return logger as StabilityLogger;
  }

  const resolveDelegate = (): Logger & MaybeProxyLogger => {
    const maybeProxy = logger as unknown as MaybeProxyLogger;
    if (typeof maybeProxy._getLogger === 'function') {
      return maybeProxy._getLogger.call(logger) as Logger & MaybeProxyLogger;
    }
    return logger as Logger & MaybeProxyLogger;
  };

  const wrapped: StabilityLogger & { [STABILITY_WRAPPER_SYMBOL]: boolean } = {
    [STABILITY_WRAPPER_SYMBOL]: true,

    enabled(options?: StabilityLoggerEnabledOptions | Stability): boolean {
      const delegate = resolveDelegate();
      if (delegate !== logger && delegate[STABILITY_WRAPPER_SYMBOL]) {
        return (delegate as StabilityLogger).enabled(options);
      }
      const stability = extractLoggerStability(options);
      if (!isStabilityEnabled(stability, minimumStability)) {
        return false;
      }
      const delegateOpts =
        typeof options === 'number' ? undefined : options;
      return delegate.enabled(delegateOpts);
    },

    emit(logRecord: StabilityLogRecord): void {
      const delegate = resolveDelegate();
      if (delegate !== logger && delegate[STABILITY_WRAPPER_SYMBOL]) {
        (delegate as StabilityLogger).emit(logRecord);
        return;
      }
      if (!isStabilityEnabled(logRecord.stability, minimumStability)) {
        return;
      }
      delegate.emit(logRecord);
    },
  };

  return wrapped;
}

interface MaybeStabilityMeter {
  [STABILITY_WRAPPER_SYMBOL]?: boolean;
}

const NOOP_METER = createNoopMeter();

function attachSyncEnabled<T extends object>(
  instrument: T,
  enabledValue: boolean
): T & StabilitySyncInstrument {
  const target = instrument as T & Partial<StabilitySyncInstrument>;
  if (typeof target.enabled === 'function') {
    return target as T & StabilitySyncInstrument;
  }
  const wrapper = Object.create(instrument) as T & StabilitySyncInstrument;
  Object.defineProperty(wrapper, 'enabled', {
    value: () => enabledValue,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return wrapper;
}

/**
 * Normalize `StabilityMetricOptions` so `optIn` and `stability` are always
 * present on `options.advice` for downstream SDK inspection.
 */
export function normalizeStabilityMetricOptions(
  options?: StabilityMetricOptions
): StabilityMetricOptions {
  const optIn = Boolean(options?.optIn ?? options?.advice?.optIn ?? false);
  const stability = normalizeStability(
    options?.stability ?? options?.advice?.stability
  );
  return {
    ...options,
    optIn,
    stability,
    advice: {
      ...options?.advice,
      optIn,
      stability,
    },
  };
}

/**
 * Wrap any {@link Meter} into a {@link StabilityMeter}. If the underlying
 * Meter was created by `StabilityMeterProvider`, it handles View `enabled`
 * overrides natively; otherwise default `minimumStability` and `optIn` rules
 * are applied.
 */
export function wrapMeterWithStability(
  meter: Meter,
  minimumStability: Stability = Stability.STABLE
): StabilityMeter {
  if ((meter as unknown as MaybeStabilityMeter)[STABILITY_WRAPPER_SYMBOL]) {
    return meter as StabilityMeter;
  }

  const isOptionEnabled = (normalized: StabilityMetricOptions): boolean => {
    if (normalized.optIn) {
      return false;
    }
    return isStabilityEnabled(normalized.stability, minimumStability);
  };

  const wrapped: StabilityMeter & { [STABILITY_WRAPPER_SYMBOL]: boolean } = {
    [STABILITY_WRAPPER_SYMBOL]: true,

    createGauge<AttributesTypes extends MetricAttributes = MetricAttributes>(
      name: string,
      options?: StabilityMetricOptions
    ): StabilityGauge<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return attachSyncEnabled(
        targetMeter.createGauge<AttributesTypes>(name, normalized),
        enabled
      );
    },

    createHistogram<
      AttributesTypes extends MetricAttributes = MetricAttributes,
    >(
      name: string,
      options?: StabilityMetricOptions
    ): StabilityHistogram<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return attachSyncEnabled(
        targetMeter.createHistogram<AttributesTypes>(name, normalized),
        enabled
      );
    },

    createCounter<AttributesTypes extends MetricAttributes = MetricAttributes>(
      name: string,
      options?: StabilityMetricOptions
    ): StabilityCounter<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return attachSyncEnabled(
        targetMeter.createCounter<AttributesTypes>(name, normalized),
        enabled
      );
    },

    createUpDownCounter<
      AttributesTypes extends MetricAttributes = MetricAttributes,
    >(
      name: string,
      options?: StabilityMetricOptions
    ): StabilityUpDownCounter<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return attachSyncEnabled(
        targetMeter.createUpDownCounter<AttributesTypes>(name, normalized),
        enabled
      );
    },

    createObservableGauge<
      AttributesTypes extends MetricAttributes = MetricAttributes,
    >(
      name: string,
      options?: StabilityMetricOptions
    ): ObservableGauge<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return targetMeter.createObservableGauge<AttributesTypes>(
        name,
        normalized
      );
    },

    createObservableCounter<
      AttributesTypes extends MetricAttributes = MetricAttributes,
    >(
      name: string,
      options?: StabilityMetricOptions
    ): ObservableCounter<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return targetMeter.createObservableCounter<AttributesTypes>(
        name,
        normalized
      );
    },

    createObservableUpDownCounter<
      AttributesTypes extends MetricAttributes = MetricAttributes,
    >(
      name: string,
      options?: StabilityMetricOptions
    ): ObservableUpDownCounter<AttributesTypes> {
      const normalized = normalizeStabilityMetricOptions(options);
      const enabled = isOptionEnabled(normalized);
      const targetMeter = enabled ? meter : NOOP_METER;
      return targetMeter.createObservableUpDownCounter<AttributesTypes>(
        name,
        normalized
      );
    },

    addBatchObservableCallback: meter.addBatchObservableCallback.bind(meter),
    removeBatchObservableCallback:
      meter.removeBatchObservableCallback.bind(meter),
  };

  return wrapped;
}
