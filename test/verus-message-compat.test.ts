// test/verus-message-compat.test.ts
//
// GATE for the Verus message sign/verify implementation: must match the
// verus daemon's signmessage/verifymessage exactly.
//
// HISTORY / WARNING: an earlier version of this test cross-checked the SDK
// implementation against bitcoinjs-message. That cross-test was TAUTOLOGICAL —
// both clients inherited the same @bitgo/utxo-lib `messagePrefix` (`\x15Verus
// signed data:\n`) and the same Bitcoin-style sha256d magic-hash construction.
// They agreed perfectly with each other AND were both incompatible with
// verusd (which uses a different algorithm: single SHA-256 over a pre-hashed
// message, with the prefix properly varint-length-prefixed). The mistake was
// cross-testing against a sibling client instead of the authoritative source.
// We now test against (a) deterministic magic-hash vectors derived from the
// Verus daemon spec and (b) a real verusd-produced signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from 'json-canonicalize';
import { magicHash, signVerusMessage, verifyVerusMessage } from '../src/identity/verus-message.js';
import { generateKeypair } from '../src/index.js';

const NET = 'verustest';

// ─────────────────────────────────────────────────────────────────────────────
// (a) Real verusd-produced vector — captured 2026-05-23 from
// https://api.junction41.io/v1/identity/agentplatform@/keys.
// The `platformSignature` was produced by verusd's signmessage RPC against
// staging signer RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb. If verifyVerusMessage
// stops accepting this vector, the impl has drifted away from verusd — DO NOT
// "fix" the vector; fix the impl.
// ─────────────────────────────────────────────────────────────────────────────
const VERUSD_VECTOR = {
  canon: '{"cachedAt":"2026-05-23T14:28:46.608Z","iaddress":"i7xKUpKQDSriYFfgHYfRpFc2uzRKWLDkjW","minimumSignatures":1,"name":"agentplatform.VRSCTEST@","primaryAddresses":["RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2"]}',
  signature: 'H7AlnCJd0hLr8XD7vPoxYLBSUzseOqBX05GFObfBxbn8UUEsOlay9+dY96qDI3CxmRBrM7jK6wvoM8nkAt4uHxc=',
  signerAddress: 'RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb',
};

test('verusd-produced signature verifies against the SDK impl (real cross-test)', () => {
  assert.equal(
    verifyVerusMessage(VERUSD_VECTOR.canon, VERUSD_VECTOR.signerAddress, VERUSD_VECTOR.signature),
    true,
  );
});

test('verusd vector — JCS-canonical of the data is byte-stable', () => {
  // Round-trip the parsed object through canonicalize and confirm the bytes
  // match — guards against accidental ordering / whitespace drift in JCS impl.
  const parsed = JSON.parse(VERUSD_VECTOR.canon);
  assert.equal(canonicalize(parsed), VERUSD_VECTOR.canon);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Deterministic magic-hash vectors derived from the Verus daemon algorithm:
//     msgHash   = SHA-256( varint(msg.len) || msg )
//     finalHash = SHA-256( varint(19) || "Verus signed data:\n" || msgHash )
// Re-derivable from the Verus daemon source (src/rpc/misc.cpp) or any clean
// reimplementation. Regression-pinning the hash construction.
// ─────────────────────────────────────────────────────────────────────────────
const MAGIC_HASH_VECTORS: Array<[string, string]> = [
  ['',            '95a6ce68c32f4bbd51eb8bee683d55ba3bc0fea58bef9072e5b3cc5230ae7648'],
  ['hello',       '0d371f85526a89f4f00d7b2bb4c157f4f89d00f6956854f588044531d743ddd5'],
  ['Verus rocks', 'c9ab25bedc438c309c39fb6f0fce72feb8c83caa19614155f1440185bb1bc1b8'],
  ['a'.repeat(255), '7cbfafdc68a1574358e0e0e4d3837877ee03fbea54a85ec7ccc25962c1b25c21'],
];

test('magic-hash matches the Verus daemon algorithm for known inputs', () => {
  for (const [input, expected] of MAGIC_HASH_VECTORS) {
    assert.equal(Buffer.from(magicHash(input)).toString('hex'), expected, `mismatch for input ${JSON.stringify(input)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Self-roundtrip and rejection
// ─────────────────────────────────────────────────────────────────────────────
test('sign + verify self-roundtrip works for many random vectors', () => {
  for (let i = 0; i < 50; i++) {
    const kp = generateKeypair(i % 2 ? 'verus' : NET);
    const msg = `roundtrip ${i} ${Math.random()}`;
    const sig = signVerusMessage(kp.wif, msg);
    assert.ok(verifyVerusMessage(msg, kp.address, sig), `roundtrip failed at i=${i}`);
  }
});

test('verify rejects tampered message / wrong address / malformed sig', () => {
  const kp = generateKeypair(NET);
  const other = generateKeypair(NET);
  const sig = signVerusMessage(kp.wif, 'hello');
  assert.ok(verifyVerusMessage('hello', kp.address, sig));
  assert.ok(!verifyVerusMessage('hello!', kp.address, sig));
  assert.ok(!verifyVerusMessage('hello', other.address, sig));
  assert.ok(!verifyVerusMessage('hello', kp.address, ''));
  assert.ok(!verifyVerusMessage('hello', kp.address, 'AAAA'));
  // non-string signature should not throw
  assert.ok(!verifyVerusMessage('hello', kp.address, undefined as unknown as string));
});
