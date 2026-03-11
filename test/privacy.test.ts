import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { generateAttestationPayload, signAttestation, verifyAttestationFormat } = require('../dist/privacy/attestation.js');
const { PRIVACY_TIERS } = require('../dist/privacy/tiers.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { privacyPremium } = require('../dist/pricing/calculator.js');

const sampleParams = {
  jobId: 'job-123',
  containerId: 'container-abc',
  createdAt: '2025-01-01T00:00:00.000Z',
  destroyedAt: '2025-01-01T00:05:00.000Z',
  dataVolumes: ['/tmp/vol1'],
  deletionMethod: 'container-destroy+volume-rm',
  attestedBy: 'testagent.agentplatform@',
};

describe('Privacy — Attestation & Tiers', () => {
  it('generateAttestationPayload produces canonical JSON with sorted keys', () => {
    const payload = generateAttestationPayload(sampleParams);
    const keys = Object.keys(payload);
    const sorted = [...keys].sort();
    assert.deepStrictEqual(keys, sorted, 'Keys should be alphabetically sorted');
  });

  it('signAttestation produces valid base64 signature', () => {
    const kp = generateKeypair('verustest');
    const payload = generateAttestationPayload(sampleParams);
    const attestation = signAttestation(payload, kp.wif, 'verustest');
    assert.ok(attestation.signature, 'Signature should exist');
    const buf = Buffer.from(attestation.signature, 'base64');
    assert.strictEqual(buf.length, 65, 'Signature should decode to 65 bytes');
  });

  it('verifyAttestationFormat validates required fields, rejects missing fields', () => {
    const kp = generateKeypair('verustest');
    const payload = generateAttestationPayload(sampleParams);
    const attestation = signAttestation(payload, kp.wif, 'verustest');
    
    // Valid attestation should pass
    assert.ok(verifyAttestationFormat(attestation));
    
    // Missing field should throw
    const { signature, ...incomplete } = attestation;
    assert.throws(() => verifyAttestationFormat(incomplete), /Missing or invalid field: signature/);
    
    // null should throw
    assert.throws(() => verifyAttestationFormat(null), /non-null object/);
  });

  it('all 3 PRIVACY_TIERS have correct metadata', () => {
    const tiers = ['standard', 'private', 'sovereign'] as const;
    for (const tier of tiers) {
      const meta = PRIVACY_TIERS[tier];
      assert.ok(meta, `${tier} should exist`);
      assert.ok(meta.label, `${tier} should have label`);
      assert.ok(typeof meta.badge === 'string', `${tier} should have badge`);
      assert.ok(meta.premiumRange, `${tier} should have premiumRange`);
      assert.ok(typeof meta.premiumRange.min === 'number');
      assert.ok(typeof meta.premiumRange.max === 'number');
    }
  });

  it('tier premium multipliers match pricing calculator values', () => {
    // standard=1.0, private=1.33, sovereign=1.83
    assert.strictEqual(privacyPremium(1, 'standard'), 1.0);
    assert.strictEqual(privacyPremium(1, 'private'), 1.33);
    assert.strictEqual(privacyPremium(1, 'sovereign'), 1.83);
  });
});
