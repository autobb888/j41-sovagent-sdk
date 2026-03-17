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

  it('signs a challenge (CIdentitySignature format)', () => {
    const kp = generateKeypair('verustest');
    const sig = signChallenge(kp.wif, 'j41-onboard:test-uuid', kp.address, 'verustest');
    
    assert.ok(sig, 'Signature should exist');
    // Serialized CIdentitySignature: version(1) + hashType(1) + blockHeight(4) + numSigs(1) + sigLen(1) + sig(65) = 73 bytes
    const sigBuf = Buffer.from(sig, 'base64');
    assert.strictEqual(sigBuf.length, 73, 'Serialized CIdentitySignature should be 73 bytes');
    assert.strictEqual(sigBuf[0], 2, 'Version should be 2');
    assert.strictEqual(sigBuf[1], 5, 'HashType should be SHA256 (5)');
    
    console.log(`  Challenge sig: ${sig.substring(0, 20)}...`);
  });
});

describe('UTXO Selection (stub)', () => {
  it('selectUtxos throws not-implemented (stub)', () => {
    const utxos = [
      { txid: 'a', vout: 0, satoshis: 100_000, height: 1 },
    ];

    assert.throws(
      () => selectUtxos(utxos, 600_000),
      /Not implemented/,
    );
  });
});

describe('Transaction Builder (stub)', () => {
  it('buildPayment throws not-implemented (stub)', () => {
    const kp = generateKeypair('verustest');
    const recipient = generateKeypair('verustest');
    const utxos = [
      { txid: 'a'.repeat(64), vout: 0, satoshis: 1_000_000, height: 100 },
    ];

    assert.throws(
      () => buildPayment({
        wif: kp.wif,
        toAddress: recipient.address,
        amount: 500_000,
        utxos,
        fee: 10_000,
        network: 'verustest',
      }),
      /Not implemented/,
    );
  });

  it('derives address from WIF', () => {
    const kp = generateKeypair('verustest');
    const addr = wifToAddress(kp.wif, 'verustest');
    assert.strictEqual(addr, kp.address);
  });
});
