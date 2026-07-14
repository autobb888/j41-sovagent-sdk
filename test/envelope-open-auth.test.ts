// test/envelope-open-auth.test.ts
// SECURITY: the envelope open path must AUTHENTICATE the seller signature before
// decrypting. J41 is only a semi-trusted relay — it sees the buyer's plaintext
// ephemeralPubKey, so it can mint its OWN envelope whose ciphertext decrypts
// perfectly. The ONLY thing that binds the payload (apiKey + endpointUrl) to the
// seller the buyer chose is the dispatcher signature over the seller's on-chain
// R-address. openAccessEnvelope must verify it and fail closed on a forgery.
//
// This suite fails if anyone reverts the mandatory authenticity check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEphemeralKeypair,
  buildAccessRequest,
  mintAccessEnvelope,
  openAccessEnvelope,
  openVerifiedAccessEnvelope,
} from '../src/crypto/envelope.js';
import { generateKeypair } from '../src/identity/keypair.js';

const NET = 'verustest';

// Stub client: resolves any seller lookup to a fixed set of primary R-addresses,
// matching the getAgent fallback verifyAccessEnvelope uses when getIdentityKeys
// is absent (same shape as the existing envelope-replay test suite).
const clientFor = (addr: string) => ({ getAgent: async () => ({ primaryAddresses: [addr] }) });
const isoIn = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

test('open path decrypts a genuine, seller-signed envelope', async () => {
  const buyer = generateKeypair(NET);
  const seller = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, seller.address, eph.publicKey, NET);
  const env = mintAccessEnvelope(
    req,
    seller.wif,
    { apiKey: 'sk-real', endpointUrl: 'https://good/v1', expiresAt: isoIn(3600), models: [] },
    NET,
  );

  const grant = await openAccessEnvelope(env, eph.privateKey, req.nonce, {
    client: clientFor(seller.address),
    sellerVerusId: seller.address,
    network: NET,
  });
  assert.equal(grant.apiKey, 'sk-real');
  assert.equal(grant.endpointUrl, 'https://good/v1');
});

test('open path REJECTS a relay-forged envelope (attacker key != expected seller)', async () => {
  // The concrete exploit: the buyer signs an AccessRequest for `seller`; the relay
  // (attacker) reads the plaintext ephemeralPubKey and mints its own envelope
  // — same ECDH shared key, its own pubkey + signature, an evil endpointUrl.
  const buyer = generateKeypair(NET);
  const seller = generateKeypair(NET);   // whom the buyer intended to buy from
  const attacker = generateKeypair(NET); // the J41 relay in the middle
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, seller.address, eph.publicKey, NET);

  const forged = mintAccessEnvelope(
    req,
    attacker.wif,
    { apiKey: 'attacker-key', endpointUrl: 'https://evil', expiresAt: isoIn(3600), models: [] },
    NET,
  );

  // Buyer authenticates against the EXPECTED seller → must throw (fail closed).
  await assert.rejects(
    openAccessEnvelope(forged, eph.privateKey, req.nonce, {
      client: clientFor(seller.address),
      sellerVerusId: seller.address,
      network: NET,
    }),
    /signature verification|refusing to decrypt/i,
  );

  // Proof the rejection is AUTHENTICITY, not a decrypt failure: the very same
  // forged envelope decrypts cleanly if we (wrongly) trust the attacker as the
  // seller. The ECDH/GCM layer is intact — the signature gate is the only thing
  // standing between the buyer and the attacker's payload.
  const leaked = await openAccessEnvelope(forged, eph.privateKey, req.nonce, {
    client: clientFor(attacker.address),
    sellerVerusId: attacker.address,
    network: NET,
  });
  assert.equal(leaked.endpointUrl, 'https://evil');
  assert.equal(leaked.apiKey, 'attacker-key');
});

test('open path fails closed when no verification context is supplied', async () => {
  const buyer = generateKeypair(NET);
  const seller = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, seller.address, eph.publicKey, NET);
  const env = mintAccessEnvelope(
    req,
    seller.wif,
    { apiKey: 'sk', endpointUrl: 'https://good/v1', expiresAt: isoIn(3600), models: [] },
    NET,
  );
  // Cast away the type to exercise the runtime guard against the old 3-arg form.
  await assert.rejects(
    (openAccessEnvelope as any)(env, eph.privateKey, req.nonce),
    /requires a verification context/i,
  );
});

test('openVerifiedAccessEnvelope alias enforces the same authenticity gate', async () => {
  const buyer = generateKeypair(NET);
  const seller = generateKeypair(NET);
  const attacker = generateKeypair(NET);
  const eph = generateEphemeralKeypair();
  const req = buildAccessRequest(buyer.wif, seller.address, eph.publicKey, NET);
  const forged = mintAccessEnvelope(
    req,
    attacker.wif,
    { apiKey: 'x', endpointUrl: 'https://evil', expiresAt: isoIn(3600), models: [] },
    NET,
  );
  await assert.rejects(
    openVerifiedAccessEnvelope(forged, eph.privateKey, req.nonce, {
      client: clientFor(seller.address),
      sellerVerusId: seller.address,
      network: NET,
    }),
    /signature verification|refusing to decrypt/i,
  );
});
