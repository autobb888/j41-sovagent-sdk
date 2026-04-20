/**
 * ECDH Key Envelope — encrypted API key exchange.
 *
 * Crypto chain:
 *   secp256k1 ECDH → x-coordinate → HKDF(sha256, x, nonce, "j41-key-envelope-v1", 32) → AES-256-GCM
 *
 * All crypto uses @noble/secp256k1 + @noble/hashes (already in dependency tree
 * via @bitgo/utxo-lib) and Node.js built-in crypto for AES-GCM.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import * as secp from '@noble/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { signMessage } from '../identity/signer.js';
import { wifToAddress } from '../tx/payment.js';
import type { AccessRequest, AccessEnvelope, AccessPayload } from './types.js';

// Re-export types
export type { AccessRequest, AccessEnvelope, AccessPayload } from './types.js';

const HKDF_INFO = 'j41-key-envelope-v1';

// --- Helpers ---

/** Decode a WIF private key to raw 32-byte Uint8Array */
function wifToPrivateKey(wif: string): Uint8Array {
  // WIF format: version(1) + privkey(32) + [compressed flag(1)] + checksum(4)
  // bs58check.decode strips the checksum, leaving version + privkey + optional flag
  const bs58check = require('bs58check');
  const decoded: Buffer = bs58check.decode(wif);
  // Slice out the 32-byte private key (skip version byte at index 0)
  return new Uint8Array(decoded.slice(1, 33));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function secureZero(buf: Uint8Array): void {
  buf.fill(0);
}

// --- Public API ---

/**
 * Generate an ephemeral secp256k1 keypair for ECDH key exchange.
 * The private key should be used ONCE and then discarded.
 */
export function generateEphemeralKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = new Uint8Array(randomBytes(32));
  const publicKey = secp.getPublicKey(privateKey, true); // compressed (33 bytes)
  return { privateKey, publicKey };
}

/**
 * Build a signed access request (buyer side).
 *
 * @param buyerWif - Buyer's WIF private key (for signing)
 * @param sellerVerusId - Seller's VerusID (e.g. "iSeller..." or "seller.agentplatform@")
 * @param ephPub - Ephemeral public key from generateEphemeralKeypair()
 * @param network - 'verus' or 'verustest' (default: 'verustest')
 */
export function buildAccessRequest(
  buyerWif: string,
  sellerVerusId: string,
  ephPub: Uint8Array,
  network: 'verus' | 'verustest' = 'verustest',
): AccessRequest {
  const buyerVerusId = wifToAddress(buyerWif, network);
  const ephPubHex = bytesToHex(ephPub);
  const nonce = bytesToHex(new Uint8Array(randomBytes(16)));
  const timestamp = Math.floor(Date.now() / 1000);

  const canonical = `J41-ACCESS-REQUEST|Buyer:${buyerVerusId}|Seller:${sellerVerusId}|EphPub:${ephPubHex}|Nonce:${nonce}|Ts:${timestamp}`;
  const buyerSignature = signMessage(buyerWif, canonical, network);

  return {
    buyerVerusId,
    sellerVerusId,
    ephemeralPubKey: ephPubHex,
    nonce,
    timestamp,
    buyerSignature,
  };
}

/**
 * Mint an encrypted access envelope (dispatcher/seller side).
 *
 * Performs ECDH with the buyer's ephemeral public key, derives an AES key
 * via HKDF, encrypts the payload, and signs the envelope.
 *
 * @param request - The buyer's AccessRequest
 * @param dispatcherWif - Dispatcher's WIF private key (for ECDH + signing)
 * @param payload - The AccessPayload to encrypt (contains the API key)
 * @param network - 'verus' or 'verustest'
 */
export function mintAccessEnvelope(
  request: AccessRequest,
  dispatcherWif: string,
  payload: AccessPayload,
  network: 'verus' | 'verustest' = 'verustest',
): AccessEnvelope {
  // Get dispatcher's raw private key for ECDH
  const dispPrivKey = wifToPrivateKey(dispatcherWif);
  const dispPubKey = secp.getPublicKey(dispPrivKey, true);

  // ECDH: compute shared secret with buyer's ephemeral public key
  const buyerEphPub = hexToBytes(request.ephemeralPubKey);
  const sharedPoint = secp.getSharedSecret(dispPrivKey, buyerEphPub, false); // uncompressed (65 bytes)
  const sharedX = sharedPoint.slice(1, 33); // x-coordinate only (32 bytes)

  // HKDF: derive AES-256 key
  const nonce = hexToBytes(request.nonce);
  const aesKey = hkdf(sha256, sharedX, nonce, HKDF_INFO, 32);

  // AES-256-GCM encrypt
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(aesKey), Buffer.from(iv));
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Sign the envelope
  const timestamp = Math.floor(Date.now() / 1000);
  const ciphertextB64 = encrypted.toString('base64');
  const canonical = `J41-ACCESS-ENVELOPE|Cipher:${ciphertextB64.slice(0, 32)}|DispPub:${bytesToHex(dispPubKey)}|Ts:${timestamp}|Expires:${payload.expiresAt}`;
  const dispatcherSignature = signMessage(dispatcherWif, canonical, network);

  // Zero sensitive material
  secureZero(dispPrivKey);
  secureZero(sharedX);
  if (aesKey instanceof Uint8Array) secureZero(aesKey);

  return {
    ciphertext: ciphertextB64,
    iv: bytesToHex(iv),
    authTag: bytesToHex(authTag),
    dispatcherEphPub: bytesToHex(dispPubKey),
    dispatcherSignature,
    expiresAt: payload.expiresAt,
    timestamp,
  };
}

/**
 * Open an encrypted access envelope (buyer side).
 *
 * Uses the buyer's ephemeral private key to derive the same ECDH shared
 * secret, then decrypts the AES-256-GCM payload.
 *
 * @param envelope - The AccessEnvelope from the dispatcher
 * @param ephPrivKey - Buyer's ephemeral private key (from generateEphemeralKeypair)
 * @param nonce - The nonce used in the original AccessRequest (hex string)
 */
export function openAccessEnvelope(
  envelope: AccessEnvelope,
  ephPrivKey: Uint8Array,
  nonce: string,
): AccessPayload {
  // ECDH: compute shared secret with dispatcher's public key
  const dispPub = hexToBytes(envelope.dispatcherEphPub);
  const sharedPoint = secp.getSharedSecret(ephPrivKey, dispPub, false);
  const sharedX = sharedPoint.slice(1, 33);

  // HKDF: derive AES-256 key (same params as mint side)
  const nonceBytes = hexToBytes(nonce);
  const aesKey = hkdf(sha256, sharedX, nonceBytes, HKDF_INFO, 32);

  // AES-256-GCM decrypt
  const iv = Buffer.from(hexToBytes(envelope.iv));
  const authTag = Buffer.from(hexToBytes(envelope.authTag));
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Zero sensitive material
  secureZero(sharedX);
  if (aesKey instanceof Uint8Array) secureZero(aesKey);

  return JSON.parse(decrypted.toString('utf8')) as AccessPayload;
}
