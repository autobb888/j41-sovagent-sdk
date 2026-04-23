import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalBytes,
  validateEnvelope,
  signCanonical,
  buildRequestAccessEnvelope,
  CanonicalError,
  CANONICAL_MAX_BYTES,
  ACTION_MAX_WINDOW_MS,
  EnvelopeV1,
} from '../src/crypto/canonical.js';

// Golden vector from docs/spec/api-session-signing-v2.md (rev 2.1, d696135).
// Backend's reference canonicalization. Byte-identical match required.
const GOLDEN_ENVELOPE: EnvelopeV1 = {
  version: 1,
  cryptoSuite: 'verus-signmessage-v1',
  action: 'request-access',
  buyer: { iaddress: 'iAj47bLxABCDEFGHJKLMNPQRSTUVWXYZ12' },
  seller: { iaddress: 'i6od3pyPABCDEFGHJKLMNPQRSTUVWXYZ12' },
  payload: { ephemeralPubKey: '02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  issuedAt: '2026-04-23T14:00:00.000Z',
  expiresAt: '2026-04-23T14:01:00.000Z',
};

const GOLDEN_BYTES =
  '{"action":"request-access","buyer":{"iaddress":"iAj47bLxABCDEFGHJKLMNPQRSTUVWXYZ12"},"cryptoSuite":"verus-signmessage-v1",' +
  '"expiresAt":"2026-04-23T14:01:00.000Z","issuedAt":"2026-04-23T14:00:00.000Z",' +
  '"nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"payload":{"ephemeralPubKey":"02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},' +
  '"seller":{"iaddress":"i6od3pyPABCDEFGHJKLMNPQRSTUVWXYZ12"},"version":1}';

// Inject deterministic "now" that's inside the golden envelope's window.
const NOW_INSIDE_GOLDEN = Date.parse('2026-04-23T14:00:30.000Z');

test('canonicalBytes matches backend golden vector byte-for-byte', () => {
  const bytes = canonicalBytes(GOLDEN_ENVELOPE);
  assert.equal(bytes.toString('utf8'), GOLDEN_BYTES);
});

test('canonicalBytes is insertion-order insensitive', () => {
  const reordered: EnvelopeV1 = {
    expiresAt: GOLDEN_ENVELOPE.expiresAt,
    payload: GOLDEN_ENVELOPE.payload,
    nonce: GOLDEN_ENVELOPE.nonce,
    version: 1,
    seller: GOLDEN_ENVELOPE.seller,
    action: GOLDEN_ENVELOPE.action,
    buyer: GOLDEN_ENVELOPE.buyer,
    issuedAt: GOLDEN_ENVELOPE.issuedAt,
    cryptoSuite: GOLDEN_ENVELOPE.cryptoSuite,
  } as EnvelopeV1;
  assert.equal(canonicalBytes(reordered).toString('utf8'), GOLDEN_BYTES);
});

test('canonicalBytes throws CANONICAL_TOO_LARGE when over cap', () => {
  const huge: EnvelopeV1 = {
    ...GOLDEN_ENVELOPE,
    payload: { blob: 'x'.repeat(CANONICAL_MAX_BYTES + 100) },
  };
  assert.throws(() => canonicalBytes(huge), (e: Error) => {
    assert.ok(e instanceof CanonicalError);
    assert.equal((e as CanonicalError).code, 'CANONICAL_TOO_LARGE');
    return true;
  });
});

// ── validateEnvelope — 14-step flow error paths ──

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (e: Error) => {
    assert.ok(e instanceof CanonicalError, `expected CanonicalError, got ${e?.constructor?.name}: ${e?.message}`);
    assert.equal((e as CanonicalError).code, code);
    return true;
  });
}

test('rejects non-object envelope', () => {
  // @ts-expect-error
  expectCode(() => validateEnvelope(null), 'INVALID_BODY');
  // @ts-expect-error
  expectCode(() => validateEnvelope([]), 'INVALID_BODY');
});

test('rejects UNEXPECTED_FIELD on unknown top-level key', () => {
  const bad = { ...GOLDEN_ENVELOPE, surprise: 'hello' } as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'UNEXPECTED_FIELD');
});

test('rejects UNEXPECTED_FIELD on unknown buyer sub-key', () => {
  const bad = { ...GOLDEN_ENVELOPE, buyer: { ...GOLDEN_ENVELOPE.buyer, surprise: 'x' } } as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'UNEXPECTED_FIELD');
});

test('rejects UNSUPPORTED_VERSION on wrong version', () => {
  const bad = { ...GOLDEN_ENVELOPE, version: 2 } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'UNSUPPORTED_VERSION');
});

test('rejects UNSUPPORTED_SUITE on unknown cryptoSuite', () => {
  const bad = { ...GOLDEN_ENVELOPE, cryptoSuite: 'verus-viewing-key-v1' } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'UNSUPPORTED_SUITE');
});

test('rejects UNKNOWN_ACTION on unknown action', () => {
  const bad = { ...GOLDEN_ENVELOPE, action: 'bogus-action' } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'UNKNOWN_ACTION');
});

test('rejects INVALID_BODY on bad iaddress format', () => {
  const bad = { ...GOLDEN_ENVELOPE, buyer: { iaddress: 'R-this-is-an-Raddr-not-iaddr' } } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'INVALID_BODY');
});

test('rejects INVALID_BODY on non-hex nonce', () => {
  const bad = { ...GOLDEN_ENVELOPE, nonce: 'not-hex-chars' + 'x'.repeat(18) } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'INVALID_BODY');
});

test('rejects INVALID_BODY on non-ms-precision timestamp', () => {
  const bad = { ...GOLDEN_ENVELOPE, issuedAt: '2026-04-23T14:00:00Z' } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'INVALID_BODY');
});

test('rejects INVALID_BODY on offset (non-Z) timestamp', () => {
  const bad = { ...GOLDEN_ENVELOPE, expiresAt: '2026-04-23T14:01:00.000+00:00' } as unknown as EnvelopeV1;
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'INVALID_BODY');
});

test('rejects EXPIRES_BEFORE_ISSUED when expiresAt <= issuedAt', () => {
  const bad = { ...GOLDEN_ENVELOPE, expiresAt: GOLDEN_ENVELOPE.issuedAt };
  expectCode(() => validateEnvelope(bad, NOW_INSIDE_GOLDEN), 'EXPIRES_BEFORE_ISSUED');
});

test('rejects EXPIRES_TOO_FAR for request-access > 5min window', () => {
  const issued = Date.parse('2026-04-23T14:00:00.000Z');
  const bad = {
    ...GOLDEN_ENVELOPE,
    expiresAt: new Date(issued + ACTION_MAX_WINDOW_MS['request-access'] + 1000).toISOString(),
  };
  expectCode(() => validateEnvelope(bad, issued), 'EXPIRES_TOO_FAR');
});

test('accepts 7-day window on review-submit but not 8 days', () => {
  const issued = Date.parse('2026-04-23T14:00:00.000Z');
  const within: EnvelopeV1 = {
    ...GOLDEN_ENVELOPE,
    action: 'review-submit',
    payload: { jobId: 'abc', rating: 5 },
    expiresAt: new Date(issued + 7 * 24 * 60 * 60 * 1000 - 1).toISOString().replace(/Z$/, 'Z'),
  };
  assert.doesNotThrow(() => validateEnvelope(within, issued));

  const over: EnvelopeV1 = {
    ...within,
    expiresAt: new Date(issued + 8 * 24 * 60 * 60 * 1000).toISOString().replace(/Z$/, 'Z'),
  };
  expectCode(() => validateEnvelope(over, issued), 'EXPIRES_TOO_FAR');
});

test('rejects EXPIRED when now > expiresAt + 300s skew', () => {
  const past = Date.parse(GOLDEN_ENVELOPE.expiresAt) + 301_000;
  expectCode(() => validateEnvelope(GOLDEN_ENVELOPE, past), 'EXPIRED');
});

test('accepts within 300s expiry skew window', () => {
  const withinSkew = Date.parse(GOLDEN_ENVELOPE.expiresAt) + 299_000;
  assert.doesNotThrow(() => validateEnvelope(GOLDEN_ENVELOPE, withinSkew));
});

test('rejects ISSUED_IN_FUTURE when issuedAt > now + 300s', () => {
  const earlier = Date.parse(GOLDEN_ENVELOPE.issuedAt) - 301_000;
  expectCode(() => validateEnvelope(GOLDEN_ENVELOPE, earlier), 'ISSUED_IN_FUTURE');
});

test('golden envelope validates at deterministic time', () => {
  assert.doesNotThrow(() => validateEnvelope(GOLDEN_ENVELOPE, NOW_INSIDE_GOLDEN));
});

// ── signCanonical integration ──

test('signCanonical returns { envelope, signatures: [sig] } with one base64 signature', () => {
  // Real WIF from the project's test keys (agent-2). Safe to use — testnet-only.
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const keys = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.j41/dispatcher/agents/agent-2/keys.json'), 'utf8'));

  // Build with current time (signCanonical uses Date.now() internally via validateEnvelope).
  const envelope = buildRequestAccessEnvelope({
    buyerIAddress: keys.iAddress,
    sellerIAddress: 'i6od3pyPABCDEFGHJKLMNPQRSTUVWXYZ12',
    ephemeralPubKey: '02' + 'a'.repeat(64),
  });

  const signed = signCanonical(keys.wif, envelope, 'verustest');
  assert.ok(Array.isArray(signed.signatures));
  assert.equal(signed.signatures.length, 1);
  assert.ok(typeof signed.signatures[0] === 'string');
  assert.ok(signed.signatures[0].length > 0);
  // Base64 round-trip check.
  assert.ok(Buffer.from(signed.signatures[0], 'base64').length > 0);
  assert.equal(signed.envelope.version, 1);
});

test('buildRequestAccessEnvelope produces a validated envelope with 60s default ttl', () => {
  const env = buildRequestAccessEnvelope({
    buyerIAddress: 'iAj47bLxABCDEFGHJKLMNPQRSTUVWXYZ12',
    sellerIAddress: 'i6od3pyPABCDEFGHJKLMNPQRSTUVWXYZ12',
    ephemeralPubKey: '02' + 'a'.repeat(64),
  });
  assert.doesNotThrow(() => validateEnvelope(env));
  const window = Date.parse(env.expiresAt) - Date.parse(env.issuedAt);
  assert.equal(window, 60_000);
  assert.equal(env.action, 'request-access');
  assert.equal(env.cryptoSuite, 'verus-signmessage-v1');
});

test('buildRequestAccessEnvelope caps ttl at 300s', () => {
  const env = buildRequestAccessEnvelope({
    buyerIAddress: 'iAj47bLxABCDEFGHJKLMNPQRSTUVWXYZ12',
    sellerIAddress: 'i6od3pyPABCDEFGHJKLMNPQRSTUVWXYZ12',
    ephemeralPubKey: '02' + 'a'.repeat(64),
    ttlSeconds: 9999,
  });
  const window = Date.parse(env.expiresAt) - Date.parse(env.issuedAt);
  assert.equal(window, 300_000);
});
