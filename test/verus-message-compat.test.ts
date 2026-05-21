// test/verus-message-compat.test.ts
// GATE for the @noble migration: the noble implementation MUST interoperate
// with the legacy bitcoinjs-message path (same magic hash, mutually verifiable
// signatures, and byte-identical deterministic output) across many random
// vectors before it can become the production signer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bitcoinMessage from 'bitcoinjs-message';
import bs58check from 'bs58check';
import { magicHash, signVerusMessage, verifyVerusMessage } from '../src/identity/verus-message.js';
import { generateKeypair } from '../src/index.js';

const PREFIX = '\x15Verus signed data:\n';

// Decode a WIF to { priv, compressed } for the legacy signer.
function wifParts(wif: string) {
  const d = bs58check.decode(wif);
  return { priv: Buffer.from(d.subarray(1, 33)), compressed: d.length === 34 };
}

const N = 200;

test('magicHash matches bitcoinjs-message.magicHash', () => {
  for (let i = 0; i < N; i++) {
    const msg = `m-${i}-${Math.random().toString(36).slice(2)}-${'x'.repeat(i % 300)}`;
    const a = Buffer.from(magicHash(msg));
    const b = (bitcoinMessage as any).magicHash(msg, PREFIX);
    assert.ok(a.equals(b), `magicHash mismatch at ${i}`);
  }
});

test('noble signature is byte-identical to bitcoinjs-message.sign', () => {
  for (let i = 0; i < N; i++) {
    const kp = generateKeypair(i % 2 ? 'verus' : 'verustest');
    const msg = `payload ${i} ${Math.random()}`;
    const { priv, compressed } = wifParts(kp.wif);
    const legacy = (bitcoinMessage as any).sign(msg, priv, compressed, PREFIX).toString('base64');
    const noble = signVerusMessage(kp.wif, msg);
    assert.equal(noble, legacy, `byte mismatch at ${i}`);
  }
});

test('noble verifies signatures produced by bitcoinjs-message', () => {
  for (let i = 0; i < N; i++) {
    const kp = generateKeypair('verustest');
    const msg = `cross ${i} ${Math.random()}`;
    const { priv, compressed } = wifParts(kp.wif);
    const legacySig = (bitcoinMessage as any).sign(msg, priv, compressed, PREFIX).toString('base64');
    assert.ok(verifyVerusMessage(msg, kp.address, legacySig), `noble failed to verify legacy sig at ${i}`);
  }
});

test('bitcoinjs-message verifies signatures produced by noble', () => {
  for (let i = 0; i < N; i++) {
    const kp = generateKeypair('verustest');
    const msg = `cross2 ${i} ${Math.random()}`;
    const nobleSig = signVerusMessage(kp.wif, msg);
    assert.ok((bitcoinMessage as any).verify(msg, kp.address, nobleSig, PREFIX), `legacy failed to verify noble sig at ${i}`);
  }
});

test('noble verify rejects tampered message / wrong address / malformed sig', () => {
  const kp = generateKeypair('verustest');
  const other = generateKeypair('verustest');
  const sig = signVerusMessage(kp.wif, 'hello');
  assert.ok(verifyVerusMessage('hello', kp.address, sig));
  assert.ok(!verifyVerusMessage('hello!', kp.address, sig));        // tampered msg
  assert.ok(!verifyVerusMessage('hello', other.address, sig));      // wrong address
  assert.ok(!verifyVerusMessage('hello', kp.address, ''));          // empty
  assert.ok(!verifyVerusMessage('hello', kp.address, 'AAAA'));      // malformed
});
