/**
 * Regression test: J41Client.authenticateWithWIF uses /auth/consent/* endpoints.
 *
 * Uses Node's built-in test runner (node:test) with tsx.
 * Stubs global.fetch so no network calls are made.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Client } = require('../dist/client/index.js');
const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Response-like object whose body goes through getReader()
 * (what _doRequest uses for GET calls) AND whose .json() works directly
 * (what authenticateWithWIF uses for the verify POST).
 */
function fakeRes({
  status = 200,
  json = {} as Record<string, unknown>,
  setCookie = null as string | null,
  contentLength = null as string | null,
} = {}) {
  const bodyBytes = Buffer.from(JSON.stringify(json));

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    // Used by _doRequest's streaming reader path
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (!sent) {
              sent = true;
              return { value: bodyBytes, done: false };
            }
            return { value: undefined, done: true };
          },
          cancel: async () => {},
        };
      },
      cancel: async () => {},
    },
    // Used by authenticateWithWIF for the verify POST
    json: async () => json,
    headers: {
      get(k: string) {
        const key = k.toLowerCase();
        if (key === 'set-cookie') return setCookie;
        if (key === 'content-length') return contentLength;
        return null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('J41Client — consent login (/auth/consent/*)', () => {
  it('authenticateWithWIF hits /auth/consent/challenge then /auth/consent/verify and returns the signed cookie', async () => {
    const kp = generateKeypair('verustest');

    const client = new J41Client({ apiUrl: 'https://api.example.com' });

    const calls: { url: string; method: string; body: unknown }[] = [];
    const originalFetch = (globalThis as any).fetch;

    try {
      (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method: (init.method || 'GET').toUpperCase(), body });

        if (url.endsWith('/auth/consent/challenge')) {
          return fakeRes({
            json: {
              data: {
                challengeId: 'iChalTest',
                challengeHash: 'a'.repeat(64),
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            },
          });
        }

        if (url.endsWith('/auth/consent/verify')) {
          return fakeRes({
            json: {
              data: {
                success: true,
                identityAddress: 'iAddrTest',
                identityName: 'test@',
                sessionToken: 'rawtok',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
            },
            setCookie: 'verus_session=SIGNEDCOOKIEVALUE; Path=/; HttpOnly',
          });
        }

        throw new Error(`Unexpected fetch call: ${url}`);
      };

      const returnedToken = await client.authenticateWithWIF(kp.wif, 'test@', 'verustest');

      // ---- URL routing assertions ----
      assert.strictEqual(calls.length, 2, 'Expected exactly 2 fetch calls');

      const [challengeCall, verifyCall] = calls;
      assert.ok(
        challengeCall.url.endsWith('/auth/consent/challenge'),
        `First call should hit /auth/consent/challenge, got: ${challengeCall.url}`,
      );
      assert.ok(
        verifyCall.url.endsWith('/auth/consent/verify'),
        `Second call should hit /auth/consent/verify, got: ${verifyCall.url}`,
      );

      // Confirm legacy endpoints were NOT called
      for (const call of calls) {
        assert.ok(
          !call.url.includes('/auth/login'),
          `Should not call /auth/login (got: ${call.url})`,
        );
        assert.ok(
          !call.url.includes('/auth/challenge') || call.url.includes('/consent/challenge'),
          `Should not call legacy /auth/challenge (got: ${call.url})`,
        );
      }

      // ---- Verify POST body assertions ----
      const verifyBody = verifyCall.body as Record<string, unknown>;
      assert.strictEqual(verifyBody.challengeId, 'iChalTest', 'POST body should include challengeId');
      assert.strictEqual(verifyBody.verusId, 'test@', 'POST body should include verusId');
      assert.ok(
        typeof verifyBody.signature === 'string' && verifyBody.signature.length > 0,
        'POST body should include a non-empty signature string',
      );

      // ---- Session token assertions ----
      // The SDK must extract the cookie value (SIGNEDCOOKIEVALUE), NOT the body's sessionToken (rawtok)
      assert.strictEqual(
        returnedToken,
        'SIGNEDCOOKIEVALUE',
        'Return value should be the verus_session cookie value, not the body sessionToken',
      );
      assert.strictEqual(
        client.getSessionToken(),
        'SIGNEDCOOKIEVALUE',
        'client.getSessionToken() should equal the signed cookie value',
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('authenticateWithWIF throws when no set-cookie header is returned', async () => {
    const kp = generateKeypair('verustest');
    const client = new J41Client({ apiUrl: 'https://api.example.com' });
    const originalFetch = (globalThis as any).fetch;

    try {
      (globalThis as any).fetch = async (url: string, _init: RequestInit = {}) => {
        if (url.endsWith('/auth/consent/challenge')) {
          return fakeRes({
            json: {
              data: {
                challengeId: 'iChalTest2',
                challengeHash: 'b'.repeat(64),
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            },
          });
        }
        if (url.endsWith('/auth/consent/verify')) {
          // No set-cookie header
          return fakeRes({
            json: { data: { success: true, identityAddress: 'iAddrTest', identityName: 'test@', expiresAt: '' } },
            setCookie: null,
          });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      };

      await assert.rejects(
        () => client.authenticateWithWIF(kp.wif, 'test@', 'verustest'),
        /no session cookie/i,
        'Should throw AUTH_FAILED when set-cookie is absent',
      );
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// J41Agent._loginImpl — consent path (dispatcher's login path + broker-signer routing)
// ---------------------------------------------------------------------------

describe('J41Agent._loginImpl — consent login path', () => {
  it('agent authenticate() routes signing through remote signer and extracts verus_session cookie', async () => {
    const CHALLENGE_HASH = 'a'.repeat(64);
    const signedMessages: string[] = [];

    const signer = {
      async signMessage(msg: string): Promise<string> {
        signedMessages.push(msg);
        return 'FAKESIG_AGENT';
      },
      async signBrokered(_req: any): Promise<any> {
        return { signature: 'sig:brok', timestamp: 0, message: '' };
      },
    };

    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      identityName: 'test@',
      network: 'verustest',
      signer,
    });

    // Stub getConsentChallenge so no real HTTP is made
    agent.client.getConsentChallenge = async () => ({
      challengeId: 'iChalTest',
      challengeHash: CHALLENGE_HASH,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const verifyUrls: string[] = [];
    const originalFetch = (globalThis as any).fetch;

    try {
      (globalThis as any).fetch = async (url: string, init: RequestInit = {}) => {
        verifyUrls.push(url);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {
            get(k: string) {
              if (k.toLowerCase() === 'set-cookie') return 'verus_session=AGENTCOOKIE; Path=/; HttpOnly';
              return null;
            },
          },
          async json() {
            return {
              data: {
                success: true,
                identityAddress: 'iAddr',
                identityName: 'test@',
                sessionToken: 'rawtok',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
            };
          },
        };
      };

      await agent.authenticate();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }

    // 1. Remote signer's signMessage was called with the challengeHash
    assert.strictEqual(signedMessages.length, 1, 'signer.signMessage should be called exactly once');
    assert.strictEqual(signedMessages[0], CHALLENGE_HASH, 'signer.signMessage should receive the challengeHash');

    // 2. The POST hit /auth/consent/verify (NOT /auth/login)
    assert.strictEqual(verifyUrls.length, 1, 'Expected exactly 1 fetch call (the verify POST)');
    assert.ok(
      verifyUrls[0].endsWith('/auth/consent/verify'),
      `POST should target /auth/consent/verify, got: ${verifyUrls[0]}`,
    );
    assert.ok(
      !verifyUrls[0].includes('/auth/login'),
      `Should NOT call /auth/login, got: ${verifyUrls[0]}`,
    );

    // 3. Session token is extracted from the cookie, not from the body's sessionToken
    assert.strictEqual(
      agent.client.getSessionToken(),
      'AGENTCOOKIE',
      'getSessionToken() should return the verus_session cookie value, not the body sessionToken',
    );
  });
});
