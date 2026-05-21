/**
 * Verus message signing/verification on @noble/curves — replacing the
 * unmaintained bitcoinjs-message → secp256k1@3 → elliptic chain on the
 * signature hot path.
 *
 * Produces and accepts the SAME bytes as the legacy `verifymessage` format
 * (magic-hash + recoverable ECDSA, base64 `[header][r][s]`), so on-chain and
 * cross-component verification is unaffected. Cross-checked byte-for-byte and
 * by mutual verification against bitcoinjs-message in the test suite before
 * this became the production path.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import bs58check from 'bs58check';

// Network-independent Verus message prefix (identical on verus/verustest).
const MESSAGE_PREFIX = '\x15Verus signed data:\n';

function sha256d(buf: Uint8Array): Uint8Array {
  return sha256(sha256(buf));
}

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

/** The magic hash that gets signed: sha256d(prefix || varint(len) || message). */
export function magicHash(message: string): Uint8Array {
  const prefixBuf = Buffer.from(MESSAGE_PREFIX, 'binary');
  const msgBuf = Buffer.from(message, 'utf8');
  const lenBuf = varint(msgBuf.length);
  return sha256d(Buffer.concat([prefixBuf, lenBuf, msgBuf]));
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
