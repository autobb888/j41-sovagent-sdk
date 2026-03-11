import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { buildPayment, selectUtxos } = require('../dist/tx/payment.js');
const { generateKeypair } = require('../dist/identity/keypair.js');

describe('Transaction Builder (stub)', () => {
  it('selectUtxos throws not-implemented (stub)', () => {
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 1000, height: 1 }];

    assert.throws(
      () => selectUtxos(utxos, 500),
      /Not implemented/,
    );
  });

  it('buildPayment throws not-implemented (stub)', () => {
    const kp = generateKeypair('verustest');
    const recipient = generateKeypair('verustest');
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 1000, height: 1 }];

    assert.throws(
      () => buildPayment({ wif: kp.wif, toAddress: recipient.address, amount: 500, utxos, network: 'verustest' }),
      /Not implemented/,
    );
  });
});
