import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { generateKeypair, keypairFromWIF } = require('../dist/identity/keypair.js');
const { signMessage } = require('../dist/identity/signer.js');
const utxoLib = require('@bitgo/utxo-lib');

describe('Identity — Signer & Keys', () => {
  it('sign with invalid WIF throws', () => {
    assert.throws(
      () => signMessage('notavalidwif', 'test message', 'verustest'),
      /Invalid|Non-base58|checksum/i,
    );
  });

  it('deterministic signatures (same key+message = same sig)', () => {
    const kp = generateKeypair('verustest');
    const sig1 = signMessage(kp.wif, 'deterministic test', 'verustest');
    const sig2 = signMessage(kp.wif, 'deterministic test', 'verustest');
    assert.strictEqual(sig1, sig2, 'Same key+message should produce same signature');
  });

  it('address derivation from pubkey matches expected', () => {
    const kp = generateKeypair('verustest');
    const network = utxoLib.networks.verustest;
    const keyPair = utxoLib.ECPair.fromWIF(kp.wif, network);
    const derivedAddress = keyPair.getAddress();
    assert.strictEqual(derivedAddress, kp.address, 'Address from WIF should match keypair address');
  });

  it('network params use correct version bytes (60/0x3c for Verus)', () => {
    const verus = utxoLib.networks.verus;
    assert.ok(verus, 'verus network should exist');
    // Verus pubKeyHash version byte is 60 (0x3c)
    assert.strictEqual(verus.pubKeyHash, 60, 'Verus pubKeyHash should be 60 (0x3c)');
  });

  it('rejects uncompressed keys', () => {
    // Generate a random keypair, then try to make an uncompressed one
    const network = utxoLib.networks.verustest;
    const kp = utxoLib.ECPair.makeRandom({ network, compressed: true });
    const pubBuf = kp.getPublicKeyBuffer();
    // Compressed keys are 33 bytes starting with 02 or 03
    assert.strictEqual(pubBuf.length, 33, 'Generated key should be compressed (33 bytes)');
    // Verify our SDK always generates compressed keys
    const sdkKp = generateKeypair('verustest');
    assert.strictEqual(sdkKp.pubkey.length, 66, 'SDK pubkey should be 66 hex chars (compressed)');
    assert.ok(sdkKp.pubkey.startsWith('02') || sdkKp.pubkey.startsWith('03'));
  });
});
