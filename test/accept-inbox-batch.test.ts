import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');
const FIXTURE = require('./fixtures/identity-raw.json');

const REVIEW = VDXF_KEYS.review.record;
const ATTEST = VDXF_KEYS.review.attestation;
const PAYADDR = VDXF_KEYS.agent.payAddress;

/**
 * A value that passes BOTH the allowlist (it sits under the correct review.record
 * key) AND assertContentmultimapValueSizes (contentmultimapValueByteSize
 * JSON.stringify-fallbacks over any object and never validates structure) — but
 * throws inside Identity.fromJson at build time ("Unknown vdxfkey: x").
 *
 * This is the exact class of input that made the pre-audit design fail: it would
 * have become an uncounted batch-level throw that blocked every other item for
 * the agent forever. Verified empirically against the real builder.
 */
const BUILD_POISON = { __bad: 'x', nested: { deep: true } };

class FakeJ41Error extends Error {
  code: string;
  statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'J41Error';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function makeAgent(items: Record<string, any>, opts: {
  ackBehavior?: (id: string) => void;
  onChain?: Record<string, unknown[]>;
  broadcastThrows?: Error;
} = {}) {
  const kp = generateKeypair('verustest');
  const identityData = JSON.parse(JSON.stringify(FIXTURE.identityData));
  // buildIdentityUpdateTx refuses to sign for a non-primary address (update.ts:153-156).
  identityData.identity.primaryaddresses = [kp.address];
  if (opts.onChain) identityData.identity.contentmultimap = opts.onChain;

  const agent = new J41Agent({
    apiUrl: 'https://api.example.com', wif: kp.wif,
    iAddress: identityData.identity.identityaddress, identityName: 'batchtest.agentplatform@',
  });

  const calls = { broadcast: 0, acks: [] as string[], getInboxItem: 0 };
  agent.client.getInboxItem = async (id: string) => {
    calls.getInboxItem++;
    const it = items[id];
    if (!it) throw new Error(`no such inbox item ${id}`);
    if (it.__fetchThrows) throw new Error('transient fetch failure');
    return { data: it };
  };
  agent.client.getIdentityRaw = async () => ({ data: identityData });
  agent.client.getUtxos = async () => ({
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, outputIndex: 0, address: kp.address, satoshis: 100000 }],
  });
  agent.client.getChainInfo = async () => ({ blockHeight: 1000 });
  agent.client.broadcast = async () => {
    calls.broadcast++;
    if (opts.broadcastThrows) throw opts.broadcastThrows;
    return { txid: 'cafebabe' };
  };
  agent.client.acceptInboxItem = async (id: string) => {
    if (opts.ackBehavior) opts.ackBehavior(id);
    calls.acks.push(id);
    return { data: { success: true, status: 'accepted' } };
  };
  return { agent, calls };
}

const pendingReview = (id: string, value: unknown = 'deadbeef') => ({ id, type: 'review', status: 'pending', vdxfData: { [REVIEW]: value } });
const pendingAttest = (id: string, value: unknown = 'beef') => ({ id, type: 'attestation', status: 'pending', vdxfData: { [ATTEST]: value } });

describe('acceptInboxBatch — batching (the core fix)', () => {
  it('merges an attestation and a review into ONE transaction and acks both', async () => {
    const { agent, calls } = makeAgent({ a1: pendingAttest('a1'), r1: pendingReview('r1') });
    const res = await agent.acceptInboxBatch([
      { id: 'a1', type: 'attestation' }, { id: 'r1', type: 'review' },
    ]);
    assert.strictEqual(calls.broadcast, 1, 'exactly ONE broadcast for two items');
    assert.strictEqual(res.txid, 'cafebabe');
    assert.deepEqual(res.written.map((w: any) => w.id).sort(), ['a1', 'r1']);
    assert.deepEqual(res.acked.sort(), ['a1', 'r1']);
    assert.deepEqual(res.rejected, []);
    assert.deepEqual(res.ackFailed, []);
  });

  it('a single item still works (no regression for the common case)', async () => {
    const { agent, calls } = makeAgent({ r1: pendingReview('r1') });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.strictEqual(calls.broadcast, 1);
    assert.deepEqual(res.acked, ['r1']);
  });

  it('two items sharing a VDXF key: one writes, the other defers (no silent clobber)', async () => {
    const { agent, calls } = makeAgent({ r1: pendingReview('r1'), r2: pendingReview('r2', 'feedface') });
    const res = await agent.acceptInboxBatch([
      { id: 'r1', type: 'review' }, { id: 'r2', type: 'review' },
    ]);
    assert.strictEqual(calls.broadcast, 1);
    assert.deepEqual(res.written.map((w: any) => w.id), ['r1']);
    assert.strictEqual(res.deferred.length, 1);
    assert.strictEqual(res.deferred[0].id, 'r2');
    assert.match(res.deferred[0].reason, /key-collision/);
  });

  it('skips a non-pending item as alreadyDone without writing it', async () => {
    const { agent, calls } = makeAgent({ r1: { id: 'r1', type: 'review', status: 'accepted', vdxfData: { [REVIEW]: 'x' } } });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.deepEqual(res.alreadyDone, ['r1']);
    assert.strictEqual(calls.broadcast, 0, 'no chain write for an already-accepted item');
  });

  it('a transient fetch failure defers the item rather than rejecting it', async () => {
    const { agent } = makeAgent({ r1: { id: 'r1', __fetchThrows: true } });
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.strictEqual(res.deferred.length, 1);
    assert.deepEqual(res.rejected, []);
  });
});

describe('acceptInboxBatch — per-item independence (no all-or-nothing coupling)', () => {
  it('a gate-poisoned item is rejected while the healthy item still writes', async () => {
    const { agent, calls } = makeAgent({
      bad: { id: 'bad', type: 'review', status: 'pending', vdxfData: { [PAYADDR]: 'attacker' } },
      good: pendingReview('good'),
    });
    const res = await agent.acceptInboxBatch([
      { id: 'bad', type: 'review' }, { id: 'good', type: 'review' },
    ]);
    assert.strictEqual(calls.broadcast, 1);
    assert.deepEqual(res.written.map((w: any) => w.id), ['good']);
    assert.strictEqual(res.rejected.length, 1);
    assert.strictEqual(res.rejected[0].id, 'bad');
  });

  it('AUDIT FIX 1: a gate-passing but BUILD-BREAKING item is bisected out — healthy items still write', async () => {
    const { agent, calls } = makeAgent({
      poison: pendingReview('poison', BUILD_POISON),
      good: pendingAttest('good'),
    });
    const res = await agent.acceptInboxBatch([
      { id: 'poison', type: 'review' }, { id: 'good', type: 'attestation' },
    ]);
    // The healthy item must still reach the chain.
    assert.strictEqual(calls.broadcast, 1, 'healthy item still broadcasts after bisection');
    assert.deepEqual(res.written.map((w: any) => w.id), ['good']);
    assert.deepEqual(res.acked, ['good']);
    // The culprit must be attributed individually so the caller can dead-letter it.
    assert.strictEqual(res.rejected.length, 1);
    assert.strictEqual(res.rejected[0].id, 'poison');
    assert.match(res.rejected[0].error, /build/i);
  });

  it('AUDIT FIX 1: a lone build-breaking item is rejected, not thrown as batch-level', async () => {
    const { agent, calls } = makeAgent({ poison: pendingReview('poison', BUILD_POISON) });
    const res = await agent.acceptInboxBatch([{ id: 'poison', type: 'review' }]);
    assert.strictEqual(calls.broadcast, 0);
    assert.strictEqual(res.txid, null);
    assert.strictEqual(res.rejected.length, 1);
    assert.strictEqual(res.rejected[0].id, 'poison');
  });

  it('a genuinely batch-scoped failure (broadcast) still throws for the caller to classify', async () => {
    const { agent } = makeAgent(
      { r1: pendingReview('r1') },
      { broadcastThrows: new FakeJ41Error('Transaction rejected by the network', 'TX_REJECTED', 400) },
    );
    await assert.rejects(
      agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]),
      /Transaction rejected by the network/,
    );
  });
});

describe('acceptInboxBatch — environmental failures must NOT be blamed on items', () => {
  // Review finding: bisection assumed a solo-build failure proves the item is at
  // fault. A DETERMINISTIC ENVIRONMENTAL failure breaks the merged build AND every
  // solo build identically, so every item would be hard-rejected — and the
  // dispatcher dead-letters `rejected` items individually. A wallet dipping below
  // the fee for 5 cycles would permanently quarantine every pending item: strictly
  // worse than the bug this whole change exists to fix.
  function makeStarvedAgent(utxos: unknown[]) {
    const kp = generateKeypair('verustest');
    const identityData = JSON.parse(JSON.stringify(FIXTURE.identityData));
    identityData.identity.primaryaddresses = [kp.address];
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com', wif: kp.wif,
      iAddress: identityData.identity.identityaddress, identityName: 'batchtest.agentplatform@',
    });
    const items: Record<string, any> = { r1: pendingReview('r1'), a1: pendingAttest('a1') };
    agent.client.getInboxItem = async (id: string) => ({ data: items[id] });
    agent.client.getIdentityRaw = async () => ({ data: identityData });
    agent.client.getUtxos = async () => ({ utxos });
    agent.client.getChainInfo = async () => ({ blockHeight: 1000 });
    agent.client.broadcast = async () => ({ txid: 'cafebabe' });
    agent.client.acceptInboxItem = async () => ({ data: { success: true, status: 'accepted' } });
    return agent;
  }
  const kpAddr = () => generateKeypair('verustest').address;

  it('insufficient funds throws batch-level — it does NOT reject the items', async () => {
    const agent = makeStarvedAgent([{ txid: 'ab'.repeat(32), vout: 0, outputIndex: 0, address: undefined, satoshis: 5000 }]);
    await assert.rejects(
      agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]),
      /Insufficient funds|No spendable/,
      'an unfunded wallet is environmental — the caller must classify it, not dead-letter the items',
    );
  });

  it('only unspendable i-address UTXOs throws batch-level, not per-item', async () => {
    const agent = makeStarvedAgent([{ txid: 'cd'.repeat(32), vout: 0, outputIndex: 0, address: 'iSomeOtherAddress', satoshis: 900000 }]);
    await assert.rejects(
      agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]),
      /No spendable R-address UTXOs/,
    );
  });

  it('a real poison item is still blamed when the environment is healthy', async () => {
    // The control must not over-correct: genuine per-item poison must still be caught.
    const { agent } = makeAgent({ poison: pendingReview('poison', BUILD_POISON), good: pendingAttest('good') });
    const res = await agent.acceptInboxBatch([
      { id: 'poison', type: 'review' }, { id: 'good', type: 'attestation' },
    ]);
    assert.deepEqual(res.rejected.map((r: any) => r.id), ['poison']);
    assert.deepEqual(res.written.map((w: any) => w.id), ['good']);
  });
});

describe('acceptInboxBatch — ack semantics (verified backend contract)', () => {
  it('AUDIT FIX 2: an item already on-chain short-circuits — no broadcast, still acked', async () => {
    const { agent, calls } = makeAgent(
      { r1: pendingReview('r1') },
      { onChain: { [REVIEW]: ['deadbeef'] } },
    );
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.strictEqual(calls.broadcast, 0, 'value already on-chain → no rebroadcast (no fee bleed)');
    assert.strictEqual(res.txid, null);
    assert.deepEqual(res.written.map((w: any) => w.id), ['r1']);
    assert.deepEqual(res.acked, ['r1']);
  });

  it('BACKEND CONTRACT: 400 ALREADY_PROCESSED counts as terminal SUCCESS, never ackFailed', async () => {
    const { agent } = makeAgent(
      { r1: pendingReview('r1') },
      {
        ackBehavior: (id) => {
          if (id === 'r1') throw new FakeJ41Error('Inbox item already processed', 'ALREADY_PROCESSED', 400);
        },
      },
    );
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.deepEqual(res.acked, ['r1'], 'ALREADY_PROCESSED must be treated as acked');
    assert.deepEqual(res.ackFailed, [], 'must NOT be parked in ackFailed — that would stall forever');
  });

  it('a genuine ack failure lands in ackFailed (transient, caller does not count it)', async () => {
    const { agent } = makeAgent(
      { r1: pendingReview('r1') },
      { ackBehavior: () => { throw new FakeJ41Error('gateway timeout', 'UPSTREAM', 504); } },
    );
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.deepEqual(res.acked, []);
    assert.strictEqual(res.ackFailed.length, 1);
    assert.strictEqual(res.ackFailed[0].id, 'r1');
  });

  it('one item failing its ack does not prevent the other from being acked', async () => {
    const { agent } = makeAgent(
      { a1: pendingAttest('a1'), r1: pendingReview('r1') },
      { ackBehavior: (id) => { if (id === 'r1') throw new FakeJ41Error('boom', 'UPSTREAM', 500); } },
    );
    const res = await agent.acceptInboxBatch([
      { id: 'a1', type: 'attestation' }, { id: 'r1', type: 'review' },
    ]);
    assert.deepEqual(res.acked, ['a1']);
    assert.deepEqual(res.ackFailed.map((f: any) => f.id), ['r1']);
  });

  it('acks carry the broadcast txid (not undefined, not a stale one)', async () => {
    const seen: Array<string | undefined> = [];
    const { agent } = makeAgent({ r1: pendingReview('r1') });
    const orig = agent.client.acceptInboxItem;
    agent.client.acceptInboxItem = async (id: string, txid?: string) => { seen.push(txid); return orig(id); };
    await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.deepEqual(seen, ['cafebabe']);
  });

  it('emits a per-type :accepted event carrying inboxId and txid', async () => {
    const { agent } = makeAgent({ r1: pendingReview('r1'), a1: pendingAttest('a1') });
    const events: any[] = [];
    agent.on('review:accepted', (e: any) => events.push(['review', e]));
    agent.on('attestation:accepted', (e: any) => events.push(['attestation', e]));
    await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }, { id: 'a1', type: 'attestation' }]);
    assert.strictEqual(events.length, 2);
    const review = events.find(e => e[0] === 'review')[1];
    assert.strictEqual(review.inboxId, 'r1');
    assert.strictEqual(review.txid, 'cafebabe');
  });

  it('respects the size budget by deferring the overflow item, never dropping it', async () => {
    const { agent, calls } = makeAgent({ a1: pendingAttest('a1'), r1: pendingReview('r1') });
    // 2 bytes each (4 hex chars / 8 hex chars); a 3-byte budget fits exactly one.
    const res = await agent.acceptInboxBatch(
      [{ id: 'a1', type: 'attestation' }, { id: 'r1', type: 'review' }],
      { maxAdditionBytes: 3 },
    );
    assert.strictEqual(calls.broadcast, 1);
    assert.strictEqual(res.written.length, 1);
    assert.strictEqual(res.deferred.length, 1, 'overflow is deferred to the next cycle');
    assert.match(res.deferred[0].reason, /size-budget/);
    assert.deepEqual(res.rejected, [], 'a size overflow is NOT the item’s fault');
  });

  it('an empty batch performs no chain calls at all', async () => {
    const { agent, calls } = makeAgent({});
    const res = await agent.acceptInboxBatch([]);
    assert.strictEqual(res.txid, null);
    assert.strictEqual(calls.broadcast, 0);
    assert.strictEqual(calls.getInboxItem, 0);
  });
});

describe('acceptInboxBatch — jobHash dedupe (backend §5a defence in depth)', () => {
  const REVIEW_JSON = (jobHash: string, rating: number) =>
    Buffer.from(JSON.stringify({ buyer: 'iB', jobHash, rating, timestamp: 1, signature: 's' }), 'utf8').toString('hex');

  it('skips the write when the same jobHash is already on-chain in a DIFFERENT encoding', async () => {
    // The platform's non-idempotent re-submit mints a fresh item for a review that
    // was already written. Byte-comparison misses it if any field differs.
    const { agent, calls } = makeAgent(
      { r1: { id: 'r1', type: 'review', status: 'pending', vdxfData: { [REVIEW]: REVIEW_JSON('job-abc', 4) } } },
      { onChain: { [REVIEW]: [REVIEW_JSON('job-abc', 5)] } }, // same job, different rating
    );
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.strictEqual(calls.broadcast, 0, 'a re-emit of an already-written review must not pay a second fee');
    assert.deepEqual(res.acked, ['r1'], 'still acked so the backend stops re-serving it');
  });

  it('still writes when the jobHash is genuinely new', async () => {
    const { agent, calls } = makeAgent(
      { r1: { id: 'r1', type: 'review', status: 'pending', vdxfData: { [REVIEW]: REVIEW_JSON('job-new', 5) } } },
      { onChain: { [REVIEW]: [REVIEW_JSON('job-old', 5)] } },
    );
    const res = await agent.acceptInboxBatch([{ id: 'r1', type: 'review' }]);
    assert.strictEqual(calls.broadcast, 1, 'a different review must still be written');
    assert.deepEqual(res.acked, ['r1']);
  });

  it('does not apply jobHash dedupe to attestations (different key, different semantics)', async () => {
    const { agent, calls } = makeAgent(
      { a1: pendingAttest('a1', 'newvalue') },
      { onChain: { [ATTEST]: ['oldvalue'] } },
    );
    await agent.acceptInboxBatch([{ id: 'a1', type: 'attestation' }]);
    assert.strictEqual(calls.broadcast, 1);
  });
});
