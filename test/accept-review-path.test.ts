import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const { VDXF_KEYS } = require('../dist/onboarding/vdxf.js');

// review.record is the only i-address allowed on-chain by acceptReview's H8 whitelist.
const REVIEW_RECORD_IADDR = VDXF_KEYS.review.record; // iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad
const PAYADDRESS_IADDR = VDXF_KEYS.agent.payAddress; // iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD

// Build an agent with a mock client. `inbox` is what getInboxItem returns.
// `onChainInfo` lets a test throw a sentinel once acceptReview reaches the
// tx-build stage (proving it got past the whitelist without a real broadcast).
function makeAgent(inbox: any, opts: { sentinel?: Error } = {}) {
  const kp = generateKeypair('verustest');
  const agent = new J41Agent({
    apiUrl: 'https://api.example.com',
    wif: kp.wif,
    iAddress: 'iAgentTestAddr000000000000000000000',
    identityName: 'reviewtest.agentplatform@',
  });
  const calls = { broadcast: 0, getChainInfo: 0 };
  agent.client.getInboxItem = async () => ({ data: inbox });
  agent.client.getIdentityRaw = async () => ({
    data: { identity: {}, prevOutput: { txid: 'aa', n: 0 }, blockHeight: 100, txid: 'aa' },
  });
  agent.client.getUtxos = async () => ({ utxos: [{ txid: 'bb', outputIndex: 0, satoshis: 100000 }] });
  agent.client.getChainInfo = async () => {
    calls.getChainInfo++;
    if (opts.sentinel) throw opts.sentinel;
    return { blockHeight: 100 };
  };
  agent.client.broadcast = async () => {
    calls.broadcast++;
    return { txid: 'deadbeef' };
  };
  return { agent, calls };
}

describe('acceptReview on-chain shape safety', () => {
  it('path-2: null vdxfData throws (refuses to synthesize) and never broadcasts', async () => {
    const { agent, calls } = makeAgent({
      id: 'r1', status: 'pending', senderVerusId: 'buyer.vrsc@',
      jobHash: 'jh1', rating: 5, message: 'great', vdxfData: null,
    });
    await assert.rejects(
      agent.acceptReview('r1'),
      /has no VDXF review\.record — refusing to synthesize/,
    );
    assert.strictEqual(calls.broadcast, 0, 'must not write to chain');
    assert.strictEqual(calls.getChainInfo, 0, 'must fail before tx build');
  });

  it('path-2: empty vdxfData object also throws, never broadcasts', async () => {
    const { agent, calls } = makeAgent({
      id: 'r2', status: 'pending', senderVerusId: 'buyer.vrsc@',
      jobHash: 'jh2', rating: 4, message: null, vdxfData: {},
    });
    await assert.rejects(
      agent.acceptReview('r2'),
      /has no VDXF review\.record — refusing to synthesize/,
    );
    assert.strictEqual(calls.broadcast, 0, 'must not write to chain');
  });

  it('H8 whitelist still enforced: non-review i-address is dropped and rejected', async () => {
    // The fcc0fb82-style / tampering case: keys present but none in review.*
    const { agent, calls } = makeAgent({
      id: 'r3', status: 'pending', senderVerusId: 'buyer.vrsc@', jobHash: 'jh3',
      rating: 5, message: 'x',
      vdxfData: { [PAYADDRESS_IADDR]: 'attacker-pay-addr', someField: 'junk' },
    });
    await assert.rejects(
      agent.acceptReview('r3'),
      /contained no review\.\* keys after whitelist/,
    );
    assert.strictEqual(calls.broadcast, 0, 'must not write attacker key to chain');
  });

  it('path-1: a properly-keyed review.record passes the whitelist and proceeds to tx build', async () => {
    // Verbatim passthrough: value under the review.record i-address is accepted.
    // A sentinel thrown at getChainInfo proves we got past the whitelist into
    // the build path (without needing a real tx/broadcast).
    const sentinel = new Error('SENTINEL_REACHED_TX_BUILD');
    const hexRecord = Buffer.from(
      JSON.stringify({ buyer: 'buyer.vrsc@', jobHash: 'jh4', rating: 5, message: 'ok', signature: 'sig', timestamp: 1700000000 }),
    ).toString('hex');
    const { agent, calls } = makeAgent(
      {
        id: 'r4', status: 'pending', senderVerusId: 'buyer.vrsc@', jobHash: 'jh4',
        rating: 5, message: 'ok',
        vdxfData: { [REVIEW_RECORD_IADDR]: [hexRecord] },
      },
      { sentinel },
    );
    await assert.rejects(agent.acceptReview('r4'), /SENTINEL_REACHED_TX_BUILD/);
    assert.strictEqual(calls.getChainInfo, 1, 'review.record accepted → reached tx build');
  });
});
