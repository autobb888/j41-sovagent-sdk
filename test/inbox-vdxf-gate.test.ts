import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  buildInboxVdxfAdditions,
  inboxAllowlistForType,
  additionsByteSize,
  MAX_BATCH_ADDITION_BYTES,
} = require('../dist/inbox/vdxf-gate.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const REVIEW = VDXF_KEYS.review.record;        // iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad
const ATTEST = VDXF_KEYS.review.attestation;   // i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv
const JOBREC = VDXF_KEYS.job.record;           // iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn
const PAYADDR = VDXF_KEYS.agent.payAddress;    // iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD

describe('inbox vdxf-gate — per-type allowlists (52f8d07 invariant)', () => {
  it('allowlists are exact per type', () => {
    assert.deepEqual([...inboxAllowlistForType('review')], [REVIEW]);
    assert.deepEqual([...inboxAllowlistForType('attestation')], [ATTEST]);
    assert.deepEqual([...inboxAllowlistForType('job_record')], [JOBREC]);
  });

  it('rejects an unsupported type rather than defaulting open', () => {
    assert.throws(() => inboxAllowlistForType('nonsense' as any), /unsupported inbox type/i);
  });

  it('review: passes through review.record and wraps a non-array value', () => {
    const out = buildInboxVdxfAdditions('review', { vdxfData: { [REVIEW]: 'deadbeef' } }, 'acceptReview r1');
    assert.deepEqual(out, { [REVIEW]: ['deadbeef'] });
  });

  it('review: preserves an array value as-is', () => {
    const out = buildInboxVdxfAdditions('review', { vdxfData: { [REVIEW]: ['a', 'b'] } }, 'acceptReview r1b');
    assert.deepEqual(out, { [REVIEW]: ['a', 'b'] });
  });

  it('review: drops payAddress and throws when nothing remains', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: { [PAYADDR]: 'attacker' } }, 'acceptReview r2'),
      /contained no review\.\* keys after whitelist/,
    );
  });

  it('review: the attestation key must NOT pass the review gate', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: { [ATTEST]: ['x'] } }, 'acceptReview r3'),
      /contained no review\.\* keys after whitelist/,
    );
  });

  it('review: a mixed item keeps only the allowlisted key', () => {
    const out = buildInboxVdxfAdditions(
      'review',
      { vdxfData: { [REVIEW]: 'good', [PAYADDR]: 'attacker', [ATTEST]: 'wrong-ns' } },
      'acceptReview r5',
    );
    assert.deepEqual(out, { [REVIEW]: ['good'] });
  });

  it('review: null/empty vdxfData refuses to synthesize', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: null }, 'acceptReview r4'),
      /has no VDXF review\.record — refusing to synthesize/,
    );
  });

  it('attestation: review.record must NOT pass the attestation gate', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('attestation', { vdxfData: { [REVIEW]: ['x'] } }, 'acceptAttestationTuple a2'),
      /contained no review\.attestation keys after whitelist/,
    );
  });

  it('attestation: empty vdxfData refuses to synthesize', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('attestation', { vdxfData: {} }, 'acceptAttestationTuple a1'),
      /has no VDXF review\.attestation — refusing to synthesize/,
    );
  });

  it('attestation: passes through the attestation key', () => {
    const out = buildInboxVdxfAdditions('attestation', { vdxfData: { [ATTEST]: 'ab12' } }, 'acceptAttestationTuple a3');
    assert.deepEqual(out, { [ATTEST]: ['ab12'] });
  });

  it('job_record: passes through job.record', () => {
    const out = buildInboxVdxfAdditions('job_record', { vdxfData: { [JOBREC]: 'ff00' } }, 'acceptJobRecord j1');
    assert.deepEqual(out, { [JOBREC]: ['ff00'] });
  });

  it('job_record: review.record must NOT pass the job gate', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('job_record', { vdxfData: { [REVIEW]: ['x'] } }, 'acceptJobRecord j2'),
      /contained no job\.\* keys after whitelist/,
    );
  });

  it('job_record: DOES synthesize from fields when vdxfData is absent (unlike review/attestation)', () => {
    const out = buildInboxVdxfAdditions(
      'job_record',
      { vdxfData: null, senderVerusId: 'iBuyer', jobHash: 'abc123', amount: 0.5, currency: 'VRSCTEST' },
      'acceptJobRecord j3',
    );
    assert.deepEqual(Object.keys(out), [JOBREC]);
    assert.equal(out[JOBREC].length, 1);
  });

  it('a null value under an allowed key is skipped, not written as null', () => {
    assert.throws(
      () => buildInboxVdxfAdditions('review', { vdxfData: { [REVIEW]: null } }, 'acceptReview r6'),
      /contained no review\.\* keys after whitelist/,
    );
  });
});

describe('inbox vdxf-gate — size accounting', () => {
  it('additionsByteSize sums across keys and values', () => {
    const size = additionsByteSize({ [REVIEW]: ['deadbeef'], [ATTEST]: ['beef'] });
    // hex strings: 8 hex chars = 4 bytes, 4 hex chars = 2 bytes
    assert.equal(size, 6);
  });

  it('additionsByteSize of an empty map is 0', () => {
    assert.equal(additionsByteSize({}), 0);
  });

  it('MAX_BATCH_ADDITION_BYTES is a positive budget', () => {
    assert.equal(typeof MAX_BATCH_ADDITION_BYTES, 'number');
    assert.ok(MAX_BATCH_ADDITION_BYTES > 0);
  });
});
