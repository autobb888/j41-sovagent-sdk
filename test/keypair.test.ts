import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// These use require() internally for @bitgo/utxo-lib (CommonJS)
const { generateKeypair, keypairFromWIF } = require('../dist/identity/keypair.js');
const { signMessage, signChallenge } = require('../dist/identity/signer.js');
const { buildPayment, selectUtxos, wifToAddress } = require('../dist/tx/payment.js');

describe('Keypair Generation', () => {
  it('generates a valid keypair', () => {
    const kp = generateKeypair('verustest');
    
    assert.ok(kp.wif, 'WIF should exist');
    assert.ok(kp.pubkey, 'Pubkey should exist');
    assert.ok(kp.address, 'Address should exist');
    
    // WIF starts with U (compressed, verustest)
    assert.ok(kp.wif.startsWith('U'), `WIF should start with U, got: ${kp.wif[0]}`);
    
    // Pubkey is 33 bytes compressed (66 hex chars)
    assert.strictEqual(kp.pubkey.length, 66, 'Pubkey should be 66 hex chars');
    assert.ok(kp.pubkey.startsWith('02') || kp.pubkey.startsWith('03'), 'Pubkey should start with 02 or 03');
    
    // R-address starts with R
    assert.ok(kp.address.startsWith('R'), `Address should start with R, got: ${kp.address[0]}`);
    
    console.log(`  Generated: ${kp.address}`);
  });

  it('restores keypair from WIF', () => {
    const kp1 = generateKeypair('verustest');
    const kp2 = keypairFromWIF(kp1.wif, 'verustest');
    
    assert.strictEqual(kp2.address, kp1.address, 'Address should match');
    assert.strictEqual(kp2.pubkey, kp1.pubkey, 'Pubkey should match');
    assert.strictEqual(kp2.wif, kp1.wif, 'WIF should match');
  });

  it('generates unique keypairs', () => {
    const kp1 = generateKeypair('verustest');
    const kp2 = generateKeypair('verustest');
    
    assert.notStrictEqual(kp1.address, kp2.address, 'Addresses should be different');
    assert.notStrictEqual(kp1.wif, kp2.wif, 'WIFs should be different');
  });
});

describe('Message Signing', () => {
  it('signs a message', () => {
    const kp = generateKeypair('verustest');
    const sig = signMessage(kp.wif, 'Hello J41!', 'verustest');
    
    assert.ok(sig, 'Signature should exist');
    assert.ok(sig.length > 0, 'Signature should not be empty');
    
    // Base64 signature should decode to 65 bytes
    const sigBuf = Buffer.from(sig, 'base64');
    assert.strictEqual(sigBuf.length, 65, 'Compact signature should be 65 bytes');
    
    console.log(`  Signature: ${sig.substring(0, 20)}...`);
  });

  it('signs a challenge (returns base64 string)', () => {
    const kp = generateKeypair('verustest');
    const sig = signChallenge(kp.wif, 'j41-onboard:test-uuid', kp.address, 'verustest');

    assert.ok(sig, 'Signature should exist');
    // Compact ECDSA signature is 65 bytes; CIdentitySignature wrapping (when used) adds metadata.
    // Implementation currently returns the 65-byte compact form; both forms are valid Verus signatures.
    const sigBuf = Buffer.from(sig, 'base64');
    assert.ok(sigBuf.length === 65 || sigBuf.length === 73,
      `Signature should be 65 (compact) or 73 (CIdentitySignature) bytes, got ${sigBuf.length}`);
  });
});

// selectUtxos and buildPayment take amount/fee in VRSC (whole units). Integration with
// utxo-lib's transaction encoding is exercised in the dispatcher's live flows; these unit
// tests focus on the input-validation contract.
describe('UTXO Selection', () => {
  it('selectUtxos throws on insufficient funds', () => {
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 100_000, height: 1 }];
    assert.throws(
      () => selectUtxos(utxos, 1), // need 1 VRSC = 100M sats, have 100k
      /[Ii]nsufficient funds/,
    );
  });
});

describe('Transaction Builder', () => {
  it('buildPayment throws on insufficient funds', () => {
    const kp = generateKeypair('verustest');
    const recipient = generateKeypair('verustest');
    const utxos = [{ txid: 'a'.repeat(64), vout: 0, satoshis: 1_000, height: 100 }];
    assert.throws(
      () => buildPayment({
        wif: kp.wif,
        toAddress: recipient.address,
        amount: 1,
        utxos,
        fee: 0.0001,
        network: 'verustest',
      }),
      /[Ii]nsufficient funds/,
    );
  });

  it('derives address from WIF', () => {
    const kp = generateKeypair('verustest');
    const addr = wifToAddress(kp.wif, 'verustest');
    assert.strictEqual(addr, kp.address);
  });
});
