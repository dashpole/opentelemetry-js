/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as http from 'http';
import { syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import * as sinon from 'sinon';

import { AggregationTemporalityPreference } from '../../src';
import { OTLPMetricExporter } from '../../src/platform/node';
import { OAuth2Authenticator } from '@opentelemetry/otlp-exporter-base';
import type { AggregationOption } from '@opentelemetry/sdk-metrics';
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { Stream } from 'stream';
import { TestMetricReader } from '../utils';

/*
 * NOTE: Tests here are not intended to test the underlying components directly. They are intended as a quick
 * check if the correct components are used. Use the following packages to test details:
 * - `@opentelemetry/oltp-exporter-base`: OTLP common exporter logic (handling of concurrent exports, ...), HTTP transport code
 * - `@opentelemetry/otlp-transformer`: Everything regarding serialization and transforming internal representations to OTLP
 */

describe('OTLPMetricExporter', () => {
  describe('temporality', () => {
    it('should use the right temporality when Cumulative preference is selected', () => {
      const exporter = new OTLPMetricExporter({
        temporalityPreference: AggregationTemporalityPreference.CUMULATIVE,
      });

      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.COUNTER),
        AggregationTemporality.CUMULATIVE,
        'Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM),
        AggregationTemporality.CUMULATIVE,
        'Histogram'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER),
        AggregationTemporality.CUMULATIVE,
        'UpDownCounter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_COUNTER
        ),
        AggregationTemporality.CUMULATIVE,
        'Asynchronous Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_UP_DOWN_COUNTER
        ),
        AggregationTemporality.CUMULATIVE,
        'Asynchronous UpDownCounter'
      );
    });

    it('should use the right temporality when Delta preference is selected', () => {
      const exporter = new OTLPMetricExporter({
        temporalityPreference: AggregationTemporalityPreference.DELTA,
      });

      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.COUNTER),
        AggregationTemporality.DELTA,
        'Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM),
        AggregationTemporality.DELTA,
        'Histogram'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER),
        AggregationTemporality.CUMULATIVE,
        'UpDownCounter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_COUNTER
        ),
        AggregationTemporality.DELTA,
        'Asynchronous Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_UP_DOWN_COUNTER
        ),
        AggregationTemporality.CUMULATIVE,
        'Asynchronous UpDownCounter'
      );
    });

    it('should use the right temporality when LowMemory preference is selected', () => {
      const exporter = new OTLPMetricExporter({
        temporalityPreference: AggregationTemporalityPreference.LOWMEMORY,
      });

      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.COUNTER),
        AggregationTemporality.DELTA,
        'Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM),
        AggregationTemporality.DELTA,
        'Histogram'
      );
      assert.equal(
        exporter.selectAggregationTemporality(InstrumentType.UP_DOWN_COUNTER),
        AggregationTemporality.CUMULATIVE,
        'UpDownCounter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_COUNTER
        ),
        AggregationTemporality.CUMULATIVE,
        'Asynchronous Counter'
      );
      assert.equal(
        exporter.selectAggregationTemporality(
          InstrumentType.OBSERVABLE_UP_DOWN_COUNTER
        ),
        AggregationTemporality.CUMULATIVE,
        'Asynchronous UpDownCounter'
      );
    });
  });

  describe('aggregation', () => {
    it('aggregationSelector calls the selector supplied to the constructor', () => {
      const aggregation: AggregationOption = {
        type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
        options: {
          boundaries: [0, 100, 100000],
        },
      };
      const exporter = new OTLPMetricExporter({
        aggregationPreference: _instrumentType => aggregation,
      });
      assert.equal(
        exporter.selectAggregation(InstrumentType.COUNTER),
        aggregation
      );
    });

    it('aggregationSelector returns the default aggregation preference when nothing is supplied', () => {
      const exporter = new OTLPMetricExporter({
        aggregationPreference: _instrumentType => ({
          type: AggregationType.DEFAULT,
        }),
      });
      assert.deepStrictEqual(
        exporter.selectAggregation(InstrumentType.COUNTER),
        {
          type: AggregationType.DEFAULT,
        }
      );
    });
  });

  describe('export', () => {
    afterEach(() => {
      sinon.restore();
      syncBuiltinESMExports();
    });

    it('successfully exports data', function (done) {
      const testMetricReader = new TestMetricReader();
      // arrange
      const fakeRequest = new Stream.PassThrough();
      Object.defineProperty(fakeRequest, 'setTimeout', {
        value: function (_timeout: number) {},
      });

      // callsFake so the response callback is invoked after the request body is
      // sent, which resolves the sendWithHttp promise and lets the process exit
      // without waiting for the 30 s export timeout to fire.
      (sinon.stub(http, 'request') as sinon.SinonStub).callsFake(
        (...args: unknown[]) => {
          const callback =
            typeof args[args.length - 1] === 'function'
              ? (args[args.length - 1] as (res: unknown) => void)
              : null;
          fakeRequest.on('finish', () => {
            if (callback) {
              const fakeResponse = new Stream.PassThrough() as any;
              fakeResponse.statusCode = 200;
              fakeResponse.statusMessage = 'OK';
              fakeResponse.headers = {};
              callback(fakeResponse);
              fakeResponse.end();
            }
          });
          return fakeRequest as any;
        }
      );
      let buff = Buffer.from('');
      fakeRequest.on('finish', async () => {
        try {
          // assert
          const requestBody = buff.toString();
          assert.doesNotThrow(() => {
            JSON.parse(requestBody);
          }, 'expected requestBody to be in JSON format, but parsing failed');

          const metrics = await testMetricReader.collect();
          const scopeMetrics = metrics.resourceMetrics.scopeMetrics.find(
            sm => sm.scope.name === '@opentelemetry/otlp-exporter'
          );
          assert.ok(scopeMetrics);
          meterProvider.shutdown();

          done();
        } catch (e) {
          done(e);
        }
      });

      fakeRequest.on('data', chunk => {
        buff = Buffer.concat([buff, chunk]);
      });

      const exporter = new OTLPMetricExporter();
      const meterProvider = new MeterProvider({
        readers: [
          new PeriodicExportingMetricReader({
            exporter,
          }),
          testMetricReader,
        ],
      });
      exporter.setSelfObsMeterProvider(meterProvider);
      meterProvider.getMeter('test-meter').createCounter('test-counter').add(1);

      // act
      meterProvider.forceFlush();
    });

    it('exports metrics using OAuth2Authenticator against local OAuth2 and OTLP servers', async () => {
      const oauthServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(
          JSON.stringify({
            access_token: 'metrics-http-token',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
      });
      await new Promise<void>(resolve =>
        oauthServer.listen(0, '127.0.0.1', resolve)
      );
      const oauthPort = (oauthServer.address() as AddressInfo).port;

      let receivedAuthHeader: string | undefined;
      let receivedBody = '';
      const collectorServer = http.createServer((req, res) => {
        receivedAuthHeader = req.headers['authorization'];
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8');
          if (receivedAuthHeader !== 'Bearer metrics-http-token') {
            res.writeHead(401, { Connection: 'close' });
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            Connection: 'close',
          });
          res.end('{}');
        });
      });
      await new Promise<void>(resolve =>
        collectorServer.listen(0, '127.0.0.1', resolve)
      );
      const collectorPort = (collectorServer.address() as AddressInfo).port;

      try {
        const authenticator = new OAuth2Authenticator({
          tokenUrl: `http://127.0.0.1:${oauthPort}/oauth/token`,
          clientId: 'metrics-http-client',
          clientSecret: 'metrics-http-secret',
        });

        const exporter = new OTLPMetricExporter({
          url: `http://127.0.0.1:${collectorPort}/v1/metrics`,
          authenticator,
        });
        const meterProvider = new MeterProvider({
          readers: [
            new PeriodicExportingMetricReader({
              exporter,
            }),
          ],
        });

        meterProvider
          .getMeter('test-meter')
          .createCounter('auth-counter')
          .add(1);
        await meterProvider.forceFlush();
        await meterProvider.shutdown();

        assert.strictEqual(receivedAuthHeader, 'Bearer metrics-http-token');
        assert.ok(JSON.parse(receivedBody));
      } finally {
        oauthServer.closeAllConnections();
        collectorServer.closeAllConnections();
        await new Promise<void>(resolve => oauthServer.close(() => resolve()));
        await new Promise<void>(resolve =>
          collectorServer.close(() => resolve())
        );
      }
    });
  });
});
