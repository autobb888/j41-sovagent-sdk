/**
 * Offline proof of the crypto half — no wallet, no daemon, no network.
 * If this fails, do not bother scanning a QR.
 *
 * Run: npx tsx spike/encrypted-delivery/roundtrip.test.mjs
 */
import { strict as assert } from 'node:assert';
import { keygen, encryptToAddress, decryptWithIvk } from './sapling.mjs';

const ok = (m) => console.log(`  ✓ ${m}`);

const buyer = await keygen();
assert.equal(Buffer.from(buyer.addressHex, 'hex').length, 43, 'address is 43 raw bytes');
assert.equal(Buffer.from(buyer.ivkHex, 'hex').length, 32, 'ivk is 32 raw bytes');
ok('keygen produces a 43-byte address and a 32-byte ivk');

const deliverable = Buffer.from('the deliverable nobody else may read', 'utf8');
const ct = await encryptToAddress(buyer.addressHex, deliverable);
assert.notEqual(ct.objectdataHex, deliverable.toString('hex'), 'ciphertext must not be the plaintext');
ok('agent encrypts to the buyer address without a daemon');

const pt = await decryptWithIvk({ ...ct, ivkHex: buyer.ivkHex });
assert.equal(pt.toString('utf8'), deliverable.toString('utf8'));
ok('buyer decrypts with the correct ivk');

const stranger = await keygen();
let refused = false;
try {
  const wrong = await decryptWithIvk({ ...ct, ivkHex: stranger.ivkHex });
  if (wrong.toString('utf8') !== deliverable.toString('utf8')) refused = true;
} catch { refused = true; }
assert.equal(refused, true, 'a wrong ivk MUST NOT yield the plaintext');
ok('a stranger ivk fails closed');

console.log('\nOFFLINE CRYPTO ROUND-TRIP PASSES');
