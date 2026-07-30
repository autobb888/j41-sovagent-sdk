import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { extractVdxfHistory, decodeReviewHistory } = require('../dist/identity/history.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const REVIEW = VDXF_KEYS.review.record;
const ATTEST = VDXF_KEYS.review.attestation;

const hex = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('hex');

const review = (jobHash: string, rating: number) =>
  hex({ buyer: 'iBuyer', jobHash, rating, timestamp: 1785289116, signature: 'sig-' + jobHash });

/**
 * Shape of `getidentityhistory`: a chronologically ordered array of COMPLETE
 * identity snapshots, one per update height. Because review.record is a single
 * fixed VDXF key that each update REPLACES, the only way to reconstruct an
 * agent's full review history is to walk these snapshots — the current
 * contentmultimap holds just the newest value.
 */
const snapshots = [
  { height: 1000, identity: { contentmultimap: { [REVIEW]: [review('aaa1', 5)] } } },
  { height: 1100, identity: { contentmultimap: { [REVIEW]: [review('bbb2', 4)], [ATTEST]: ['ff'] } } },
  { height: 1200, identity: { contentmultimap: { [REVIEW]: [review('ccc3', 3)] } } },
];

describe('extractVdxfHistory', () => {
  it('walks snapshots oldest-first and collects every value seen under a key', () => {
    const out = extractVdxfHistory(snapshots, REVIEW);
    assert.strictEqual(out.length, 3);
    assert.deepEqual(out.map((e: any) => e.height), [1000, 1100, 1200]);
  });

  it('recovers a value that was later overwritten — the whole point', () => {
    const out = extractVdxfHistory(snapshots, REVIEW);
    // 'aaa1' is absent from the CURRENT contentmultimap (1200 replaced it) but is
    // still recoverable from history at its original height.
    assert.ok(out.some((e: any) => e.value === review('aaa1', 5)), 'overwritten value is recoverable');
  });

  it('returns [] for a key that never appears', () => {
    assert.deepEqual(extractVdxfHistory(snapshots, 'iNeverUsedKey'), []);
  });

  it('skips snapshots with no contentmultimap without throwing', () => {
    const out = extractVdxfHistory([{ height: 1, identity: {} }, ...snapshots], REVIEW);
    assert.strictEqual(out.length, 3);
  });

  it('deduplicates a value that is unchanged across consecutive updates', () => {
    const same = review('same', 5);
    const out = extractVdxfHistory([
      { height: 1, identity: { contentmultimap: { [REVIEW]: [same] } } },
      { height: 2, identity: { contentmultimap: { [REVIEW]: [same] } } },
    ], REVIEW);
    assert.strictEqual(out.length, 1, 'an unchanged value is one historical entry, not two');
  });

  it('tolerates a non-array value under the key', () => {
    const out = extractVdxfHistory([{ height: 5, identity: { contentmultimap: { [REVIEW]: review('solo', 5) } } }], REVIEW);
    assert.strictEqual(out.length, 1);
  });

  it('handles an empty or missing history array', () => {
    assert.deepEqual(extractVdxfHistory([], REVIEW), []);
    assert.deepEqual(extractVdxfHistory(null as any, REVIEW), []);
  });
});

describe('decodeReviewHistory', () => {
  it('decodes every historical review, newest last', () => {
    const out = decodeReviewHistory(snapshots);
    assert.deepEqual(out.map((r: any) => r.jobHash), ['aaa1', 'bbb2', 'ccc3']);
    assert.strictEqual(out[0].rating, 5);
    assert.strictEqual(out[0].height, 1000);
  });

  it('deduplicates by jobHash, keeping the earliest height it was seen at', () => {
    // The backend's non-idempotent re-submit can write the same review twice.
    const dup = [
      ...snapshots,
      { height: 1300, identity: { contentmultimap: { [REVIEW]: [review('aaa1', 5)] } } },
    ];
    const out = decodeReviewHistory(dup);
    assert.strictEqual(out.filter((r: any) => r.jobHash === 'aaa1').length, 1);
    assert.strictEqual(out.find((r: any) => r.jobHash === 'aaa1').height, 1000, 'first write wins');
  });

  it('skips an undecodable entry rather than throwing away the whole history', () => {
    const out = decodeReviewHistory([
      { height: 1, identity: { contentmultimap: { [REVIEW]: ['not-valid-hex-json'] } } },
      ...snapshots,
    ]);
    assert.strictEqual(out.length, 3, 'one bad entry must not lose the good ones');
  });

  it('returns [] when the identity has no review history', () => {
    assert.deepEqual(decodeReviewHistory([{ height: 1, identity: { contentmultimap: {} } }]), []);
  });
});

// ---------------------------------------------------------------------------
// Review findings — ordering, DataDescriptor wrapping, multi-value arrays
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  it('C1: newest-first input is sorted, so earliest-wins does not silently invert', () => {
    const newestFirst = [...snapshots].reverse();
    const out = decodeReviewHistory(newestFirst);
    assert.deepEqual(out.map((r: any) => r.jobHash), ['aaa1', 'bbb2', 'ccc3'],
      'must not depend on the endpoint returning oldest-first');
  });

  it('C1: with a duplicate jobHash, sorting means the EARLIEST height wins regardless of input order', () => {
    const unordered = [
      { height: 1300, identity: { contentmultimap: { [REVIEW]: [review('dup', 2)] } } },
      { height: 1000, identity: { contentmultimap: { [REVIEW]: [review('dup', 5)] } } },
    ];
    const out = decodeReviewHistory(unordered);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].height, 1000, 'first write wins even when given last');
  });

  it('C1: uses the blockheight field — the daemon’s native name', () => {
    const out = extractVdxfHistory(
      [{ blockheight: 900, identity: { contentmultimap: { [REVIEW]: [review('bh', 5)] } } }], REVIEW);
    assert.strictEqual(out[0].height, 900);
  });

  it('C2: decodes a makeSubDD DataDescriptor-wrapped review', () => {
    const { makeSubDD } = require('../dist/onboarding/vdxf.js');
    const wrapped = makeSubDD(REVIEW, JSON.stringify({ jobHash: 'dd1', buyer: 'iB', rating: 4, timestamp: 1, signature: 's' }));
    const out = decodeReviewHistory([{ height: 10, identity: { contentmultimap: { [REVIEW]: [wrapped] } } }]);
    assert.strictEqual(out.length, 1, 'a DD-wrapped record is wrapped, not malformed — must not be dropped');
    assert.strictEqual(out[0].jobHash, 'dd1');
    assert.strictEqual(out[0].rating, 4);
  });

  it('C3: an identical multi-value array across two snapshots is ONE historical entry set', () => {
    const a = review('m1', 5), b = review('m2', 4);
    const out = extractVdxfHistory([
      { height: 1, identity: { contentmultimap: { [REVIEW]: [a, b] } } },
      { height: 2, identity: { contentmultimap: { [REVIEW]: [a, b] } } },
    ], REVIEW);
    assert.strictEqual(out.length, 2, 'must be A,B — not A,B,A,B');
  });

  it('C6: a hex value decoding to a JSON array is rejected, not emitted as an all-null review', () => {
    const arrHex = Buffer.from(JSON.stringify([1, 2, 3]), 'utf8').toString('hex');
    const out = decodeReviewHistory([{ height: 1, identity: { contentmultimap: { [REVIEW]: [arrHex] } } }]);
    assert.deepEqual(out, []);
  });
});
