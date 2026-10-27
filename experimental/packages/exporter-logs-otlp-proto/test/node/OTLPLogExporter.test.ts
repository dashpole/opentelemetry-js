/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as http from 'http';
import { syncBuiltinESMExports } from 'module';
import type { AddressInfo } from 'net';
import * as sinon from 'sinon';

import { OTLPLogExporter } from '../../src/platform/node';
import { OAuth2Authenticator } from '@opentelemetry/otlp-exporter-base';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { Stream } from 'stream';
import { TestMetricReader } from '../utils';

/*
 * NOTE: Tests here are not intended to test the underlying components directly. They are intended as a quick
 * check if the correct components are used. Use the following packages to test details:
 * - `@opentelemetry/oltp-exporter-base`: OTLP common exporter logic (handling of concurrent exports, ...), HTTP transport code
 * - `@opentelemetry/otlp-transformer`: Everything regarding serialization and transforming internal representations to OTLP
 */

describe('OTLPLogExporter', () => {
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
          assert.throws(() => {
            JSON.parse(requestBody);
          }, 'expected requestBody to be in protobuf format, but parsing as JSON succeeded');

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

      const loggerProvider = new LoggerProvider({
        processors: [
          new SimpleLogRecordProcessor({
            exporter: new OTLPLogExporter({
              selfObsMeterProvider: meterProvider,
            }),
          }),
        ],
      });

      loggerProvider.getLogger('test-logger').emit({ body: 'test-body' });
      loggerProvider.shutdown();
    });

    it('exports logs using OAuth2Authenticator against local OAuth2 and OTLP Protobuf servers', async () => {
      const oauthServer = http.createServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(
          JSON.stringify({
            access_token: 'logs-proto-token',
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
      let receivedBytes = 0;
      const collectorServer = http.createServer((req, res) => {
        receivedAuthHeader = req.headers['authorization'];
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          receivedBytes = Buffer.concat(chunks).length;
          if (receivedAuthHeader !== 'Bearer logs-proto-token') {
            res.writeHead(401, { Connection: 'close' });
            res.end();
            return;
          }
          res.writeHead(200, { Connection: 'close' });
          res.end();
        });
      });
      await new Promise<void>(resolve =>
        collectorServer.listen(0, '127.0.0.1', resolve)
      );
      const collectorPort = (collectorServer.address() as AddressInfo).port;

      try {
        const authenticator = new OAuth2Authenticator({
          tokenUrl: `http://127.0.0.1:${oauthPort}/oauth/token`,
          clientId: 'logs-proto-client',
          clientSecret: 'logs-proto-secret',
        });

        const loggerProvider = new LoggerProvider({
          processors: [
            new SimpleLogRecordProcessor({
              exporter: new OTLPLogExporter({
                url: `http://127.0.0.1:${collectorPort}/v1/logs`,
                authenticator,
              }),
            }),
          ],
        });

        loggerProvider.getLogger('test-logger').emit({ body: 'auth-log-body' });
        await loggerProvider.shutdown();

        assert.strictEqual(receivedAuthHeader, 'Bearer logs-proto-token');
        assert.ok(receivedBytes > 0);
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
