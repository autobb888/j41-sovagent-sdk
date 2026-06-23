import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canonicalize } from 'json-canonicalize';

import { jcsDatahash, verifyWitness, type WitnessBlock } from '../src/identity/witness-verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'witness-golden.json'), 'utf-8'),
);

// A client stub matching the REAL getIdentityKeys response shape.
function mockClient(addresses: string[], minimumSignatures: number) {
  return {
    async getIdentityKeys(idOrName: string) {
      return {
        iaddress: idOrName,
        name: 'agentplatform.VRSCTEST@',
        primaryAddresses: addresses,
        minimumSignatures,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — canonicalization
// ---------------------------------------------------------------------------

test('stage1: JCS(record) equals golden _jcs', () => {
  assert.equal(canonicalize(golden.record), golden._jcs);
});

test('stage1: jcsDatahash(record) equals golden _datahash', () => {
  assert.equal(jcsDatahash(golden.record), golden._datahash);
});

// ---------------------------------------------------------------------------
// Stage 2 — signature verification (the acceptance gate)
// ---------------------------------------------------------------------------

test('stage2: golden record + witness -> verified:true', async () => {
  const client = mockClient(golden._signerAddresses, golden._minimumsignatures);
  const res = await verifyWitness(golden.record, golden.witness, client, golden._network);
  assert.deepEqual(res, { verified: true });
});

test('stage2: tampered record (amount+1) -> verified:false', async () => {
  const client = mockClient(golden._signerAddresses, golden._minimumsignatures);
  const tampered = { ...golden.record, amount: golden.record.amount + 1 };
  const res = await verifyWitness(tampered, golden.witness, client, golden._network);
  assert.equal(res.verified, false);
});

test('stage2: tampered signature -> verified:false', async () => {
  const client = mockClient(golden._signerAddresses, golden._minimumsignatures);
  const sig = golden.witness.signature as string;
  // NB: flipping the *last* base64 char of this blob is a no-op — the trailing
  // padding bits decode to identical bytes. Tamper a meaningful content byte
  // (char 10, inside the signature body) so the decoded signature truly differs.
  const pos = 10;
  const flipped = sig[pos] === 'A' ? 'B' : 'A';
  const tamperedSig = sig.slice(0, pos) + flipped + sig.slice(pos + 1);
  assert.notEqual(
    Buffer.from(sig, 'base64').toString('hex'),
    Buffer.from(tamperedSig, 'base64').toString('hex'),
    'tamper must change the decoded signature bytes',
  );
  const witness: WitnessBlock = { ...golden.witness, signature: tamperedSig };
  const res = await verifyWitness(golden.record, witness, client, golden._network);
  assert.equal(res.verified, false);
});

test('stage2: unsupported algorithm -> verified:false reason unsupported_algorithm', async () => {
  const client = mockClient(golden._signerAddresses, golden._minimumsignatures);
  const witness: WitnessBlock = { ...golden.witness, algorithm: 'ed25519' };
  const res = await verifyWitness(golden.record, witness, client, golden._network);
  assert.deepEqual(res, { verified: false, reason: 'unsupported_algorithm' });
});

test('stage2: signer not in primaryAddresses -> verified:false', async () => {
  // A valid signature but the resolver returns an unrelated address.
  const client = mockClient(['RHgk1DtAdtFxmAB6MsDqrKHDesbNRSXAfa'], 1);
  const res = await verifyWitness(golden.record, golden.witness, client, golden._network);
  assert.equal(res.verified, false);
});
