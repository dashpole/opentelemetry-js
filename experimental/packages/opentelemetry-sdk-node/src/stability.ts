/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Context,
  LoggerOptions as ApiLoggerOptions,
  MeterOptions as ApiMeterOptions,
  MetricAttributes,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  Span,
} from '@opentelemetry/api';
import {
  context as apiContext,
  createNoopLogger,
  createNoopMeter,
  diag,
  trace as apiTrace,
} from '@opentelemetry/api';
import type { InstrumentationScope } from '@opentelemetry/core';
import { isTracingSuppressed } from '@opentelemetry/core';
import type {
  StabilityCounter,
  StabilityGauge,
  StabilityHistogram,
  StabilityLogger,
  StabilityLoggerEnabledOptions,
  StabilityLogRecord,
  StabilityMeter,
  StabilityMetricAdvice,
  StabilityMetricOptions,
  StabilitySpanOptions,
  StabilitySyncInstrument,
  StabilityTracer,
  StabilityTracerEnabledOptions,
  StabilityUpDownCounter,
} from '@opentelemetry/instrumentation';
import {
  createSuppressedSpan,
  extractLoggerStability,
  extractTracerStability,
  isStabilityEnabled,
  normalizeStability,
  normalizeStabilityMetricOptions,
  Stability,
  STABILITY_WRAPPER_SYMBOL,
  stabilityFromString,
  wrapLoggerWithStability,
  wrapMeterWithStability,
  wrapTracerWithStability,
} from '@opentelemetry/instrumentation';
import type { LoggerProviderOptions } from '@opentelemetry/sdk-logs';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import type {
  InstrumentType,
  MeterProviderOptions,
  MetricDescriptor,
  ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { AggregationType, MeterProvider } from '@opentelemetry/sdk-metrics';
import type { TracerProviderOptions } from '@opentelemetry/sdk-trace';
import { TracerProvider } from '@opentelemetry/sdk-trace';

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
};
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
};

/**
 * Extended TracerProviderOptions accepting `minimumStability`.
 *
 * @experimental
 */
export interface StabilityTracerProviderOptions extends TracerProviderOptions {
  /**
   * Minimum stability level of spans that are recorded by this TracerProvider.
   * Spans with a stability lower than `minimumStability` behave as a No-op
   * Tracer (returning a non-recording span wrapping the parent SpanContext).
   * @default Stability.STABLE
   */
  minimumStability?: Stability;
}

/**
 * TracerProvider supporting `minimumStability` and returning `StabilityTracer`
 * instances that support `stability` on `startSpan`, `startActiveSpan`, and
 * `enabled`.
 *
 * @experimental
 */
export class StabilityTracerProvider extends TracerProvider {
  public readonly minimumStability: Stability;
  private readonly _hasSpanProcessors: boolean;

  constructor(options: StabilityTracerProviderOptions = {}) {
    super(options);
    this.minimumStability = normalizeStability(options.minimumStability);
    this._hasSpanProcessors = (options.spanProcessors?.length ?? 0) > 0;
  }

  override getTracer(
    name: string,
    version?: string,
    options?: { schemaUrl?: string }
  ): StabilityTracer {
    const baseTracer = super.getTracer(
      name,
      version,
      options
    ) as StabilityTracer & {
      [STABILITY_WRAPPER_SYMBOL]?: boolean;
    };
    if (!baseTracer[STABILITY_WRAPPER_SYMBOL]) {
      const origStartSpan = baseTracer.startSpan.bind(baseTracer);

      baseTracer[STABILITY_WRAPPER_SYMBOL] = true;

      baseTracer.enabled = (
        enabledOptions?: StabilityTracerEnabledOptions | Stability
      ): boolean => {
        if (!this._hasSpanProcessors) {
          return false;
        }
        const ctx =
          (typeof enabledOptions === 'object'
            ? enabledOptions?.context
            : undefined) ?? apiContext.active();
        if (isTracingSuppressed(ctx)) {
          return false;
        }
        const stability = extractTracerStability(enabledOptions);
        return isStabilityEnabled(
          stability,
          this.minimumStability ?? Stability.STABLE
        );
      };

      baseTracer.startSpan = (
        spanName: string,
        spanOptions: StabilitySpanOptions = {},
        context: Context = apiContext.active()
      ): Span => {
        if (
          !isStabilityEnabled(
            spanOptions?.stability,
            this.minimumStability ?? Stability.STABLE
          )
        ) {
          return createSuppressedSpan(spanOptions, context);
        }
        return origStartSpan(spanName, spanOptions, context);
      };

      baseTracer.startActiveSpan = function startActiveSpan<
        F extends (span: Span) => unknown,
      >(
        spanName: string,
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
        const span = baseTracer.startSpan(spanName, opts, parentContext);
        const contextWithSpanSet = apiTrace.setSpan(parentContext, span);

        return apiContext.with(
          contextWithSpanSet,
          fn as (span: Span) => ReturnType<F>,
          undefined,
          span
        );
      };
    }
    return baseTracer;
  }
}

/**
 * Extended ViewOptions accepting `enabled`.
 *
 * @experimental
 */
export interface StabilityViewOptions extends ViewOptions {
  /**
   * Whether the metric stream is enabled:
   * - `true`: enables the stream regardless of the instrument's `optIn` or
   *   `stability` advisory parameters (and `MeterProvider` `minimumStability`).
   * - `false`: applies the Drop Aggregation regardless of `aggregation`.
   * - `undefined`: the instrument's `optIn` and `stability` advisory
   *   parameters (together with `MeterProvider` `minimumStability`) determine
   *   whether the stream is enabled.
   */
  enabled?: boolean;
}

/**
 * Extended MeterProviderOptions accepting `minimumStability` and
 * `StabilityViewOptions`.
 *
 * @experimental
 */
export interface StabilityMeterProviderOptions
  extends Omit<MeterProviderOptions, 'views'> {
  views?: StabilityViewOptions[];
  /**
   * Minimum stability level of instruments enabled by default when no matching
   * View explicitly sets `enabled`.
   * @default Stability.STABLE
   */
  minimumStability?: Stability;
}

interface InternalInstrumentDescriptor extends MetricDescriptor {
  readonly type: InstrumentType;
  readonly advice: StabilityMetricAdvice;
}

interface InternalView {
  name?: string;
  description?: string;
  aggregation: {
    createAggregator(descriptor: InternalInstrumentDescriptor): {
      kind: number;
    };
  };
  attributesProcessor: unknown;
  instrumentSelector: unknown;
  meterSelector: unknown;
  aggregationCardinalityLimit?: number;
  _enabled?: boolean;
  _isExplicitDrop?: boolean;
}

interface InternalViewRegistry {
  _registeredViews: InternalView[];
  findViews(
    instrument: InternalInstrumentDescriptor,
    meter: InstrumentationScope
  ): InternalView[];
}

interface InternalMeterProviderSharedState {
  viewRegistry: InternalViewRegistry;
  selectAggregations(
    instrumentType: InstrumentType
  ): [unknown, { createAggregator(d: InternalInstrumentDescriptor): { kind: number } }][];
}

function attachSyncEnabledFn<T extends object>(
  instrument: T,
  isEnabledFn: () => boolean
): T & StabilitySyncInstrument {
  Object.defineProperty(instrument, 'enabled', {
    value: () => isEnabledFn(),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return instrument as T & StabilitySyncInstrument;
}

/**
 * MeterProvider supporting `minimumStability`, instrument `stability` and
 * `optIn` advisory parameters, and `View` `enabled` overrides.
 *
 * @experimental
 */
export class StabilityMeterProvider extends MeterProvider {
  public readonly minimumStability: Stability;
  private readonly _hasReaders: boolean;
  private readonly _dropAggregation: InternalView['aggregation'];

  constructor(options?: StabilityMeterProviderOptions) {
    const normalizedViews: ViewOptions[] | undefined = options?.views?.map(
      v => {
        if (v.enabled === false) {
          return {
            ...v,
            aggregation: { type: AggregationType.DROP },
          };
        }
        return v;
      }
    );

    super({
      ...options,
      views: normalizedViews,
    });

    this.minimumStability = normalizeStability(options?.minimumStability);
    this._hasReaders = (options?.readers?.length ?? 0) > 0;

    // Obtain a DropAggregation instance using a temporary MeterProvider view
    // or directly from registered views if any, without importing internal
    // unexported sdk-metrics modules.
    const tempProvider = new MeterProvider({
      views: [
        {
          instrumentName: '__drop__',
          aggregation: { type: AggregationType.DROP },
        },
      ],
    });
    const tempSharedState = (
      tempProvider as unknown as {
        _sharedState: InternalMeterProviderSharedState;
      }
    )._sharedState;
    this._dropAggregation =
      tempSharedState.viewRegistry._registeredViews[0].aggregation;

    const sharedState = (
      this as unknown as { _sharedState: InternalMeterProviderSharedState }
    )._sharedState;
    const viewRegistry = sharedState.viewRegistry;

    // Attach `_enabled` and `_isExplicitDrop` metadata onto each registered View
    if (options?.views) {
      for (let i = 0; i < options.views.length; i++) {
        const viewOpt = options.views[i];
        const registeredView = viewRegistry._registeredViews[i];
        if (registeredView) {
          registeredView._enabled = viewOpt.enabled;
          registeredView._isExplicitDrop =
            viewOpt.enabled === false ||
            viewOpt.aggregation?.type === AggregationType.DROP;
        }
      }
    }

    const originalFindViews = viewRegistry.findViews.bind(viewRegistry);
    const minimumStability = this.minimumStability;
    const dropAggregation = this._dropAggregation;

    viewRegistry.findViews = (
      descriptor: InternalInstrumentDescriptor,
      meterScope: InstrumentationScope
    ): InternalView[] => {
      const matchedViews = originalFindViews(descriptor, meterScope);
      const isOptIn = Boolean(descriptor.advice?.optIn ?? false);
      const stability = normalizeStability(descriptor.advice?.stability);
      const enabledByDefault =
        !isOptIn && isStabilityEnabled(stability, minimumStability);

      if (matchedViews.length > 0) {
        const enabledViews: InternalView[] = [];
        for (const view of matchedViews) {
          if (view._isExplicitDrop || view._enabled === false) {
            continue;
          }
          if (view._enabled === true || enabledByDefault) {
            enabledViews.push(view);
          }
        }
        if (enabledViews.length > 0) {
          return enabledViews;
        }
        // All matching views drop this instrument (either via enabled: false,
        // AggregationType.DROP, or enabled: undefined with optIn/Development).
        const firstView = matchedViews[0];
        return [
          {
            ...firstView,
            name: undefined,
            aggregation: dropAggregation,
            _enabled: false,
            _isExplicitDrop: true,
          },
        ];
      }

      // No Views matched the instrument.
      if (enabledByDefault) {
        return [];
      }

      // Instrument is disabled by default (optIn=true or stability < minimumStability)
      // and no View matched it: apply Drop Aggregation.
      const templateView = tempSharedState.viewRegistry._registeredViews[0];
      return [
        {
          ...templateView,
          name: undefined,
          description: undefined,
          aggregation: dropAggregation,
          _enabled: false,
          _isExplicitDrop: true,
        },
      ];
    };
  }

  private _isInstrumentEnabled(
    descriptor: InternalInstrumentDescriptor,
    meterScope: InstrumentationScope
  ): boolean {
    const isShutdown = Boolean(
      (this as unknown as { _shutdown?: boolean })._shutdown
    );
    if (isShutdown || !this._hasReaders) {
      return false;
    }
    const sharedState = (
      this as unknown as { _sharedState: InternalMeterProviderSharedState }
    )._sharedState;
    const resolvedViews = sharedState.viewRegistry.findViews(
      descriptor,
      meterScope
    );
    if (resolvedViews.length > 0) {
      return resolvedViews.some(v => !v._isExplicitDrop && v._enabled !== false);
    }
    // No views returned means enabledByDefault is true; check if any reader
    // selects a non-drop aggregation for this instrument type.
    const perCollector = sharedState.selectAggregations(descriptor.type);
    return perCollector.some(([, agg]) => {
      const aggregator = agg.createAggregator(descriptor);
      return aggregator.kind !== 0; // AggregatorKind.DROP === 0
    });
  }

  override getMeter(
    name: string,
    version = '',
    options: ApiMeterOptions = {}
  ): StabilityMeter {
    const isShutdown = Boolean(
      (this as unknown as { _shutdown?: boolean })._shutdown
    );
    if (isShutdown) {
      diag.warn('A shutdown MeterProvider cannot provide a Meter');
      return wrapMeterWithStability(
        createNoopMeter(),
        this.minimumStability ?? Stability.STABLE
      );
    }

    const baseMeter = super.getMeter(
      name,
      version,
      options
    ) as StabilityMeter & {
      [STABILITY_WRAPPER_SYMBOL]?: boolean;
    };
    if (!baseMeter[STABILITY_WRAPPER_SYMBOL]) {
      const meterScope: InstrumentationScope = {
        name: name || '',
        version,
        schemaUrl: options.schemaUrl,
      };

      const checkEnabled = (
        instrumentName: string,
        instrumentType: InstrumentType,
        normalizedOpts: StabilityMetricOptions
      ): boolean => {
        const descriptor: InternalInstrumentDescriptor = {
          name: instrumentName,
          type: instrumentType,
          description: normalizedOpts.description ?? '',
          unit: normalizedOpts.unit ?? '',
          valueType: normalizedOpts.valueType ?? 1,
          advice: normalizedOpts.advice ?? {},
        };
        return this._isInstrumentEnabled(descriptor, meterScope);
      };

      const origCreateGauge = baseMeter.createGauge.bind(baseMeter);
      const origCreateHistogram = baseMeter.createHistogram.bind(baseMeter);
      const origCreateCounter = baseMeter.createCounter.bind(baseMeter);
      const origCreateUpDownCounter =
        baseMeter.createUpDownCounter.bind(baseMeter);
      const origCreateObservableGauge =
        baseMeter.createObservableGauge.bind(baseMeter);
      const origCreateObservableCounter =
        baseMeter.createObservableCounter.bind(baseMeter);
      const origCreateObservableUpDownCounter =
        baseMeter.createObservableUpDownCounter.bind(baseMeter);

      baseMeter[STABILITY_WRAPPER_SYMBOL] = true;

      baseMeter.createGauge = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): StabilityGauge<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        const inst = origCreateGauge<AttributesTypes>(
          instrumentName,
          normalized
        );
        return attachSyncEnabledFn(inst, () =>
          checkEnabled(instrumentName, 'GAUGE' as InstrumentType, normalized)
        );
      };

      baseMeter.createHistogram = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): StabilityHistogram<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        const inst = origCreateHistogram<AttributesTypes>(
          instrumentName,
          normalized
        );
        return attachSyncEnabledFn(inst, () =>
          checkEnabled(
            instrumentName,
            'HISTOGRAM' as InstrumentType,
            normalized
          )
        );
      };

      baseMeter.createCounter = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): StabilityCounter<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        const inst = origCreateCounter<AttributesTypes>(
          instrumentName,
          normalized
        );
        return attachSyncEnabledFn(inst, () =>
          checkEnabled(instrumentName, 'COUNTER' as InstrumentType, normalized)
        );
      };

      baseMeter.createUpDownCounter = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): StabilityUpDownCounter<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        const inst = origCreateUpDownCounter<AttributesTypes>(
          instrumentName,
          normalized
        );
        return attachSyncEnabledFn(inst, () =>
          checkEnabled(
            instrumentName,
            'UP_DOWN_COUNTER' as InstrumentType,
            normalized
          )
        );
      };

      baseMeter.createObservableGauge = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): ObservableGauge<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        return origCreateObservableGauge<AttributesTypes>(
          instrumentName,
          normalized
        );
      };

      baseMeter.createObservableCounter = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): ObservableCounter<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        return origCreateObservableCounter<AttributesTypes>(
          instrumentName,
          normalized
        );
      };

      baseMeter.createObservableUpDownCounter = <
        AttributesTypes extends MetricAttributes = MetricAttributes,
      >(
        instrumentName: string,
        metricOptions?: StabilityMetricOptions
      ): ObservableUpDownCounter<AttributesTypes> => {
        const normalized = normalizeStabilityMetricOptions(metricOptions);
        return origCreateObservableUpDownCounter<AttributesTypes>(
          instrumentName,
          normalized
        );
      };
    }
    return baseMeter;
  }
}

/**
 * Extended LoggerProviderOptions accepting `minimumStability`.
 *
 * @experimental
 */
export interface StabilityLoggerProviderOptions extends LoggerProviderOptions {
  /**
   * Minimum stability level of log records processed by this LoggerProvider.
   * Log records with a stability lower than `minimumStability` are dropped
   * before invoking any LogRecordProcessor.
   * @default Stability.STABLE
   */
  minimumStability?: Stability;
}

/**
 * LoggerProvider supporting `minimumStability` and returning `StabilityLogger`
 * instances that support `stability` on `emit` and `enabled`.
 *
 * @experimental
 */
export class StabilityLoggerProvider extends LoggerProvider {
  public readonly minimumStability: Stability;

  constructor(config: StabilityLoggerProviderOptions = {}) {
    super(config);
    this.minimumStability = normalizeStability(config.minimumStability);
  }

  override getLogger(
    name: string,
    version?: string,
    options?: ApiLoggerOptions
  ): StabilityLogger {
    const isShutdown = Boolean(
      (
        this as unknown as {
          _sharedState?: { hasShutdown?: boolean };
        }
      )._sharedState?.hasShutdown
    );
    if (isShutdown) {
      diag.warn('A shutdown LoggerProvider cannot provide a Logger');
      return wrapLoggerWithStability(
        createNoopLogger(),
        this.minimumStability ?? Stability.STABLE
      );
    }

    const baseLogger = super.getLogger(
      name,
      version,
      options
    ) as StabilityLogger & {
      [STABILITY_WRAPPER_SYMBOL]?: boolean;
    };
    if (!baseLogger[STABILITY_WRAPPER_SYMBOL]) {
      const origEnabled = baseLogger.enabled.bind(baseLogger);
      const origEmit = baseLogger.emit.bind(baseLogger);

      baseLogger[STABILITY_WRAPPER_SYMBOL] = true;

      baseLogger.enabled = (
        enabledOptions?: StabilityLoggerEnabledOptions | Stability
      ): boolean => {
        const stability =
          typeof enabledOptions === 'number'
            ? enabledOptions
            : enabledOptions?.stability;
        if (
          !isStabilityEnabled(
            stability,
            this.minimumStability ?? Stability.STABLE
          )
        ) {
          return false;
        }
        const delegateOptions =
          typeof enabledOptions === 'object' ? enabledOptions : undefined;
        return origEnabled(delegateOptions);
      };

      baseLogger.emit = (logRecord: StabilityLogRecord): void => {
        if (
          !isStabilityEnabled(
            logRecord.stability,
            this.minimumStability ?? Stability.STABLE
          )
        ) {
          return;
        }
        origEmit(logRecord);
      };
    }
    return baseLogger;
  }
}
