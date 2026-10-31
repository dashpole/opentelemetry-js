/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import {
  context,
  INVALID_SPAN_CONTEXT,
  SeverityNumber,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { parseConfigFile } from '@opentelemetry/configuration';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOnSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';
import {
  createLoggerProviderFromConfig,
  createMeterProviderFromConfig,
  createTracerProviderFromConfig,
} from '../src/create-from-config';
import {
  Stability,
  StabilityLoggerProvider,
  StabilityMeterProvider,
  StabilityTracerProvider,
  type StabilityViewOptions,
} from '../src';

describe('Instrumentation Stability API (@opentelemetry/sdk-node)', () => {
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });

  afterEach(() => {
    context.disable();
    sinon.restore();
  });

  describe('Traces — StabilityTracerProvider & StabilityTracer', () => {
    it('defaults minimumStability to Stability.STABLE and suppresses DEVELOPMENT spans', async () => {
      const exporter = new InMemorySpanExporter();
      const sampler = new AlwaysOnSampler();
      const shouldSampleSpy = sinon.spy(sampler, 'shouldSample');
      const processor = new SimpleSpanProcessor({ exporter });
      const onStartSpy = sinon.spy(processor, 'onStart');

      const provider = new StabilityTracerProvider({
        sampler,
        spanProcessors: [processor],
      });
      assert.strictEqual(provider.minimumStability, Stability.STABLE);

      const tracer = provider.getTracer('test-tracer', '1.0.0');
      assert.strictEqual(tracer.enabled(), true);
      assert.strictEqual(tracer.enabled({ stability: Stability.STABLE }), true);
      assert.strictEqual(tracer.enabled(Stability.STABLE), true);
      assert.strictEqual(
        tracer.enabled({ stability: Stability.DEVELOPMENT }),
        false
      );
      assert.strictEqual(tracer.enabled(Stability.DEVELOPMENT), false);

      // Root DEVELOPMENT span returns non-recording span with INVALID_SPAN_CONTEXT
      const devRoot = tracer.startSpan('dev-root', {
        stability: Stability.DEVELOPMENT,
      });
      assert.strictEqual(devRoot.isRecording(), false);
      assert.deepStrictEqual(devRoot.spanContext(), INVALID_SPAN_CONTEXT);
      devRoot.end();
      assert.strictEqual(shouldSampleSpy.callCount, 0);
      assert.strictEqual(onStartSpy.callCount, 0);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);

      // Default (STABLE) span is recorded
      const stableSpan = tracer.startSpan('stable-root');
      assert.strictEqual(stableSpan.isRecording(), true);
      stableSpan.end();
      assert.strictEqual(shouldSampleSpy.callCount, 1);
      assert.strictEqual(onStartSpy.callCount, 1);
      assert.strictEqual(exporter.getFinishedSpans().length, 1);
      assert.strictEqual(exporter.getFinishedSpans()[0].name, 'stable-root');

      await provider.shutdown();
    });

    it('preserves parent SpanContext continuity across a suppressed DEVELOPMENT span', async () => {
      const exporter = new InMemorySpanExporter();
      const sampler = new AlwaysOnSampler();
      const shouldSampleSpy = sinon.spy(sampler, 'shouldSample');
      const provider = new StabilityTracerProvider({
        sampler,
        spanProcessors: [new SimpleSpanProcessor({ exporter })],
        minimumStability: Stability.STABLE,
      });

      const tracer = provider.getTracer('http-instrumentation', '1.0.0');

      tracer.startActiveSpan('parent-stable-span', parentSpan => {
        const parentSpanContext = parentSpan.spanContext();
        assert.strictEqual(parentSpan.isRecording(), true);
        assert.strictEqual(parentSpanContext.traceFlags, TraceFlags.SAMPLED);

        tracer.startActiveSpan(
          'suppressed-dev-span',
          { stability: Stability.DEVELOPMENT },
          devSpan => {
            // Suppressed span is non-recording and wraps parentSpanContext unchanged
            assert.strictEqual(devSpan.isRecording(), false);
            assert.deepStrictEqual(devSpan.spanContext(), parentSpanContext);

            // Active span in context carries parentSpan's SpanContext
            const activeCtxSpan = trace.getSpan(context.active());
            assert.ok(activeCtxSpan);
            assert.deepStrictEqual(
              activeCtxSpan.spanContext(),
              parentSpanContext
            );

            // Child STABLE span created inside suppressed DEVELOPMENT span links directly to parent-stable-span
            const childStableSpan = tracer.startSpan('child-stable-span', {
              stability: Stability.STABLE,
            });
            assert.strictEqual(childStableSpan.isRecording(), true);
            assert.strictEqual(
              childStableSpan.spanContext().traceId,
              parentSpanContext.traceId
            );
            assert.notStrictEqual(
              childStableSpan.spanContext().spanId,
              parentSpanContext.spanId
            );
            childStableSpan.end();
            devSpan.end();
          }
        );

        parentSpan.end();
      });

      // Sampler was only invoked for parent-stable-span and child-stable-span (2 times, not 3)
      assert.strictEqual(shouldSampleSpy.callCount, 2);

      const finished = exporter.getFinishedSpans();
      assert.strictEqual(finished.length, 2);
      const childSpanData = finished.find(s => s.name === 'child-stable-span')!;
      const parentSpanData = finished.find(
        s => s.name === 'parent-stable-span'
      )!;
      assert.ok(childSpanData);
      assert.ok(parentSpanData);
      assert.strictEqual(
        childSpanData.parentSpanContext?.spanId,
        parentSpanData.spanContext().spanId
      );
      assert.strictEqual(
        childSpanData.spanContext().traceId,
        parentSpanData.spanContext().traceId
      );

      await provider.shutdown();
    });

    it('records DEVELOPMENT spans when minimumStability is Stability.DEVELOPMENT', async () => {
      const exporter = new InMemorySpanExporter();
      const provider = new StabilityTracerProvider({
        spanProcessors: [new SimpleSpanProcessor({ exporter })],
        minimumStability: Stability.DEVELOPMENT,
      });

      const tracer = provider.getTracer('test-tracer');
      assert.strictEqual(tracer.enabled({ stability: Stability.STABLE }), true);
      assert.strictEqual(
        tracer.enabled({ stability: Stability.DEVELOPMENT }),
        true
      );

      const devSpan = tracer.startSpan('dev-span', {
        stability: Stability.DEVELOPMENT,
      });
      assert.strictEqual(devSpan.isRecording(), true);
      devSpan.end();

      const stableSpan = tracer.startSpan('stable-span', {
        stability: Stability.STABLE,
      });
      assert.strictEqual(stableSpan.isRecording(), true);
      stableSpan.end();

      assert.strictEqual(exporter.getFinishedSpans().length, 2);
      await provider.shutdown();
    });

    it('returns false from enabled() when no SpanProcessors are registered', async () => {
      const provider = new StabilityTracerProvider({
        spanProcessors: [],
        minimumStability: Stability.DEVELOPMENT,
      });
      const tracer = provider.getTracer('no-processors');
      assert.strictEqual(tracer.enabled(), false);
      assert.strictEqual(
        tracer.enabled({ stability: Stability.DEVELOPMENT }),
        false
      );
      await provider.shutdown();
    });
  });

  describe('Metrics — 2x2 Stability x OptIn Matrix & View enabled Override', () => {
    async function runMatrixScenario(opts: {
      minimumStability?: Stability;
      views?: StabilityViewOptions[];
    }): Promise<{
      enabledMap: Record<string, boolean>;
      collectedNames: string[];
    }> {
      const exporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE
      );
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new StabilityMeterProvider({
        readers: [reader],
        minimumStability: opts.minimumStability,
        views: opts.views,
      });

      const meter = provider.getMeter('test-meter', '1.0.0');

      const cStableDefault = meter.createCounter('metric.stable.default', {
        stability: Stability.STABLE,
        optIn: false,
      });
      const cStableOptIn = meter.createCounter('metric.stable.opt_in', {
        stability: Stability.STABLE,
        optIn: true,
      });
      const cDevDefault = meter.createCounter('metric.dev.default', {
        stability: Stability.DEVELOPMENT,
        optIn: false,
      });
      const cDevOptIn = meter.createCounter('metric.dev.opt_in', {
        stability: Stability.DEVELOPMENT,
        optIn: true,
      });

      const enabledMap = {
        'metric.stable.default': cStableDefault.enabled(),
        'metric.stable.opt_in': cStableOptIn.enabled(),
        'metric.dev.default': cDevDefault.enabled(),
        'metric.dev.opt_in': cDevOptIn.enabled(),
      };

      cStableDefault.add(1);
      cStableOptIn.add(1);
      cDevDefault.add(1);
      cDevOptIn.add(1);

      await provider.forceFlush();
      const resourceMetrics = exporter.getMetrics();
      const collectedNames: string[] = [];
      for (const rm of resourceMetrics) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) {
            collectedNames.push(m.descriptor.name);
          }
        }
      }

      await provider.shutdown();
      return { enabledMap, collectedNames };
    }

    it('Column 1: Default (minimumStability = Stability.STABLE) — only (Stable, optIn=false) is enabled', async () => {
      const { enabledMap, collectedNames } = await runMatrixScenario({});
      assert.deepStrictEqual(enabledMap, {
        'metric.stable.default': true,
        'metric.stable.opt_in': false,
        'metric.dev.default': false,
        'metric.dev.opt_in': false,
      });
      assert.deepStrictEqual(collectedNames, ['metric.stable.default']);
    });

    it('Column 2: Provider minimumStability = Stability.DEVELOPMENT — (Stable, false) and (Development, false) enabled; optIn remains disabled', async () => {
      const { enabledMap, collectedNames } = await runMatrixScenario({
        minimumStability: Stability.DEVELOPMENT,
      });
      assert.deepStrictEqual(enabledMap, {
        'metric.stable.default': true,
        'metric.stable.opt_in': false,
        'metric.dev.default': true,
        'metric.dev.opt_in': false,
      });
      assert.deepStrictEqual(collectedNames.sort(), [
        'metric.dev.default',
        'metric.stable.default',
      ]);
    });

    it('Column 3: Matching View enabled = true — overrides both optIn=true and stability=DEVELOPMENT', async () => {
      const { enabledMap, collectedNames } = await runMatrixScenario({
        minimumStability: Stability.STABLE,
        views: [{ instrumentName: 'metric.*', enabled: true }],
      });
      assert.deepStrictEqual(enabledMap, {
        'metric.stable.default': true,
        'metric.stable.opt_in': true,
        'metric.dev.default': true,
        'metric.dev.opt_in': true,
      });
      assert.deepStrictEqual(collectedNames.sort(), [
        'metric.dev.default',
        'metric.dev.opt_in',
        'metric.stable.default',
        'metric.stable.opt_in',
      ]);
    });

    it('Matching View enabled = false — disables even (Stable, optIn=false) and when minimumStability is DEVELOPMENT', async () => {
      const { enabledMap, collectedNames } = await runMatrixScenario({
        minimumStability: Stability.DEVELOPMENT,
        views: [{ instrumentName: 'metric.*', enabled: false }],
      });
      assert.deepStrictEqual(enabledMap, {
        'metric.stable.default': false,
        'metric.stable.opt_in': false,
        'metric.dev.default': false,
        'metric.dev.opt_in': false,
      });
      assert.deepStrictEqual(collectedNames, []);
    });

    it('Matching View without enabled set — does not enable DEVELOPMENT or optIn instruments', async () => {
      const { enabledMap, collectedNames } = await runMatrixScenario({
        minimumStability: Stability.STABLE,
        views: [
          {
            instrumentName: 'metric.*',
            description: 'custom description without enabled',
          },
        ],
      });
      assert.deepStrictEqual(enabledMap, {
        'metric.stable.default': true,
        'metric.stable.opt_in': false,
        'metric.dev.default': false,
        'metric.dev.opt_in': false,
      });
      assert.deepStrictEqual(collectedNames, ['metric.stable.default']);
    });

    it('supports asynchronous instruments (ObservableGauge, ObservableCounter, ObservableUpDownCounter)', async () => {
      const exporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE
      );
      const reader = new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 60_000,
      });
      const provider = new StabilityMeterProvider({
        readers: [reader],
        minimumStability: Stability.STABLE,
        views: [{ instrumentName: 'async.dev.view_enabled', enabled: true }],
      });

      const meter = provider.getMeter('async-test');

      const stableGauge = meter.createObservableGauge('async.stable');
      stableGauge.addCallback(res => res.observe(10));

      const devGaugeDropped = meter.createObservableGauge('async.dev.dropped', {
        advice: { stability: Stability.DEVELOPMENT },
      });
      devGaugeDropped.addCallback(res => res.observe(20));

      const devGaugeViewEnabled = meter.createObservableGauge(
        'async.dev.view_enabled',
        {
          advice: { stability: Stability.DEVELOPMENT, optIn: true },
        }
      );
      devGaugeViewEnabled.addCallback(res => res.observe(30));

      await provider.forceFlush();
      const collectedNames = exporter
        .getMetrics()[0]
        .scopeMetrics[0].metrics.map(m => m.descriptor.name)
        .sort();
      assert.deepStrictEqual(collectedNames, [
        'async.dev.view_enabled',
        'async.stable',
      ]);

      await provider.shutdown();
    });
  });

  describe('Logs — StabilityLoggerProvider & StabilityLogger', () => {
    it('defaults minimumStability to Stability.STABLE and drops DEVELOPMENT log records before processors', async () => {
      const exporter = new InMemoryLogRecordExporter();
      const processor = new SimpleLogRecordProcessor({ exporter });
      const onEmitSpy = sinon.spy(processor, 'onEmit');

      const provider = new StabilityLoggerProvider({
        processors: [processor],
      });
      assert.strictEqual(provider.minimumStability, Stability.STABLE);

      const logger = provider.getLogger('test-logger', '1.0.0');
      assert.strictEqual(logger.enabled(), true);
      assert.strictEqual(
        logger.enabled({
          stability: Stability.STABLE,
          severityNumber: SeverityNumber.INFO,
        }),
        true
      );
      assert.strictEqual(logger.enabled(Stability.STABLE), true);
      assert.strictEqual(
        logger.enabled({
          stability: Stability.DEVELOPMENT,
          severityNumber: SeverityNumber.INFO,
        }),
        false
      );
      assert.strictEqual(logger.enabled(Stability.DEVELOPMENT), false);

      // DEVELOPMENT log record is dropped before onEmit
      logger.emit({
        body: 'dev log message',
        severityNumber: SeverityNumber.INFO,
        stability: Stability.DEVELOPMENT,
      });
      assert.strictEqual(onEmitSpy.callCount, 0);
      assert.strictEqual(exporter.getFinishedLogRecords().length, 0);

      // STABLE log record is processed
      logger.emit({
        body: 'stable log message',
        severityNumber: SeverityNumber.INFO,
        stability: Stability.STABLE,
      });
      assert.strictEqual(onEmitSpy.callCount, 1);
      assert.strictEqual(exporter.getFinishedLogRecords().length, 1);
      assert.strictEqual(
        exporter.getFinishedLogRecords()[0].body,
        'stable log message'
      );

      await provider.shutdown();
    });

    it('processes DEVELOPMENT log records when minimumStability is Stability.DEVELOPMENT', async () => {
      const exporter = new InMemoryLogRecordExporter();
      const provider = new StabilityLoggerProvider({
        processors: [new SimpleLogRecordProcessor({ exporter })],
        minimumStability: Stability.DEVELOPMENT,
      });

      const logger = provider.getLogger('test-logger');
      assert.strictEqual(
        logger.enabled({ stability: Stability.DEVELOPMENT }),
        true
      );

      logger.emit({
        body: 'dev log message',
        stability: Stability.DEVELOPMENT,
      });
      logger.emit({
        body: 'default stable log message',
      });

      assert.strictEqual(exporter.getFinishedLogRecords().length, 2);
      await provider.shutdown();
    });
  });

  describe('Declarative Configuration — minimum_stability and View stream.enabled', () => {
    it('parses and applies minimum_stability and view.stream.enabled from YAML config', async () => {
      const configYaml = `
file_format: "1.1"
tracer_provider:
  minimum_stability: development
  processors:
    - simple:
        exporter:
          console: {}
meter_provider:
  minimum_stability: stable
  readers:
    - periodic:
        exporter:
          console: {}
  views:
    - selector:
        instrument_name: http.server.active_requests
      stream:
        enabled: true
logger_provider:
  minimum_stability: development
  processors:
    - simple:
        exporter:
          console: {}
`;
      const tmpFile = path.join(
        os.tmpdir(),
        `otel-stability-test-${process.pid}-${Date.now()}.yaml`
      );
      fs.writeFileSync(tmpFile, configYaml, 'utf8');
      try {
        const model = parseConfigFile(tmpFile);
        const resource = resourceFromAttributes({});

        const tracerProvider = createTracerProviderFromConfig(
          resource,
          model.tracer_provider!
        ) as StabilityTracerProvider;
        assert.strictEqual(
          tracerProvider.minimumStability,
          Stability.DEVELOPMENT
        );
        assert.strictEqual(
          tracerProvider
            .getTracer('t')
            .enabled({ stability: Stability.DEVELOPMENT }),
          true
        );

        const meterProvider = createMeterProviderFromConfig(
          resource,
          model.meter_provider!
        ) as StabilityMeterProvider;
        assert.strictEqual(meterProvider.minimumStability, Stability.STABLE);
        const meter = meterProvider.getMeter('http');
        const activeRequests = meter.createUpDownCounter(
          'http.server.active_requests',
          { stability: Stability.DEVELOPMENT }
        );
        const bodySize = meter.createHistogram(
          'http.server.request.body.size',
          {
            stability: Stability.DEVELOPMENT,
          }
        );
        assert.strictEqual(activeRequests.enabled(), true);
        assert.strictEqual(bodySize.enabled(), false);

        const loggerProvider = createLoggerProviderFromConfig(
          resource,
          model.logger_provider!
        ) as StabilityLoggerProvider;
        assert.strictEqual(
          loggerProvider.minimumStability,
          Stability.DEVELOPMENT
        );
        assert.strictEqual(
          loggerProvider
            .getLogger('l')
            .enabled({ stability: Stability.DEVELOPMENT }),
          true
        );

        await tracerProvider.shutdown();
        await meterProvider.shutdown();
        await loggerProvider.shutdown();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
