import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { J41Agent } = require('../dist/agent.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const payment = require('../dist/tx/payment.js');

// Audit finding M6 (MED, signed-money footgun): the SDK money paths defaulted
// network/currency to TESTNET, and that testnet default flowed into SIGNED
// artifacts. A mainnet-configured agent that omitted `currency`/`network`
// would therefore sign a wrong-currency bounty commitment ('VRSCTEST' on
// mainnet) or build un-broadcastable transactions. These tests pin the fix:
// the currency/network defaults must DERIVE from the agent's configured
// network, never a hardcoded testnet literal.

/**
 * Minimal RemoteSigner that captures the exact bytes the agent asks it to
 * sign. Using a signer (rather than a WIF) lets us inspect the SIGNED message
 * directly — proving the derived currency reaches the signature, not merely
 * the wire payload.
 */
function capturingSigner() {
  const signed: string[] = [];
  return {
    signed,
    async signMessage(message: string) {
      signed.push(message);
      return 'AAAA-fake-signature';
    },
    async signBrokered() {
      throw new Error('not used in these tests');
    },
  };
}

describe('Audit M6 — money-path defaults derive from agent network', () => {
  it('postBounty on a MAINNET agent signs Currency:VRSC (not VRSCTEST)', async () => {
    const signer = capturingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      network: 'verus', // mainnet
    });

    let sentCurrency: string | undefined;
    agent.client.postBounty = async (payload: any) => {
      sentCurrency = payload.currency;
      return { id: 'bounty-1', status: 'open' };
    };

    await agent.postBounty({
      title: 'Translate doc',
      description: 'EN→FR',
      amount: 10,
      // currency intentionally OMITTED — must derive from mainnet network
    });

    assert.strictEqual(signer.signed.length, 1, 'exactly one message signed');
    const msg = signer.signed[0];
    assert.match(msg, /\|Currency:VRSC\|/, 'signed message must carry Currency:VRSC on mainnet');
    assert.doesNotMatch(msg, /VRSCTEST/, 'mainnet signed message must NOT carry VRSCTEST');
    assert.strictEqual(sentCurrency, 'VRSC', 'wire payload currency must be VRSC on mainnet');
  });

  it('postBounty on a TESTNET agent still signs Currency:VRSCTEST', async () => {
    const signer = capturingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      network: 'verustest',
    });

    let sentCurrency: string | undefined;
    agent.client.postBounty = async (payload: any) => {
      sentCurrency = payload.currency;
      return { id: 'bounty-2', status: 'open' };
    };

    await agent.postBounty({
      title: 'Translate doc',
      description: 'EN→FR',
      amount: 10,
    });

    const msg = signer.signed[0];
    assert.match(msg, /\|Currency:VRSCTEST\|/, 'testnet signed message must carry Currency:VRSCTEST');
    assert.strictEqual(sentCurrency, 'VRSCTEST', 'wire payload currency must be VRSCTEST on testnet');
  });

  it('postBounty still honors an EXPLICIT currency override', async () => {
    const signer = capturingSigner();
    const agent = new J41Agent({
      apiUrl: 'https://api.example.com',
      signer,
      network: 'verus',
    });

    agent.client.postBounty = async () => ({ id: 'b3', status: 'open' });

    await agent.postBounty({
      title: 'X',
      description: 'Y',
      amount: 1,
      currency: 'USDC', // explicit override wins over derivation
    });

    assert.match(signer.signed[0], /\|Currency:USDC\|/, 'explicit currency override must be honored');
  });

  it('agent threads its own network into the payment/tx path (mainnet → verus)', async () => {
    // Spy on the tx builder the agent dynamically imports. tsc emits
    // __importStar(require('./tx/payment.js')) and short-circuits to the same
    // CJS module object (mod.__esModule === true), so patching the export here
    // is visible to the agent's import.
    const origBuild = payment.buildPayment;
    const origWifToAddress = payment.wifToAddress;
    const nets: string[] = [];
    payment.buildPayment = (params: any) => {
      nets.push(params.network);
      // Return a minimal "built" shape so sendCurrency can proceed to broadcast.
      return { rawhex: 'deadbeef', spentUtxos: [], changeUtxo: null };
    };

    try {
      const kp = generateKeypair('verus');
      const agent = new J41Agent({
        apiUrl: 'https://api.example.com',
        wif: kp.wif,
        network: 'verus',
      });

      // Stub network/login so sendCurrency reaches buildPayment offline.
      agent.login = async () => 'tok';
      agent.client.getUtxos = async () => ({
        utxos: [{ txid: 'a'.repeat(64), vout: 0, satoshis: 100_000_000, address: origWifToAddress(kp.wif, 'verus') }],
      });
      agent.client.broadcast = async () => 'txid-123';

      // Send to the agent's own R-address (a valid R-address dest, no VerusID resolution).
      const ownR = origWifToAddress(kp.wif, 'verus');
      await agent.sendCurrency(ownR, 0.5);

      assert.ok(nets.length >= 1, 'buildPayment was invoked');
      assert.strictEqual(nets[0], 'verus', 'mainnet agent must pass network=verus into buildPayment');
      assert.ok(!nets.includes('verustest'), 'mainnet agent must never pass verustest into buildPayment');
    } finally {
      payment.buildPayment = origBuild;
      payment.wifToAddress = origWifToAddress;
    }
  });
});
