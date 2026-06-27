// test/keys-endpoint-pin.test.ts
// When J41_PLATFORM_SIGNER is pinned, getIdentityKeys must require + verify a
// platformSignature over the JCS-canonical response (trust-anchor hardening).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from 'json-canonicalize';
import { J41Client } from '../src/client/index.js';
import { generateKeypair, signMessage } from '../src/index.js';

const NET = 'verustest';

// Build a client whose HTTP layer returns a fixed payload.
function clientReturning(payload: unknown): J41Client {
  const c = new J41Client({ apiUrl: 'https://example.test' });
  (c as any).request = async () => ({ data: payload });
  return c;
}

afterEach(() => { delete process.env.J41_PLATFORM_SIGNER; });

const baseData = { iaddress: 'iVictim', name: 'victim@', primaryAddresses: ['Rgenuine'], minimumSignatures: 1 };

test('no pin set → no enforcement (back-compat)', async () => {
  delete process.env.J41_PLATFORM_SIGNER;
  const c = clientReturning(baseData);
  const r = await c.getIdentityKeys('victim@');
  assert.deepEqual(r.primaryAddresses, ['Rgenuine']);
});

test('pinned signer + valid signature → accepted', async () => {
  const platform = generateKeypair(NET);
  process.env.J41_PLATFORM_SIGNER = platform.address;
  const platformSignature = signMessage(platform.wif, canonicalize(baseData), NET);
  const c = clientReturning({ ...baseData, platformSignature });
  const r = await c.getIdentityKeys('victim@');
  assert.deepEqual(r.primaryAddresses, ['Rgenuine']);
});

test('pinned signer + unsigned response → rejected', async () => {
  process.env.J41_PLATFORM_SIGNER = generateKeypair(NET).address;
  const c = clientReturning(baseData); // no platformSignature
  await assert.rejects(c.getIdentityKeys('victim@'), (e: any) => e.code === 'KEYS_UNSIGNED');
});

test('pinned signer + TAMPERED primaryAddresses → rejected (MITM defense)', async () => {
  const platform = generateKeypair(NET);
  process.env.J41_PLATFORM_SIGNER = platform.address;
  // Platform signed the genuine data...
  const platformSignature = signMessage(platform.wif, canonicalize(baseData), NET);
  // ...but a MITM swaps in attacker-controlled addresses while keeping the sig.
  const tampered = { ...baseData, primaryAddresses: ['Rattacker'], platformSignature };
  const c = clientReturning(tampered);
  await assert.rejects(c.getIdentityKeys('victim@'), (e: any) => e.code === 'KEYS_BAD_SIGNATURE');
});

test('pinned signer + signature from the WRONG key → rejected', async () => {
  process.env.J41_PLATFORM_SIGNER = generateKeypair(NET).address; // pin one key
  const attacker = generateKeypair(NET);                          // sign with another
  const platformSignature = signMessage(attacker.wif, canonicalize(baseData), NET);
  const c = clientReturning({ ...baseData, platformSignature });
  await assert.rejects(c.getIdentityKeys('victim@'), (e: any) => e.code === 'KEYS_BAD_SIGNATURE');
});

test('getIdentityKeys refuses on mainnet when no platform signer is pinned (no env bypass)', async () => {
  const prevPin = process.env.J41_PLATFORM_SIGNER;
  const prevReq = process.env.J41_REQUIRE_PLATFORM_SIGNER;
  const prevNet = process.env.J41_NETWORK;
  delete process.env.J41_PLATFORM_SIGNER;
  process.env.J41_REQUIRE_PLATFORM_SIGNER = '0'; // the (now-removed) bypass
  process.env.J41_NETWORK = 'verus';
  try {
    const client = new J41Client({ apiUrl: 'https://api.junction41.io' });
    await assert.rejects(() => client.getIdentityKeys('example@'), (e: any) => e.code === 'PLATFORM_SIGNER_REQUIRED');
  } finally {
    if (prevPin === undefined) delete process.env.J41_PLATFORM_SIGNER; else process.env.J41_PLATFORM_SIGNER = prevPin;
    if (prevReq === undefined) delete process.env.J41_REQUIRE_PLATFORM_SIGNER; else process.env.J41_REQUIRE_PLATFORM_SIGNER = prevReq;
    if (prevNet === undefined) delete process.env.J41_NETWORK; else process.env.J41_NETWORK = prevNet;
  }
});
