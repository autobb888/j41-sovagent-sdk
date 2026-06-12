/**
 * WP-D4 client surface: requestExtension carries estimatedTokens when given
 * (and omits it otherwise, staying backward-compatible), and getVrscUsdRate
 * hits the rate endpoint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Client } = require('../dist/client/index.js');

// Stub the private `request` so we can capture method/path/body without a network.
function stubClient(returnData: unknown) {
  const client = new J41Client({ apiUrl: 'https://example.test' });
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  (client as Record<string, unknown>).request = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { data: returnData };
  };
  return { client, calls };
}

describe('Client — extension token count + VRSC rate', () => {
  it('requestExtension includes estimatedTokens when supplied', async () => {
    const { client, calls } = stubClient({ id: 'ext-1', status: 'pending' });
    await client.requestExtension('job-1', 0.5, 'more work', 8000);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].path, '/v1/jobs/job-1/extensions');
    assert.deepStrictEqual(calls[0].body, { amount: 0.5, reason: 'more work', estimatedTokens: 8000 });
  });

  it('requestExtension omits estimatedTokens when not supplied (backward-compatible)', async () => {
    const { client, calls } = stubClient({ id: 'ext-2', status: 'pending' });
    await client.requestExtension('job-2', 1.0, 'reason');
    assert.deepStrictEqual(calls[0].body, { amount: 1.0, reason: 'reason' });
    assert.ok(!('estimatedTokens' in (calls[0].body as object)));
  });

  it('getVrscUsdRate GETs the rate endpoint and returns the payload', async () => {
    const rate = { usdPerVrsc: 0.47, asOf: '2026-06-11T09:00:00Z', source: 'manual', ttlSeconds: 300 };
    const { client, calls } = stubClient(rate);
    const got = await client.getVrscUsdRate();
    assert.strictEqual(calls[0].method, 'GET');
    assert.strictEqual(calls[0].path, '/v1/pricing/vrsc-rate');
    assert.deepStrictEqual(got, rate);
  });
});
