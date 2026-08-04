import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { removeAndRewriteVdxfFields } = require('../dist/onboarding/vdxf.js');
const { VDXF_KEYS, makeSubDD } = require('../dist/onboarding/vdxf.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const FIXTURE = require('./fixtures/identity-raw.json');
const bs58check = require('bs58check');

const DESC = VDXF_KEYS.agent.description;
const REVIEW = VDXF_KEYS.review.record;
const MULTIMAPREMOVE_KEY = 'i5Zkx5Z7tEfh42xtKfwbJ5LgEWE9rEgpFY';

/**
 * contentmultimap KEYS serialize as hash160, NOT as the ASCII i-address.
 *
 * An earlier version of these tests grepped the raw tx for
 * `Buffer.from(iAddr,'utf8').toString('hex')` and therefore passed
 * unconditionally — verified empirically: a tx that DOES carry an action-3
 * removal contains no utf8 form of MULTIMAPREMOVE_KEY at all. Only the sub-DD
 * *label* ever appears in ASCII, which is why one assertion seemed to work.
 * Always match on hash160 so the assertion tests the layer it claims to.
 */
function keyMarker(iAddr: string): string {
  return Buffer.from(bs58check.decode(iAddr).slice(1)).toString('hex');
}

/**
 * Regression cover for `removeAndRewriteVdxfFields`.
 *
 * This function had ZERO tests, which is how it shipped broken: it used to
 * broadcast a `contentmultimapremove` (action 3) transaction, wait a block, then
 * write. On 2026-08-04 the remove transaction was found to be rejected by the
 * network (`400 TX_REJECTED`) on agents both with and without recent identity
 * writes, so `update-profile` could not complete at all. It is now a single
 * transaction, verified live (agent-3 tx b7d49d25, agent-7 tx 9e890c6d).
 *
 * The invariant these tests protect: replacing a key's value must never disturb
 * any OTHER key — `buildIdentityUpdateTx` copies the whole contentmultimap
 * forward and overwrites only what it is given.
 */

function makeAgent(existingCmm: Record<string, unknown[]>, address: string, opts: {
  broadcastThrows?: Error;
} = {}) {
  const broadcasts: string[] = [];
  const calls: string[] = [];
  const identity = JSON.parse(JSON.stringify(FIXTURE.identityData));
  // buildIdentityUpdateTx refuses to sign for a non-primary address.
  identity.identity.primaryaddresses = [address];
  identity.identity.contentmultimap = existingCmm;

  const client = {
    async getIdentityRaw() { calls.push('getIdentityRaw'); return { data: identity }; },
    async getUtxos() {
      calls.push('getUtxos');
      return { utxos: [{ txid: 'a'.repeat(64), vout: 0, satoshis: 100000000 }] };
    },
    async getChainInfo() { calls.push('getChainInfo'); return { blockHeight: 1000000 }; },
    async broadcast(hex: string) {
      calls.push('broadcast');
      if (opts.broadcastThrows) throw opts.broadcastThrows;
      broadcasts.push(hex);
      return { txid: 'deadbeef'.repeat(8) };
    },
    async refreshAgent() { calls.push('refreshAgent'); },
  };
  return { agent: { client }, broadcasts, calls };
}

const BASE = {
  chain: 'verustest' as const,
  identityName: 'testagent.agentplatform@',
};

describe('removeAndRewriteVdxfFields — single transaction', () => {
  it('broadcasts exactly ONE transaction (no remove phase, no block wait)', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const { agent, calls } = makeAgent({}, kp.address);

    const res = await removeAndRewriteVdxfFields({
      ...BASE, agent, wif, fieldsToUpdate: { description: 'hello' },
    });

    const broadcastCount = calls.filter(c => c === 'broadcast').length;
    assert.strictEqual(broadcastCount, 1, 'must broadcast exactly one tx');
    assert.strictEqual(res.removeTxid, null, 'removeTxid is null — no remove tx exists');
    assert.strictEqual(res.blocksWaited, 0, 'must not wait for a block');
    assert.ok(res.writeTxid, 'writeTxid must be returned');
  });

  it('never emits a contentmultimapremove (action 3) payload', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const { agent, broadcasts } = makeAgent({}, kp.address);

    await removeAndRewriteVdxfFields({
      ...BASE, agent, wif, fieldsToUpdate: { description: 'hello' },
    });

    // Presence of the MULTIMAPREMOVE key would mean the network-rejected
    // action-3 path came back. Matched on hash160 — see keyMarker().
    assert.strictEqual(broadcasts.length, 1);
    assert.ok(!broadcasts[0].includes(keyMarker(MULTIMAPREMOVE_KEY)),
      'must not carry a removal instruction');
    // Guard the guard: the marker must be detectable at all, otherwise this
    // assertion is vacuous (it previously was).
    assert.ok(keyMarker(MULTIMAPREMOVE_KEY).length === 40, 'marker must be a hash160');
  });

  it('rejects an unknown field name BEFORE broadcasting anything', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const { agent, calls } = makeAgent({}, kp.address);

    await assert.rejects(
      () => removeAndRewriteVdxfFields({
        ...BASE, agent, wif, fieldsToUpdate: { notARealField: 'x' },
      }),
      /Unknown VDXF field|Unknown VDXF i-address|ambiguous/i,
    );
    assert.strictEqual(calls.length, 0,
      'a typo must not trigger ANY network I/O, not even a read');
  });

  it('writes multiple distinct keys in the SAME transaction', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const { agent, calls } = makeAgent({}, kp.address);

    await removeAndRewriteVdxfFields({
      ...BASE, agent, wif,
      fieldsToUpdate: { description: 'a new description', displayName: 'New Name' },
    });

    assert.strictEqual(calls.filter(c => c === 'broadcast').length, 1,
      'two fields must still be one transaction');
  });

  it('surfaces a broadcast rejection rather than swallowing it', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const err = Object.assign(new Error('Transaction rejected by the network'), {
      code: 'TX_REJECTED', statusCode: 400,
    });
    const { agent } = makeAgent({}, kp.address, { broadcastThrows: err });

    await assert.rejects(
      () => removeAndRewriteVdxfFields({
        ...BASE, agent, wif, fieldsToUpdate: { description: 'hello' },
      }),
      /Transaction rejected by the network/,
    );
  });

  it('preserves an unrelated key (review.record) while replacing description', async () => {
    const kp = generateKeypair('verustest');
    const { wif } = kp;
    const existingReview = [makeSubDD(REVIEW, JSON.stringify({ jobHash: 'abc', rating: 5 }))];
    const { agent, broadcasts } = makeAgent({ [REVIEW]: existingReview }, kp.address);

    await removeAndRewriteVdxfFields({
      ...BASE, agent, wif, fieldsToUpdate: { description: 'changed' },
    });

    // The review key must still be in the serialized transaction: the builder
    // copies every existing key forward. If this ever fails, a profile edit is
    // silently destroying reputation data.
    assert.strictEqual(broadcasts.length, 1);
    assert.ok(broadcasts[0].includes(keyMarker(REVIEW)), 'review.record must be carried forward');
    assert.ok(broadcasts[0].includes(keyMarker(DESC)), 'description key must be present');
  });
});

/**
 * The platform returns the daemon's real rejection reason in `error.detail`
 * (e.g. TX_REJECTED → "-25 - bad-txns-failed-precheck"). J41Error used to carry
 * only message/code/statusCode and dropped it, so the single most useful field
 * in a failed broadcast never reached a caller. Verified live 2026-08-04: the
 * wire body had `detail`, the thrown error did not.
 */
describe('J41Error.detail plumbing', () => {
  it('carries error.detail through from the response body', () => {
    const { J41Error } = require('../dist/client/index.js');
    const e = new J41Error('Transaction rejected by the network', 'TX_REJECTED', 400,
      '-25 - bad-txns-failed-precheck');
    assert.strictEqual(e.detail, '-25 - bad-txns-failed-precheck');
    assert.strictEqual(e.code, 'TX_REJECTED');
    assert.strictEqual(e.statusCode, 400);
  });

  it('leaves detail undefined when the platform sends none', () => {
    const { J41Error } = require('../dist/client/index.js');
    const e = new J41Error('nope', 'HTTP_ERROR', 500);
    assert.strictEqual(e.detail, undefined);
    assert.ok(!('detail' in e), 'must not add an undefined detail key');
  });
});
