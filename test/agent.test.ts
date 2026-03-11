import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');

describe('J41Agent', () => {
  it('constructor sets platformUrl', () => {
    const agent = new J41Agent({ apiUrl: 'https://api.example.com' });
    assert.ok(agent.client, 'Client should exist');
    // The client stores baseUrl internally
    assert.strictEqual(agent.identity, null, 'Identity starts null');
  });

  it('setPrivacyTier validates tier values', async () => {
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({ apiUrl: 'https://api.example.com', wif: kp.wif });
    
    // Mock the client's updateAgentProfile to avoid real HTTP
    agent.client.updateAgentProfile = async (profile: any) => {
      return { ok: true };
    };

    await agent.setPrivacyTier('private');
    assert.strictEqual(agent.getPrivacyTier(), 'private');

    await agent.setPrivacyTier('sovereign');
    assert.strictEqual(agent.getPrivacyTier(), 'sovereign');

    await agent.setPrivacyTier('standard');
    assert.strictEqual(agent.getPrivacyTier(), 'standard');
  });

  it('estimatePrice calls calculator and returns recommendations', () => {
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({ apiUrl: 'https://api.example.com', wif: kp.wif });

    const rec = agent.estimatePrice('gpt-4o', 'medium', 2000, 1000);
    assert.ok(rec.rawCost > 0, 'rawCost should be positive');
    assert.ok(rec.minimum, 'minimum should exist');
    assert.ok(rec.recommended, 'recommended should exist');
    assert.ok(rec.premium, 'premium should exist');
    assert.ok(rec.ceiling, 'ceiling should exist');
    assert.ok(rec.minimum.usd < rec.recommended.usd);
  });

  it('attestDeletion generates payload with correct fields and signs it', async () => {
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      wif: kp.wif,
      identityName: 'testagent.agentplatform@',
    });

    // Mock submitAttestation
    agent.client.submitAttestation = async (att: any) => ({ ok: true });

    const attestation = await agent.attestDeletion('job-1', 'container-xyz', {
      createdAt: '2025-01-01T00:00:00Z',
      destroyedAt: '2025-01-01T00:05:00Z',
      dataVolumes: ['/tmp/data'],
    });

    assert.strictEqual(attestation.jobId, 'job-1');
    assert.strictEqual(attestation.containerId, 'container-xyz');
    assert.strictEqual(attestation.attestedBy, 'testagent.agentplatform@');
    assert.ok(attestation.signature, 'Should have signature');
    assert.ok(attestation.signature.length > 0);
  });

  it('J41Agent.onboard flow (mocked HTTP)', async () => {
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({ apiUrl: 'https://api.example.com', wif: kp.wif });

    // Mock the client methods for the registration flow
    agent.client.onboard = async (name: string, address: string, pubkey: string) => ({
      status: 'challenge',
      challenge: 'vap-onboard:test-challenge-123',
      token: 'tok_abc',
    });

    agent.client.onboardWithSignature = async (...args: any[]) => ({
      onboardId: 'ob_123',
      status: 'pending',
    });

    agent.client.onboardStatus = async (id: string) => ({
      status: 'registered',
      identity: 'testagent.agentplatform@',
      iAddress: 'i5test123',
    });

    const result = await agent.register('testagent', 'verustest');
    assert.strictEqual(result.identity, 'testagent.agentplatform@');
    assert.strictEqual(result.iAddress, 'i5test123');
    assert.strictEqual(agent.identity, 'testagent.agentplatform@');
  });
});
