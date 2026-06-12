/**
 * WP-D4 #6 — token usage signed into the deletion attestation (schema v2).
 * The usage must be inside the signed bytes (tamper-evident), v1 attestations
 * must be byte-identical to before, and a malformed usage block must be
 * rejected (fail closed), never accepted-and-ignored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  generateAttestationPayload,
  signAttestation,
  verifyAttestationFormat,
  verifyAttestationSignature,
  ATTESTATION_SCHEMA_VERSION,
} = require('../dist/privacy/attestation.js');
const { canonicalize: jcs } = require('json-canonicalize');
const { generateKeypair, keypairFromWIF } = require('../dist/identity/keypair.js');

const baseParams = {
  jobId: 'job-123',
  containerId: 'container-abc',
  createdAt: '2025-01-01T00:00:00.000Z',
  destroyedAt: '2025-01-01T00:05:00.000Z',
  dataVolumes: ['/tmp/vol1'],
  deletionMethod: 'container-destroy+volume-rm',
  attestedBy: 'testagent.agentplatform@',
};

const usage = {
  promptTokens: 30000,
  completionTokens: 12000,
  totalTokens: 42000,
  llmCalls: 7,
  extensions: [
    { estimatedTokens: 8000, amountVrsc: 0.42, granted: true, grantedTokens: 8000 },
    { estimatedTokens: 5000, amountVrsc: null, granted: false },
  ],
};

describe('Attestation — signed token usage (schema v2)', () => {
  it('v1 payload (no tokenUsage) is unchanged — no schemaVersion / tokenUsage keys', () => {
    const payload = generateAttestationPayload(baseParams);
    assert.strictEqual(payload.schemaVersion, undefined);
    assert.strictEqual(payload.tokenUsage, undefined);
    assert.deepStrictEqual(Object.keys(payload).sort(), Object.keys(payload), 'keys sorted');
  });

  it('v2 payload includes tokenUsage + schemaVersion=2', () => {
    const payload = generateAttestationPayload({ ...baseParams, tokenUsage: usage });
    assert.strictEqual(payload.schemaVersion, ATTESTATION_SCHEMA_VERSION);
    assert.strictEqual(payload.schemaVersion, 2);
    assert.strictEqual(payload.tokenUsage.totalTokens, 42000);
    assert.strictEqual(payload.tokenUsage.extensions.length, 2);
    assert.strictEqual(payload.tokenUsage.extensions[1].amountVrsc, null);
  });

  it('normalizes junk: coerces counts to non-negative ints, drops unknown keys', () => {
    const dirty = {
      promptTokens: 10.9, completionTokens: -5, totalTokens: '999' as unknown as number,
      llmCalls: 3, evil: 'inject',
      extensions: [{ estimatedTokens: 7.7, amountVrsc: Infinity, granted: 1 as unknown as boolean, evil: 'x' }],
    };
    const payload = generateAttestationPayload({ ...baseParams, tokenUsage: dirty as never });
    const u = payload.tokenUsage;
    assert.strictEqual(u.promptTokens, 10);     // floored
    assert.strictEqual(u.completionTokens, 0);  // negative → 0
    assert.strictEqual(u.totalTokens, 999);     // numeric string coerced
    assert.strictEqual((u as Record<string, unknown>).evil, undefined, 'unknown top-level key dropped');
    assert.strictEqual(u.extensions[0].estimatedTokens, 7);
    assert.strictEqual(u.extensions[0].amountVrsc, null, 'non-finite VRSC → null');
    assert.strictEqual(u.extensions[0].granted, true);
    assert.strictEqual((u.extensions[0] as Record<string, unknown>).evil, undefined, 'unknown ext key dropped');
  });

  it('the signature covers tokenUsage — tampering breaks verification', () => {
    const kp = generateKeypair('verustest');
    const payload = generateAttestationPayload({ ...baseParams, tokenUsage: usage });
    const att = signAttestation(payload, kp.wif, 'verustest');
    const rAddr = kp.address; // primary R-address

    assert.strictEqual(verifyAttestationSignature(att, rAddr), true, 'valid v2 signature');

    // Flip a usage number → signature must no longer verify
    const tampered = { ...att, tokenUsage: { ...att.tokenUsage, totalTokens: 999999 } };
    assert.strictEqual(verifyAttestationSignature(tampered, rAddr), false, 'tampered usage rejected');

    // Flip an extension grant flag → also rejected
    const tampered2 = {
      ...att,
      tokenUsage: {
        ...att.tokenUsage,
        extensions: [{ ...att.tokenUsage.extensions[0], granted: false }, att.tokenUsage.extensions[1]],
      },
    };
    assert.strictEqual(verifyAttestationSignature(tampered2, rAddr), false, 'tampered extension rejected');
  });

  it('canonical bytes are deterministic regardless of input key order', () => {
    const a = generateAttestationPayload({ ...baseParams, tokenUsage: usage });
    const reordered = {
      tokenUsage: {
        extensions: usage.extensions, llmCalls: 7, totalTokens: 42000,
        completionTokens: 12000, promptTokens: 30000,
      },
      attestedBy: baseParams.attestedBy, jobId: baseParams.jobId,
      containerId: baseParams.containerId, createdAt: baseParams.createdAt,
      destroyedAt: baseParams.destroyedAt, dataVolumes: baseParams.dataVolumes,
      deletionMethod: baseParams.deletionMethod,
    };
    const b = generateAttestationPayload(reordered as never);
    assert.strictEqual(jcs(a), jcs(b), 'JCS output identical');
  });

  it('verifyAttestationFormat accepts a valid v2 attestation', () => {
    const kp = generateKeypair('verustest');
    const payload = generateAttestationPayload({ ...baseParams, tokenUsage: usage });
    const att = signAttestation(payload, kp.wif, 'verustest');
    assert.strictEqual(verifyAttestationFormat(att), true);
  });

  it('verifyAttestationFormat rejects malformed tokenUsage (fail closed)', () => {
    const kp = generateKeypair('verustest');
    const sign = (p: unknown) => signAttestation(p, kp.wif, 'verustest');

    const negCount = sign({ ...baseParams, schemaVersion: 2, tokenUsage: { ...usage, promptTokens: -1 } });
    assert.throws(() => verifyAttestationFormat(negCount), /promptTokens/);

    const badExt = sign({
      ...baseParams, schemaVersion: 2,
      tokenUsage: { ...usage, extensions: [{ estimatedTokens: 1, amountVrsc: 0, granted: 'yes' }] },
    });
    assert.throws(() => verifyAttestationFormat(badExt), /granted/);

    const notArray = sign({ ...baseParams, schemaVersion: 2, tokenUsage: { ...usage, extensions: 'nope' } });
    assert.throws(() => verifyAttestationFormat(notArray), /extensions/);
  });
});
