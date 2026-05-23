/**
 * Verus message signing/verification on @noble/curves — matching the
 * Verus daemon's `signmessage`/`verifymessage` exactly.
 *
 * IMPORTANT: this is NOT the Bitcoin magic-hash construction. Verus uses a
 * different algorithm (single SHA-256, message is pre-hashed, prefix is
 * properly varint-length-prefixed). See src/rpc/misc.cpp in VerusCoin:
 *
 *     ss << strMessage;                       // varint(msg.len) || msg
 *     uint256 msgHash = ss.GetHash();          // SHA-256 (single)
 *     ss.Reset();
 *     ss << verusDataSignaturePrefix;          // varint(19) || "Verus signed data:\n"
 *     ss << msgHash;                           // raw 32 bytes
 *     finalHash = ss.GetHash();                // SHA-256 (single)
 *     pubkey.RecoverCompact(finalHash, 65-byte sig)
 *
 * Earlier SDK versions inherited bitcoinjs-message's Bitcoin-style sha256d
 * with the @bitgo/utxo-lib's wrong-length `\x15` prefix byte and were
 * cross-incompatible with verusd. Fixed here; see test/verus-message-compat.test.ts
 * for verusd-spec vectors.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import bs58check from 'bs58check';

// Bytes of the Verus `signmessage` prefix string — 19 chars, varint-length-prefixed
// when serialized into the hash stream.
const VERUS_PREFIX_BYTES = Buffer.from('Verus signed data:\n', 'utf8');

function hash160(buf: Uint8Array): Uint8Array {
  return ripemd160(sha256(buf));
}

/** Bitcoin compact-size (varint) encoder. */
function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  throw new Error('message too long');
}

/**
 * The Verus message magic hash that gets signed/verified — matches the daemon.
 *   msgHash   = SHA-256( varint(msg.len) || msg )
 *   finalHash = SHA-256( varint(19) || "Verus signed data:\n" || msgHash )
 */
export function magicHash(message: string): Uint8Array {
  const msgBuf = Buffer.from(message, 'utf8');
  const msgHash = sha256(Buffer.concat([varint(msgBuf.length), msgBuf]));
  return sha256(Buffer.concat([varint(VERUS_PREFIX_BYTES.length), VERUS_PREFIX_BYTES, msgHash]));
}

/** Decode a WIF into { privateKey, compressed }. */
function decodeWif(wif: string): { privateKey: Uint8Array; compressed: boolean } {
  const decoded: Buffer = bs58check.decode(wif);
  if (decoded.length !== 33 && decoded.length !== 34) {
    throw new Error(`Invalid WIF length: ${decoded.length}`);
  }
  return { privateKey: new Uint8Array(decoded.slice(1, 33)), compressed: decoded.length === 34 };
}

/**
 * Sign a message in the Verus `verifymessage` format. Output is base64 of the
 * 65-byte recoverable signature: [header][r(32)][s(32)] where
 * header = recoveryId + 27 + (compressed ? 4 : 0).
 */
export function signVerusMessage(wif: string, message: string): string {
  const { privateKey, compressed } = decodeWif(wif);
  const privBuf = Buffer.from(privateKey);
  try {
    const h = magicHash(message);
    const sig = secp256k1.sign(h, privateKey, { lowS: true }); // RFC6979 deterministic + low-S
    const header = sig.recovery + 27 + (compressed ? 4 : 0);
    const out = Buffer.concat([Buffer.from([header]), Buffer.from(sig.toCompactRawBytes())]);
    return out.toString('base64');
  } finally {
    privateKey.fill(0);
    privBuf.fill(0);
  }
}

/**
 * Verify a Verus `verifymessage`-format signature against an R-address.
 * Recovers the pubkey from the recoverable signature and compares its
 * hash160 to the address's hash160. Returns false on any malformed input.
 */
export function verifyVerusMessage(message: string, address: string, signatureB64: string): boolean {
  if (!message || !address || typeof signatureB64 !== 'string' || !signatureB64) return false;
  try {
    const sigBuf = Buffer.from(signatureB64, 'base64');
    if (sigBuf.length !== 65) return false;
    const header = sigBuf[0];
    if (header < 27 || header > 34) return false;
    const recovery = (header - 27) & 3;
    const compressed = ((header - 27) & 4) !== 0;

    const h = magicHash(message);
    const sig = secp256k1.Signature.fromCompact(sigBuf.subarray(1, 65)).addRecoveryBit(recovery);
    const point = sig.recoverPublicKey(h);
    const pubkey = point.toRawBytes(compressed);
    const recoveredHash = hash160(pubkey);

    // Compare hash160 with the address payload (strip version byte + checksum).
    const addrPayload = bs58check.decode(address); // [version][hash160(20)]
    const addrHash = addrPayload.subarray(addrPayload.length - 20);
    if (recoveredHash.length !== addrHash.length) return false;
    let diff = 0;
    for (let i = 0; i < 20; i++) diff |= recoveredHash[i] ^ addrHash[i];
    return diff === 0;
  } catch {
    return false;
  }
}
