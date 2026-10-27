/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { context } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { StackContextManager } from '@opentelemetry/sdk-trace';
import type { Authenticator, ExportResponseFailure } from '../../src';
import {
  OAuth2Authenticator,
  mergeHeadersCaseInsensitive,
  resolveAuthenticatorHeaders,
} from '../../src';
import { createFetchTransport } from '../../src/platform/browser/transport/fetch-transport';

describe('Authenticator utilities', function () {
  afterEach(function () {
    sinon.restore();
  });

  describe('mergeHeadersCaseInsensitive', function () {
    it('overrides base headers case-insensitively without mutating base headers', function () {
      const baseHeaders: Record<string, string> = {
        authorization: 'Bearer static-token',
        'X-Custom-Header': 'custom-val',
        'content-type': 'application/json',
      };
      const baseSnapshot = { ...baseHeaders };

      const merged = mergeHeadersCaseInsensitive(baseHeaders, {
        Authorization: 'Bearer dynamic-token',
        'x-extra': 'extra-val',
      });

      assert.deepStrictEqual(baseHeaders, baseSnapshot);
      assert.deepStrictEqual(merged, {
        'X-Custom-Header': 'custom-val',
        'content-type': 'application/json',
        Authorization: 'Bearer dynamic-token',
        'x-extra': 'extra-val',
      });
    });

    it('returns copy of base headers when overrideHeaders is undefined or empty', function () {
      const baseHeaders = { foo: 'bar' };
      const merged = mergeHeadersCaseInsensitive(baseHeaders, undefined);
      assert.deepStrictEqual(merged, { foo: 'bar' });
      assert.notStrictEqual(merged, baseHeaders);
    });
  });

  describe('resolveAuthenticatorHeaders', function () {
    it('returns copy of staticHeaders when authenticator is undefined', async function () {
      const staticHeaders = { 'x-static': '1' };
      const headers = await resolveAuthenticatorHeaders(
        undefined,
        staticHeaders
      );
      assert.deepStrictEqual(headers, { 'x-static': '1' });
      assert.notStrictEqual(headers, staticHeaders);
    });

    it('merges authenticator headers case-insensitively over staticHeaders', async function () {
      const staticHeaders = {
        authorization: 'Bearer static',
        'X-Keep': 'true',
      };
      const auth: Authenticator = {
        getHeaders: async () => ({ Authorization: 'Bearer token-123' }),
      };

      const headers = await resolveAuthenticatorHeaders(auth, staticHeaders);

      assert.deepStrictEqual(headers, {
        'X-Keep': 'true',
        Authorization: 'Bearer token-123',
      });
      assert.deepStrictEqual(staticHeaders, {
        authorization: 'Bearer static',
        'X-Keep': 'true',
      });
    });

    it('suppresses tracing when invoking authenticator.getHeaders', async function () {
      context.setGlobalContextManager(new StackContextManager().enable());
      try {
        let suppressedInsideAuth = false;
        const auth: Authenticator = {
          getHeaders: async () => {
            suppressedInsideAuth = isTracingSuppressed(context.active());
            return { Authorization: 'Bearer token' };
          },
        };

        assert.strictEqual(isTracingSuppressed(context.active()), false);
        await resolveAuthenticatorHeaders(auth);
        assert.strictEqual(suppressedInsideAuth, true);
      } finally {
        context.disable();
      }
    });
  });
});

describe('OAuth2Authenticator', function () {
  afterEach(function () {
    sinon.restore();
  });

  describe('constructor validation', function () {
    it('validates required options', function () {
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: '',
            clientId: 'id',
            clientSecret: 'secret',
          }),
        /tokenUrl is required/
      );
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: 'https://auth.example.com/token',
            clientId: '',
            clientSecret: 'secret',
          }),
        /clientId is required/
      );
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'id',
            clientSecret: '' as unknown as string,
          }),
        /clientSecret is required/
      );
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'id',
            clientSecret: 'secret',
            refreshMarginMillis: -5,
          }),
        /refreshMarginMillis must be a non-negative number/
      );
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'id',
            clientSecret: 'secret',
            timeoutMillis: 0,
          }),
        /timeoutMillis must be a positive number/
      );
      assert.throws(
        () =>
          new OAuth2Authenticator({
            tokenUrl: 'https://auth.example.com/token',
            clientId: 'id',
            clientSecret: 'secret',
            authStyle: 'invalid' as unknown as 'header',
          }),
        /authStyle must be 'header' or 'body'/
      );
    });
  });

  describe('token acquisition & caching', function () {
    it('fetches token using client_credentials and Basic auth header by default', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(
          JSON.stringify({
            access_token: 'access-token-1',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'my:client',
        clientSecret: 'my/secret',
        scopes: ['otel.write', 'otel.logs'],
        audience: 'https://collector.example.com',
      });

      const headers1 = await auth.getHeaders();
      const headers2 = await auth.getHeaders();

      assert.deepStrictEqual(headers1, {
        Authorization: 'Bearer access-token-1',
      });
      assert.deepStrictEqual(headers2, {
        Authorization: 'Bearer access-token-1',
      });
      // Cached on second call
      sinon.assert.calledOnce(fetchStub);

      const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
      assert.strictEqual(url, 'https://auth.example.com/oauth/token');
      assert.strictEqual(init.method, 'POST');

      const reqHeaders = init.headers as Record<string, string>;
      const expectedCreds = Buffer.from(
        `${encodeURIComponent('my:client')}:${encodeURIComponent('my/secret')}`,
        'utf8'
      ).toString('base64');
      assert.strictEqual(reqHeaders['Authorization'], `Basic ${expectedCreds}`);
      assert.strictEqual(
        reqHeaders['Content-Type'],
        'application/x-www-form-urlencoded'
      );

      const params = new URLSearchParams(init.body as string);
      assert.strictEqual(params.get('grant_type'), 'client_credentials');
      assert.strictEqual(params.get('scope'), 'otel.write otel.logs');
      assert.strictEqual(
        params.get('audience'),
        'https://collector.example.com'
      );
      assert.strictEqual(params.get('client_id'), null);
      assert.strictEqual(params.get('client_secret'), null);
    });

    it('supports authStyle="body" with credentials in form body', async function () {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(
          JSON.stringify({
            access_token: 'body-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'body-client',
        clientSecret: 'body-secret',
        authStyle: 'body',
      });

      const headers = await auth.getHeaders();
      assert.deepStrictEqual(headers, { Authorization: 'Bearer body-token' });

      const [, init] = fetchStub.firstCall.args as [string, RequestInit];
      const reqHeaders = init.headers as Record<string, string>;
      assert.strictEqual(reqHeaders['Authorization'], undefined);

      const params = new URLSearchParams(init.body as string);
      assert.strictEqual(params.get('grant_type'), 'client_credentials');
      assert.strictEqual(params.get('client_id'), 'body-client');
      assert.strictEqual(params.get('client_secret'), 'body-secret');
    });

    it('proactively refreshes token when within refreshMarginMillis of expiry', async function () {
      const clock = sinon.useFakeTimers({ now: 1_000_000 });
      let tokenCounter = 0;
      const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => {
        tokenCounter++;
        return new Response(
          JSON.stringify({
            access_token: `token-${tokenCounter}`,
            token_type: 'Bearer',
            expires_in: 120, // 120s
          }),
          { status: 200 }
        );
      });

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: 'secret',
        refreshMarginMillis: 30_000, // refresh 30s before 120s expiry (at +90s)
      });

      // t = 0s: fetches token-1
      const h1 = await auth.getHeaders();
      assert.deepStrictEqual(h1, { Authorization: 'Bearer token-1' });
      sinon.assert.calledOnce(fetchStub);

      // t = 89s: still valid (before +90s threshold)
      clock.tick(89_000);
      const h2 = await auth.getHeaders();
      assert.deepStrictEqual(h2, { Authorization: 'Bearer token-1' });
      sinon.assert.calledOnce(fetchStub);

      // t = 91s: within 30s refresh margin -> refreshes to token-2
      clock.tick(2_000);
      const h3 = await auth.getHeaders();
      assert.deepStrictEqual(h3, { Authorization: 'Bearer token-2' });
      sinon.assert.calledTwice(fetchStub);
    });

    it('coalesces concurrent getHeaders calls into a single token fetch (singleflight)', async function () {
      let resolveFetch!: (res: Response) => void;
      const fetchStub = sinon.stub(globalThis, 'fetch').returns(
        new Promise<Response>(resolve => {
          resolveFetch = resolve;
        })
      );

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: 'secret',
      });

      const promises = Array.from({ length: 10 }, () => auth.getHeaders());

      sinon.assert.calledOnce(fetchStub);

      resolveFetch(
        new Response(
          JSON.stringify({
            access_token: 'coalesced-token',
            token_type: 'Bearer',
            expires_in: 600,
          }),
          { status: 200 }
        )
      );

      const results = await Promise.all(promises);
      sinon.assert.calledOnce(fetchStub);
      for (const res of results) {
        assert.deepStrictEqual(res, {
          Authorization: 'Bearer coalesced-token',
        });
      }
    });

    it('enforces configured timeoutMillis on token endpoint requests and recovers on subsequent calls', async function () {
      let callIndex = 0;
      const customFetch = sinon.stub().callsFake(async () => {
        callIndex++;
        if (callIndex === 1) {
          return new Promise<Response>(() => {});
        }
        return new Response(
          JSON.stringify({
            access_token: 'recovered-token',
            expires_in: '1800',
          }),
          { status: 200 }
        );
      });

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: 'secret',
        timeoutMillis: 20,
        fetch: customFetch as unknown as typeof globalThis.fetch,
      });

      await assert.rejects(
        () => auth.getHeaders(),
        /OAuth2Authenticator: token request timed out after 20ms/
      );

      const headers = await auth.getHeaders();
      assert.deepStrictEqual(headers, {
        Authorization: 'Bearer recovered-token',
      });
      sinon.assert.calledTwice(customFetch);
    });

    it('redacts clientSecret from error messages on non-2xx token response', async function () {
      const secret = 'super-sensitive-secret-value-999';
      sinon.stub(globalThis, 'fetch').resolves(
        new Response(`Invalid credentials for secret=${secret}`, {
          status: 401,
        })
      );

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: secret,
      });

      await assert.rejects(
        () => auth.getHeaders(),
        (err: Error) => {
          assert.ok(err.message.includes('status 401'));
          assert.ok(
            !err.message.includes(secret),
            `Expected secret to be redacted from error: ${err.message}`
          );
          assert.ok(err.message.includes('[REDACTED]'));
          return true;
        }
      );
    });

    it('suppresses tracing during token fetch', async function () {
      context.setGlobalContextManager(new StackContextManager().enable());
      try {
        let suppressedDuringTokenFetch = false;
        const customFetch = sinon.stub().callsFake(async () => {
          suppressedDuringTokenFetch = isTracingSuppressed(context.active());
          return new Response(
            JSON.stringify({
              access_token: 'untraced-token',
              expires_in: 300,
            }),
            { status: 200 }
          );
        });

        const auth = new OAuth2Authenticator({
          tokenUrl: 'https://auth.example.com/oauth/token',
          clientId: 'client',
          clientSecret: 'secret',
          fetch: customFetch as unknown as typeof globalThis.fetch,
        });

        const headers = await auth.getHeaders();
        assert.deepStrictEqual(headers, {
          Authorization: 'Bearer untraced-token',
        });
        sinon.assert.calledOnce(customFetch);
        assert.strictEqual(suppressedDuringTokenFetch, true);
      } finally {
        context.disable();
      }
    });

    it('shuts down idempotently, aborts in-flight requests, and rejects subsequent getHeaders calls', async function () {
      sinon.stub(globalThis, 'fetch').resolves(
        new Response(
          JSON.stringify({
            access_token: 'tok-1',
            expires_in: 3600,
          }),
          { status: 200 }
        )
      );

      const auth = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: 'secret',
      });

      await auth.getHeaders();
      await auth.shutdown();
      await auth.shutdown(); // idempotent second call

      await assert.rejects(
        () => auth.getHeaders(),
        /authenticator has been shut down/
      );

      const auth2 = new OAuth2Authenticator({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client',
        clientSecret: 'secret',
        fetch: (() =>
          new Promise<Response>(
            () => {}
          )) as unknown as typeof globalThis.fetch,
      });
      const pendingWaiter = auth2.getHeaders();
      await auth2.shutdown();
      await assert.rejects(
        () => pendingWaiter,
        /OAuth2Authenticator: authenticator has been shut down/
      );
    });
  });
});

describe('FetchTransport with Authenticator', function () {
  afterEach(function () {
    sinon.restore();
  });

  it('merges authenticator headers case-insensitively over static headers without mutating static headers', async function () {
    const fetchStub = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response('', { status: 200 }));

    const staticHeaders: Record<string, string> = {
      authorization: 'Bearer static-token',
      'X-Static': '1',
    };
    const staticSnapshot = { ...staticHeaders };

    let callCount = 0;
    const authenticator: Authenticator = {
      getHeaders: async () => {
        callCount++;
        return {
          Authorization: `Bearer dynamic-${callCount}`,
        };
      },
      shutdown: sinon.stub(),
    };

    const transport = createFetchTransport({
      url: 'http://collector.example.com/v1/traces',
      headers: async () => staticHeaders,
      authenticator,
    });

    const res1 = await transport.send(Uint8Array.from([1, 2]), 2000);
    const res2 = await transport.send(Uint8Array.from([3, 4]), 2000);

    assert.strictEqual(res1.status, 'success');
    assert.strictEqual(res2.status, 'success');
    assert.deepStrictEqual(staticHeaders, staticSnapshot);

    const sentHeaders1 = (fetchStub.firstCall.args[1] as RequestInit)
      .headers as Record<string, string>;
    const sentHeaders2 = (fetchStub.secondCall.args[1] as RequestInit)
      .headers as Record<string, string>;

    assert.deepStrictEqual(sentHeaders1, {
      'X-Static': '1',
      Authorization: 'Bearer dynamic-1',
    });
    assert.deepStrictEqual(sentHeaders2, {
      'X-Static': '1',
      Authorization: 'Bearer dynamic-2',
    });

    await transport.shutdown();
    sinon.assert.calledOnce(authenticator.shutdown as sinon.SinonStub);
  });

  it('returns failure response when authenticator throws or rejects', async function () {
    const fetchStub = sinon.stub(globalThis, 'fetch');
    const authError = new Error('token fetch failed');
    const authenticator: Authenticator = {
      getHeaders: async () => {
        throw authError;
      },
    };

    const transport = createFetchTransport({
      url: 'http://collector.example.com/v1/traces',
      headers: async () => ({}),
      authenticator,
    });

    const res = await transport.send(Uint8Array.from([1, 2]), 2000);
    assert.strictEqual(res.status, 'failure');
    assert.strictEqual((res as ExportResponseFailure).error, authError);
    sinon.assert.notCalled(fetchStub);
  });
});
