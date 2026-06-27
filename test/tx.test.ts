import { describe, it, test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildPayment, selectUtxos, DEFAULT_TX_EXPIRY_DELTA } = require('../dist/tx/payment.js');
const { generateKeypair } = require('../dist/identity/keypair.js');
const utxolib = require('@bitgo/utxo-lib');

// amount/fee args to selectUtxos/buildPayment are in VRSC (whole units, scaled to satoshis internally).
describe('Transaction Builder', () => {
  it('selectUtxos throws on insufficient funds', () => {
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 100, height: 1 }];
    assert.throws(
      () => selectUtxos(utxos, 1), // 1 VRSC = 100M sats >> 100 sats
      /[Ii]nsufficient funds/,
    );
  });

  it('buildPayment throws on insufficient funds', () => {
    const kp = generateKeypair('verustest');
    const recipient = generateKeypair('verustest');
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 1_000, height: 1 }];

    assert.throws(
      () => buildPayment({ wif: kp.wif, toAddress: recipient.address, amount: 1, utxos, network: 'verustest' }),
      /[Ii]nsufficient funds/,
    );
  });
});

test('DEFAULT_TX_EXPIRY_DELTA is exported and equals 60', () => {
  assert.strictEqual(DEFAULT_TX_EXPIRY_DELTA, 60);
});

test('buildPayment sets nExpiryHeight from expiryHeight param', () => {
  const kp = generateKeypair('verustest');
  const utxos = [{ txid: '11'.repeat(32), vout: 0, satoshis: 5_000_000_00 }];
  const hex = buildPayment({
    wif: kp.wif, toAddress: kp.address, amount: 1, utxos,
    changeAddress: kp.address, network: 'verustest', expiryHeight: 123456,
  });
  const net = utxolib.networks.verustest || utxolib.networks.verus;
  const tx = utxolib.Transaction.fromHex(typeof hex === 'string' ? hex : hex.rawhex, net);
  assert.strictEqual(tx.expiryHeight, 123456);
});
