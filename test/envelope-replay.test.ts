// test/envelope-replay.test.ts
// HIGH-1: access requests/envelopes must enforce freshness, expiry, and replay
// — a valid signature alone must not make a stale/expired/replayed message pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEphemeralKeypair,
  buildAccessRequest,
  mintAccessEnvelope,
  verifyAccessRequest,
  verifyAccessEnvelope,
} from '../src/crypto/envelope.js';
import { generateKeypair } from '../src/identity/keypair.js';

const NET = 'verustest';
const stubClient = { getAgent: async () => ({}) };

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function makeEnvelope(expiresAt: string) {
  const buyer = generateKeypair(NET);
  const disp = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, disp.address, eph.publicKey, NET);
  const env = mintAccessEnvelope(req, disp.wif, { apiKey: 'sk-test', endpointUrl: 'https://x/v1', expiresAt, models: [] }, NET);
  const client = { getAgent: async () => ({ primaryAddresses: [disp.address] }) };
  return { env, client, dispVerusId: disp.address };
}

// ── verifyAccessRequest: freshness + replay ──

test('accepts a fresh, validly-signed access request', async () => {
  const buyer = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, 'iSeller', eph.publicKey, NET);
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp }), true);
});

test('rejects a stale access request (replay window exceeded)', async () => {
  const buyer = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, 'iSeller', eph.publicKey, NET);
  // Verify "now" far past the signed timestamp → stale.
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp + 10_000 }), false);
});

test('rejects a future-dated access request', async () => {
  const buyer = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, 'iSeller', eph.publicKey, NET);
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp - 10_000 }), false);
});

test('rejects a replayed access request via the isReplay hook', async () => {
  const buyer = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, 'iSeller', eph.publicKey, NET);
  const seen = new Set<string>();
  const isReplay = (nonce: string) => { if (seen.has(nonce)) return true; seen.add(nonce); return false; };
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp, isReplay }), true);
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp, isReplay }), false);
});

test('rejects a tampered access request even within the window', async () => {
  const buyer = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, 'iSeller', eph.publicKey, NET);
  req.nonce = 'deadbeef'.repeat(4); // signature no longer matches
  assert.equal(await verifyAccessRequest(req, stubClient, NET, { now: req.timestamp }), false);
});

// ── verifyAccessEnvelope: expiry ──

test('accepts a validly-signed, unexpired envelope', async () => {
  const { env, client, dispVerusId } = makeEnvelope(isoIn(3600));
  assert.equal(await verifyAccessEnvelope(env, client, dispVerusId, NET), true);
});

test('rejects an expired envelope despite a valid signature', async () => {
  const { env, client, dispVerusId } = makeEnvelope(isoIn(-60)); // expired 1 min ago
  assert.equal(await verifyAccessEnvelope(env, client, dispVerusId, NET), false);
});

test('rejects an envelope with an unparseable expiresAt', async () => {
  const { env, client, dispVerusId } = makeEnvelope('not-a-date');
  assert.equal(await verifyAccessEnvelope(env, client, dispVerusId, NET), false);
});

test('rejects an envelope timestamped implausibly in the future', async () => {
  const { env, client, dispVerusId } = makeEnvelope(isoIn(3600));
  const future = { ...env, timestamp: Math.floor(Date.now() / 1000) + 10_000 };
  // Signature won't match the mutated timestamp, but the skew guard rejects first regardless.
  assert.equal(await verifyAccessEnvelope(future, client, dispVerusId, NET), false);
});
