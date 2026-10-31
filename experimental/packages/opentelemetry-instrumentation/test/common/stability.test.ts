/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import {
  context,
  createNoopMeter,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  InstrumentationBase,
  isStabilityEnabled,
  normalizeStability,
  Stability,
  stabilityFromString,
  wrapLoggerWithStability,
  wrapMeterWithStability,
  wrapTracerWithStability,
} from '../../src';

class TestInstrumentation extends InstrumentationBase {
  constructor() {
    super('@opentelemetry/instrumentation-test', '1.0.0', {});
  }
  init() {}
  public getTestTracer() {
    return this.tracer;
  }
  public getTestMeter() {
    return this.meter;
  }
  public getTestLogger() {
    return this.logger;
  }
}

describe('Stability API (@opentelemetry/instrumentation)', () => {
  describe('Stability enum and helpers', () => {
    it('orders Stability.DEVELOPMENT < Stability.STABLE', () => {
      assert.ok(Stability.DEVELOPMENT < Stability.STABLE);
    });

    it('defaults unspecified stability to Stability.STABLE', () => {
      assert.strictEqual(normalizeStability(undefined), Stability.STABLE);
      assert.strictEqual(
        normalizeStability(Stability.STABLE),
        Stability.STABLE
      );
      assert.strictEqual(
        normalizeStability(Stability.DEVELOPMENT),
        Stability.DEVELOPMENT
      );
    });

    it('evaluates isStabilityEnabled across all combinations', () => {
      assert.strictEqual(
        isStabilityEnabled(Stability.STABLE, Stability.STABLE),
        true
      );
      assert.strictEqual(
        isStabilityEnabled(undefined, Stability.STABLE),
        true
      );
      assert.strictEqual(
        isStabilityEnabled(Stability.DEVELOPMENT, Stability.STABLE),
        false
      );
      assert.strictEqual(
        isStabilityEnabled(Stability.STABLE, Stability.DEVELOPMENT),
        true
      );
      assert.strictEqual(
        isStabilityEnabled(Stability.DEVELOPMENT, Stability.DEVELOPMENT),
        true
      );
    });

    it('parses stabilityFromString', () => {
      assert.strictEqual(stabilityFromString(undefined), Stability.STABLE);
      assert.strictEqual(stabilityFromString(null), Stability.STABLE);
      assert.strictEqual(stabilityFromString(''), Stability.STABLE);
      assert.strictEqual(stabilityFromString('stable'), Stability.STABLE);
      assert.strictEqual(stabilityFromString('STABLE'), Stability.STABLE);
      assert.strictEqual(
        stabilityFromString('development'),
        Stability.DEVELOPMENT
      );
      assert.strictEqual(
        stabilityFromString('DEVELOPMENT'),
        Stability.DEVELOPMENT
      );
      assert.throws(
        () => stabilityFromString('invalid'),
        /unknown minimum_stability/
      );
    });
  });

  describe('wrapTracerWithStability', () => {
    it('suppresses DEVELOPMENT spans and preserves parent SpanContext when minimumStability is STABLE', () => {
      const startedSpans: string[] = [];
      const fakeTracer = {
        startSpan(name: string, _opts?: unknown, ctx = context.active()): Span {
          startedSpans.push(name);
          const parentCtx = trace.getSpanContext(ctx);
          return trace.wrapSpanContext({
            traceId:
              parentCtx?.traceId ?? '11111111111111111111111111111111',
            spanId:
              name === 'parent' ? '2222222222222222' : '3333333333333333',
            traceFlags: TraceFlags.SAMPLED,
          });
        },
        startActiveSpan(name: string, fn: (span: Span) => unknown) {
          const span = this.startSpan(name);
          return context.with(trace.setSpan(context.active(), span), fn, undefined, span);
        },
      };

      const tracer = wrapTracerWithStability(
        fakeTracer as unknown as Tracer,
        Stability.STABLE
      );
      assert.strictEqual(tracer.enabled(), true);
      assert.strictEqual(tracer.enabled({ stability: Stability.STABLE }), true);
      assert.strictEqual(
        tracer.enabled({ stability: Stability.DEVELOPMENT }),
        false
      );
      assert.strictEqual(tracer.enabled(Stability.DEVELOPMENT), false);

      const parentSpan = tracer.startSpan('parent', {
        stability: Stability.STABLE,
      });
      const parentCtx = trace.setSpan(context.active(), parentSpan);

      const devSpan = tracer.startSpan(
        'dev-child',
        { stability: Stability.DEVELOPMENT },
        parentCtx
      );
      assert.strictEqual(devSpan.isRecording(), false);
      assert.deepStrictEqual(devSpan.spanContext(), parentSpan.spanContext());
      assert.deepStrictEqual(startedSpans, ['parent']);
    });
  });

  describe('wrapLoggerWithStability', () => {
    it('drops DEVELOPMENT log records when minimumStability is STABLE', () => {
      const emitted: unknown[] = [];
      const fakeLogger = {
        emit(record: unknown) {
          emitted.push(record);
        },
        enabled() {
          return true;
        },
      };

      const logger = wrapLoggerWithStability(fakeLogger, Stability.STABLE);
      assert.strictEqual(logger.enabled(), true);
      assert.strictEqual(
        logger.enabled({ stability: Stability.DEVELOPMENT }),
        false
      );

      logger.emit({ body: 'dev', stability: Stability.DEVELOPMENT });
      assert.strictEqual(emitted.length, 0);

      logger.emit({ body: 'stable', stability: Stability.STABLE });
      assert.strictEqual(emitted.length, 1);
    });
  });

  describe('wrapMeterWithStability & InstrumentationBase integration', () => {
    it('exposes Stability-aware tracer, meter, and logger on InstrumentationBase', () => {
      const instr = new TestInstrumentation();
      const counter = instr.getTestMeter().createCounter('dev.counter', {
        stability: Stability.DEVELOPMENT,
      });
      assert.strictEqual(counter.enabled(), false);

      const stableCounter = instr
        .getTestMeter()
        .createCounter('stable.counter', {
          stability: Stability.STABLE,
        });
      assert.strictEqual(stableCounter.enabled(), true);

      const optInCounter = instr.getTestMeter().createCounter('optin.counter', {
        stability: Stability.STABLE,
        optIn: true,
      });
      assert.strictEqual(optInCounter.enabled(), false);

      const devSpan = instr.getTestTracer().startSpan('dev.span', {
        stability: Stability.DEVELOPMENT,
      });
      assert.strictEqual(devSpan.isRecording(), false);
      devSpan.setStatus({ code: SpanStatusCode.OK });
      devSpan.end();

      assert.strictEqual(
        instr.getTestLogger().enabled({ stability: Stability.DEVELOPMENT }),
        false
      );
    });

    it('enables DEVELOPMENT instruments when wrapMeterWithStability uses Stability.DEVELOPMENT', () => {
      const wrappedDevMeter = wrapMeterWithStability(
        createNoopMeter(),
        Stability.DEVELOPMENT
      );
      assert.strictEqual(
        wrappedDevMeter
          .createCounter('dev.c', { stability: Stability.DEVELOPMENT })
          .enabled(),
        true
      );
      assert.strictEqual(
        wrappedDevMeter
          .createCounter('dev.optin', {
            stability: Stability.DEVELOPMENT,
            optIn: true,
          })
          .enabled(),
        false
      );
    });
  });
});
