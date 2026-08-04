import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { resolveVdxfFieldRef, VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

describe('resolveVdxfFieldRef', () => {
  it('resolves a namespaced group.field path', () => {
    assert.strictEqual(resolveVdxfFieldRef('review.attestation'), VDXF_KEYS.review.attestation);
    assert.strictEqual(resolveVdxfFieldRef('workspace.attestation'), VDXF_KEYS.workspace.attestation);
    assert.strictEqual(resolveVdxfFieldRef('job.record'), VDXF_KEYS.job.record);
  });

  it('resolves a raw, known i-address', () => {
    assert.strictEqual(resolveVdxfFieldRef(VDXF_KEYS.review.attestation), VDXF_KEYS.review.attestation);
  });

  it('rejects an unknown i-address (typo / foreign key)', () => {
    assert.throws(() => resolveVdxfFieldRef('i' + '1'.repeat(33)), /Unknown VDXF i-address/);
  });

  it('resolves an UNAMBIGUOUS bare leaf name', () => {
    assert.strictEqual(resolveVdxfFieldRef('payAddress'), VDXF_KEYS.agent.payAddress);
  });

  it("THROWS on ambiguous bare 'attestation' instead of silently picking the wrong key", () => {
    assert.throws(
      () => resolveVdxfFieldRef('attestation'),
      (e: any) => /Ambiguous/.test(e.message)
        && e.message.includes('review.attestation')
        && e.message.includes('workspace.attestation'),
    );
  });

  it("THROWS on ambiguous bare 'record'", () => {
    assert.throws(() => resolveVdxfFieldRef('record'), /Ambiguous VDXF field 'record'/);
  });

  it('throws on an unknown bare name', () => {
    assert.throws(() => resolveVdxfFieldRef('nonsense'), /Unknown VDXF field/);
  });

  it('throws on a namespaced path with an unknown field', () => {
    assert.throws(() => resolveVdxfFieldRef('review.nope'), /Unknown VDXF field path/);
  });
});
