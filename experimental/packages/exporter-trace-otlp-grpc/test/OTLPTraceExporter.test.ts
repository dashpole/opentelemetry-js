/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { OTLPTraceExporter } from '../src';
import type { ServerTestContext } from './utils';
import { startServer, TestMetricReader } from './utils';
import * as assert from 'assert';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { OAuth2Authenticator } from '@opentelemetry/otlp-exporter-base';

const testServiceDefinition = {
  export: {
    path: '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
    requestStream: false,
    responseStream: false,
    requestSerialize: (arg: Buffer) => {
      return arg;
    },
    requestDeserialize: (arg: Buffer) => {
      return arg;
    },
    responseSerialize: (arg: Buffer) => {
      return arg;
    },
    responseDeserialize: (arg: Buffer) => {
      return arg;
    },
  },
};

/*
 * NOTE: Tests here are not intended to test the underlying components directly. They are intended as a quick
 * check if the correct components are used. Use the following packages to test details:
 * - `@opentelemetry/oltp-exporter-base`: OTLP common exporter logic (handling of concurrent exports, ...)
 * - `@opentelemetry/otlp-transformer`: Everything regarding serialization and transforming internal representations to OTLP
 * - `@opentelemetry/otlp-grpc-exporter-base`: gRPC transport
 */
describe('OTLPTraceExporter', function () {
  let shutdownHandle: () => void | undefined;
  const serverTestContext: ServerTestContext = {
    requests: [],
    serverResponseProvider: () => {
      return { error: null, buffer: Buffer.from([]) };
    },
  };

  beforeEach(async function () {
    shutdownHandle = await startServer(
      'localhost:1501',
      testServiceDefinition,
      serverTestContext
    );
  });

  afterEach(function () {
    shutdownHandle();

    // clear context
    serverTestContext.requests = [];
    serverTestContext.serverResponseProvider = () => {
      return { error: null, buffer: Buffer.from([]) };
    };
  });

  it('successfully exports data', async () => {
    // arrange
    const metricReader = new TestMetricReader();
    const meterProvider = new MeterProvider({
      readers: [metricReader],
    });
    const tracerProvider = new TracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor({
          exporter: new OTLPTraceExporter({
            url: 'http://localhost:1501',
            selfObsMeterProvider: meterProvider,
          }),
        }),
      ],
    });

    // act
    tracerProvider.getTracer('test-tracer').startSpan('test-span').end();
    await tracerProvider.shutdown();

    // assert
    assert.strictEqual(serverTestContext.requests.length, 1);

    const metrics = await metricReader.collect();
    const scopeMetrics = metrics.resourceMetrics.scopeMetrics.find(
      sm => sm.scope.name === '@opentelemetry/otlp-exporter'
    );
    assert.ok(scopeMetrics);
    await meterProvider.shutdown();
  });

  it('exports spans using OAuth2Authenticator with gRPC metadata', async () => {
    const oauthServer = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(
        JSON.stringify({
          access_token: 'trace-grpc-token',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      );
    });
    await new Promise<void>(resolve =>
      oauthServer.listen(0, '127.0.0.1', resolve)
    );
    const oauthPort = (oauthServer.address() as AddressInfo).port;

    try {
      const authenticator = new OAuth2Authenticator({
        tokenUrl: `http://127.0.0.1:${oauthPort}/oauth/token`,
        clientId: 'trace-grpc-client',
        clientSecret: 'trace-grpc-secret',
      });

      const tracerProvider = new TracerProvider({
        spanProcessors: [
          new SimpleSpanProcessor({
            exporter: new OTLPTraceExporter({
              url: 'http://localhost:1501',
              authenticator,
            }),
          }),
        ],
      });

      tracerProvider.getTracer('test-tracer').startSpan('auth-span').end();
      await tracerProvider.shutdown();

      assert.strictEqual(serverTestContext.requests.length, 1);
      assert.deepStrictEqual(
        serverTestContext.requests[0].metadata.get('authorization'),
        ['Bearer trace-grpc-token']
      );
    } finally {
      oauthServer.closeAllConnections();
      await new Promise<void>(resolve => oauthServer.close(() => resolve()));
    }
  });
});
