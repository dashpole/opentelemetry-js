/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as http from 'http';
import * as sinon from 'sinon';
import type { AddressInfo } from 'net';
import { createHttpExporterTransport } from '../../src/platform/node/transport/http-exporter-transport';
import { createRetryingTransport } from '../../src/retrying-transport';
import type { Authenticator, ExportResponseFailure } from '../../src';
import { OAuth2Authenticator } from '../../src';

const samplePayload = new Uint8Array([10, 20, 30]);

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
    server.once('error', reject);
  });
}

function closeServer(server: http.Server | undefined): Promise<void> {
  return new Promise(resolve => {
    if (!server) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('HttpExporterTransport with Authenticator (Node E2E)', function () {
  let oauthServer: http.Server | undefined;
  let collectorServer: http.Server | undefined;

  afterEach(async function () {
    sinon.restore();
    await closeServer(oauthServer);
    oauthServer = undefined;
    await closeServer(collectorServer);
    collectorServer = undefined;
  });

  it('fetches OAuth2 Bearer token from local server and authenticates OTLP HTTP export', async function () {
    let tokenRequests = 0;
    let receivedTokenAuthHeader: string | undefined;
    let receivedTokenBody = '';

    oauthServer = http.createServer((req, res) => {
      tokenRequests++;
      receivedTokenAuthHeader = req.headers['authorization'];
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        receivedTokenBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `live-oauth-token-${tokenRequests}`,
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
      });
    });
    const oauthPort = await listenOnRandomPort(oauthServer);

    const collectorAuthHeaders: Array<string | undefined> = [];
    const collectorCustomHeaders: Array<string | string[] | undefined> = [];

    collectorServer = http.createServer((req, res) => {
      collectorAuthHeaders.push(req.headers['authorization']);
      collectorCustomHeaders.push(req.headers['x-custom']);
      if (req.headers['authorization'] !== 'Bearer live-oauth-token-1') {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const collectorPort = await listenOnRandomPort(collectorServer);

    const staticHeaders: Record<string, string> = {
      authorization: 'Bearer stale-static-token',
      'x-custom': 'preserve-me',
    };
    const staticSnapshot = { ...staticHeaders };

    const authenticator = new OAuth2Authenticator({
      tokenUrl: `http://127.0.0.1:${oauthPort}/oauth/token`,
      clientId: 'test-client',
      clientSecret: 'test-secret',
      scopes: ['trace.write'],
    });

    const transport = createHttpExporterTransport({
      url: `http://127.0.0.1:${collectorPort}/v1/traces`,
      headers: async () => staticHeaders,
      compression: 'none',
      agentFactory: () => new http.Agent(),
      authenticator,
    });

    const result1 = await transport.send(samplePayload, 5000);
    const result2 = await transport.send(samplePayload, 5000);

    assert.strictEqual(result1.status, 'success');
    assert.strictEqual(result2.status, 'success');
    assert.strictEqual(tokenRequests, 1);

    const expectedBasic = Buffer.from(
      'test-client:test-secret',
      'utf8'
    ).toString('base64');
    assert.strictEqual(receivedTokenAuthHeader, `Basic ${expectedBasic}`);
    assert.strictEqual(
      receivedTokenBody,
      'grant_type=client_credentials&scope=trace.write'
    );

    assert.deepStrictEqual(collectorAuthHeaders, [
      'Bearer live-oauth-token-1',
      'Bearer live-oauth-token-1',
    ]);
    assert.deepStrictEqual(collectorCustomHeaders, [
      'preserve-me',
      'preserve-me',
    ]);
    // Static headers object must not be mutated
    assert.deepStrictEqual(staticHeaders, staticSnapshot);

    await transport.shutdown();
  });

  it('invokes authenticator.getHeaders on each retry attempt', async function () {
    let authCalls = 0;
    const authenticator: Authenticator = {
      getHeaders: async () => {
        authCalls++;
        return { Authorization: `Bearer attempt-token-${authCalls}` };
      },
    };

    const receivedTokens: Array<string | undefined> = [];
    collectorServer = http.createServer((req, res) => {
      receivedTokens.push(req.headers['authorization']);
      if (receivedTokens.length === 1) {
        res.writeHead(503, { 'Retry-After': '1' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });
    const collectorPort = await listenOnRandomPort(collectorServer);

    const transport = createRetryingTransport({
      transport: createHttpExporterTransport({
        url: `http://127.0.0.1:${collectorPort}/v1/traces`,
        headers: async () => ({}),
        compression: 'none',
        agentFactory: () => new http.Agent(),
        authenticator,
      }),
    });

    const result = await transport.send(samplePayload, 5000);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(authCalls, 2);
    assert.deepStrictEqual(receivedTokens, [
      'Bearer attempt-token-1',
      'Bearer attempt-token-2',
    ]);
  });

  it('returns failure result when OAuth2 token server fails', async function () {
    oauthServer = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
    });
    const oauthPort = await listenOnRandomPort(oauthServer);

    let collectorCalled = false;
    collectorServer = http.createServer((_req, res) => {
      collectorCalled = true;
      res.writeHead(200);
      res.end();
    });
    const collectorPort = await listenOnRandomPort(collectorServer);

    const authenticator = new OAuth2Authenticator({
      tokenUrl: `http://127.0.0.1:${oauthPort}/oauth/token`,
      clientId: 'bad-client',
      clientSecret: 'bad-secret',
    });

    const transport = createHttpExporterTransport({
      url: `http://127.0.0.1:${collectorPort}/v1/traces`,
      headers: async () => ({}),
      compression: 'none',
      agentFactory: () => new http.Agent(),
      authenticator,
    });

    const result = await transport.send(samplePayload, 5000);
    assert.strictEqual(result.status, 'failure');
    assert.ok(
      (result as ExportResponseFailure).error.message.includes('status 401')
    );
    assert.strictEqual(collectorCalled, false);
  });
});
