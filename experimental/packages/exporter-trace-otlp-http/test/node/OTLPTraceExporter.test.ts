/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as http from 'http';
import { syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import * as sinon from 'sinon';
import { Stream } from 'stream';

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { TracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { OAuth2Authenticator } from '@opentelemetry/otlp-exporter-base';
import { OTLPTraceExporter } from '../../src/platform/node';
import { TestMetricReader } from '../utils';

/*
 * NOTE: Tests here are not intended to test the underlying components directly. They are intended as a quick
 * check if the correct components are used. Use the following packages to test details:
 * - `@opentelemetry/oltp-exporter-base`: OTLP common exporter logic (handling of concurrent exports, ...), HTTP transport code
 * - `@opentelemetry/otlp-transformer`: Everything regarding serialization and transforming internal representations to OTLP
 */

describe('OTLPTraceExporter', () => {
  describe('export', () => {
    afterEach(() => {
      sinon.restore();
      syncBuiltinESMExports();
    });

    it('successfully exports data', done => {
      const metricReader = new TestMetricReader();
      const meterProvider = new MeterProvider({
        readers: [metricReader],
      });

      const fakeRequest = new Stream.PassThrough();
      Object.defineProperty(fakeRequest, 'setTimeout', {
        value: function (_timeout: number) {},
      });

      sinon.stub(http, 'request').returns(fakeRequest as any);
      let buff = Buffer.from('');
      fakeRequest.on('finish', async () => {
        try {
          const requestBody = buff.toString();
          assert.doesNotThrow(() => {
            JSON.parse(requestBody);
          }, 'expected requestBody to be in JSON format, but parsing failed');

          const metrics = await metricReader.collect();
          const scopeMetrics = metrics.resourceMetrics.scopeMetrics.find(
            sm => sm.scope.name === '@opentelemetry/otlp-exporter'
          );
          assert.ok(scopeMetrics);

          done();
        } catch (e) {
          done(e);
        }
      });

      fakeRequest.on('data', chunk => {
        buff = Buffer.concat([buff, chunk]);
      });

      const tracerProvider = new TracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor({
            exporter: new OTLPTraceExporter({
              selfObsMeterProvider: meterProvider,
            }),
          }),
        ],
      });

      tracerProvider.getTracer('test-tracer').startSpan('test-span').end();
    });

    it('exports spans using OAuth2Authenticator against local OAuth2 and OTLP servers', async () => {
      const oauthServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(
          JSON.stringify({
            access_token: 'trace-http-token',
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
          if (receivedAuthHeader !== 'Bearer trace-http-token') {
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
          clientId: 'trace-http-client',
          clientSecret: 'trace-http-secret',
        });

        const tracerProvider = new TracerProvider({
          spanProcessors: [
            new SimpleSpanProcessor({
              exporter: new OTLPTraceExporter({
                url: `http://127.0.0.1:${collectorPort}/v1/traces`,
                authenticator,
              }),
            }),
          ],
        });

        tracerProvider.getTracer('test-tracer').startSpan('auth-span').end();
        await tracerProvider.shutdown();

        assert.strictEqual(receivedAuthHeader, 'Bearer trace-http-token');
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
