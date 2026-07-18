import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

const ATTESTATION_IADDR = VDXF_KEYS.review.attestation; // i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv
const REVIEW_RECORD_IADDR = VDXF_KEYS.review.record;     // must be DROPPED by the attestation allowlist

function makeAgent(inbox: any, opts: { sentinel?: Error } = {}) {
  const kp = generateKeypair('verustest');
  const agent = new J41Agent({
    apiUrl: 'https://api.example.com', wif: kp.wif,
    iAddress: 'iAgentTestAddr000000000000000000000', identityName: 'attesttest.agentplatform@',
  });
  const calls = { broadcast: 0, getChainInfo: 0, accepted: 0 };
  agent.client.getInboxItem = async () => ({ data: inbox });
  agent.client.getIdentityRaw = async () => ({ data: { identity: {}, prevOutput: { txid: 'aa', n: 0 }, blockHeight: 100, txid: 'aa' } });
  agent.client.getUtxos = async () => ({ utxos: [{ txid: 'bb', outputIndex: 0, satoshis: 100000 }] });
  agent.client.getChainInfo = async () => { calls.getChainInfo++; if (opts.sentinel) throw opts.sentinel; return { blockHeight: 100 }; };
  agent.client.broadcast = async () => { calls.broadcast++; return { txid: 'deadbeef' }; };
  agent.client.acceptInboxItem = async () => { calls.accepted++; };
  return { agent, calls };
}

describe('acceptAttestationTuple', () => {
  it('refuses to synthesize when vdxfData is null; never broadcasts', async () => {
    const { agent, calls } = makeAgent({ id: 'a1', status: 'pending', vdxfData: null });
    await assert.rejects(agent.acceptAttestationTuple('a1'), /no VDXF review\.attestation — refusing to synthesize/);
    assert.strictEqual(calls.broadcast, 0);
    assert.strictEqual(calls.getChainInfo, 0);
  });

  it('drops a non-attestation key (even review.record) and rejects', async () => {
    const { agent, calls } = makeAgent({
      id: 'a2', status: 'pending',
      vdxfData: { [REVIEW_RECORD_IADDR]: ['deadbeef'] }, // record is NOT allowed here
    });
    await assert.rejects(agent.acceptAttestationTuple('a2'), /contained no review\.attestation keys after whitelist/);
    assert.strictEqual(calls.broadcast, 0);
  });

  it('passes a properly-keyed attestation through the whitelist to tx build', async () => {
    const sentinel = new Error('SENTINEL_REACHED_TX_BUILD');
    const hex = Buffer.from(JSON.stringify({ jobHash: 'jh', buyer: 'iBuyer', rating: 5, timestamp: 1700000000, msgHash: 'abcd', signature: 'sig' })).toString('hex');
    const { agent, calls } = makeAgent({ id: 'a3', status: 'pending', vdxfData: { [ATTESTATION_IADDR]: hex } }, { sentinel });
    await assert.rejects(agent.acceptAttestationTuple('a3'), /SENTINEL_REACHED_TX_BUILD/);
    assert.strictEqual(calls.getChainInfo, 1, 'attestation accepted → reached tx build');
    assert.strictEqual(calls.broadcast, 0);
  });

  it('skips a non-pending item', async () => {
    const { agent, calls } = makeAgent({ id: 'a4', status: 'accepted', vdxfData: null });
    await agent.acceptAttestationTuple('a4');
    assert.strictEqual(calls.broadcast, 0);
  });
});
