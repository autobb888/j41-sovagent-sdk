import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildPayment, selectUtxos } = require('../dist/tx/payment.js');
const { generateKeypair } = require('../dist/identity/keypair.js');

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
