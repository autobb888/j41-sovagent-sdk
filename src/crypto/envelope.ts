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
import { secp256k1 as secp } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import bs58check from 'bs58check';
import { signMessage } from '../identity/signer.js';
import { verifyVerusMessage } from '../identity/verus-message.js';
import { wifToAddress } from '../tx/payment.js';
import type { AccessRequest, AccessEnvelope, AccessPayload } from './types.js';

// Re-export types
export type { AccessRequest, AccessEnvelope, AccessPayload } from './types.js';

const HKDF_INFO = 'j41-key-envelope-v1';

/** Default freshness window for access requests/envelopes (seconds). */
const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Options for access-request/envelope verification.
 *
 * The SDK is stateless, so durable replay protection (a seen-nonce store) must
 * be supplied by the caller via `isReplay` — e.g. the dispatcher's nonce-cache.
 */
export interface AccessVerifyOptions {
  /** Max age (seconds) for the signed timestamp. Default 300. */
  maxAgeSeconds?: number;
  /** Current time as unix seconds (override for testing). */
  now?: number;
  /**
   * Replay guard. Called with the request nonce AFTER the signature checks out;
   * return true if the nonce has been seen before (verification then fails).
   * Implementations typically check-and-record in one call.
   */
  isReplay?: (nonce: string) => boolean | Promise<boolean>;
}

// --- Helpers ---

/** Decode a WIF private key to raw 32-byte Uint8Array. Validates length. */
function wifToPrivateKey(wif: string): Uint8Array {
  const decoded: Buffer = bs58check.decode(wif);
  // WIF: version(1) + privkey(32) + optional compressed flag(1)
  if (decoded.length !== 33 && decoded.length !== 34) {
    throw new Error(`Invalid WIF length: ${decoded.length} (expected 33 or 34)`);
  }
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
 * The returned `nonce` MUST be retained by the caller — it is needed to
 * decrypt the response envelope via `openAccessEnvelope(envelope, ephPriv, request.nonce)`.
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
 * via HKDF, encrypts the payload, and signs the FULL envelope (ciphertext + iv + authTag).
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
  const sharedX = sharedPoint.slice(1, 33); // x-coordinate only (32 bytes) — this is a COPY

  // HKDF: derive AES-256 key
  const nonce = hexToBytes(request.nonce);
  const aesKey = hkdf(sha256, sharedX, nonce, HKDF_INFO, 32);

  // AES-256-GCM encrypt
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(aesKey), Buffer.from(iv));
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Sign the FULL envelope — ciphertext + iv + authTag all committed
  const timestamp = Math.floor(Date.now() / 1000);
  const ciphertextB64 = encrypted.toString('base64');
  const ivHex = bytesToHex(iv);
  const authTagHex = bytesToHex(authTag);
  const canonical = `J41-ACCESS-ENVELOPE|Cipher:${ciphertextB64}|IV:${ivHex}|Tag:${authTagHex}|DispPub:${bytesToHex(dispPubKey)}|Ts:${timestamp}|Expires:${payload.expiresAt}`;
  const dispatcherSignature = signMessage(dispatcherWif, canonical, network);

  // Zero ALL sensitive material
  secureZero(dispPrivKey);
  secureZero(sharedPoint); // full 65-byte ECDH output
  secureZero(sharedX);     // the x-coord copy
  secureZero(aesKey);

  return {
    ciphertext: ciphertextB64,
    iv: ivHex,
    authTag: authTagHex,
    dispatcherEphPub: bytesToHex(dispPubKey),
    dispatcherSignature,
    expiresAt: payload.expiresAt,
    timestamp,
  };
}

/**
 * Verification context required to open an access envelope.
 *
 * Opening ALWAYS authenticates the envelope against the *expected* seller before
 * it will decrypt. J41 is only a semi-trusted relay: it sees the buyer's
 * plaintext `ephemeralPubKey` in the AccessRequest, so it can compute the very
 * same ECDH key and mint its OWN envelope (its pubkey in `dispatcherEphPub`, its
 * signature) whose ciphertext decrypts perfectly. Confidentiality alone does not
 * bind the payload (`apiKey` + `endpointUrl`) to the seller the buyer chose — the
 * dispatcher signature over the seller's on-chain R-address is the only thing that
 * does. So the open path checks it first and fails closed.
 */
export interface OpenVerifyContext {
  /**
   * Authenticated J41 client (or any resolver exposing `getIdentityKeys`/`getAgent`).
   * Used to resolve the seller's on-chain primary R-addresses to verify against.
   */
  client: {
    getAgent(verusId: string): Promise<any>;
    getIdentityKeys?(idOrName: string): Promise<{ primaryAddresses?: string[]; minimumSignatures?: number }>;
  };
  /**
   * The seller VerusID the buyer requested access from. The envelope MUST carry a
   * signature that verifies against this identity's on-chain R-addresses.
   */
  sellerVerusId: string;
  /** 'verus' or 'verustest' (default 'verustest'). */
  network?: 'verus' | 'verustest';
  /** Freshness/expiry/replay options forwarded to `verifyAccessEnvelope`. */
  verifyOpts?: AccessVerifyOptions;
}

/**
 * Open an encrypted access envelope (buyer side) — AUTHENTICATE, then decrypt.
 *
 * Verifies the dispatcher/seller signature against the expected seller's on-chain
 * R-addresses BEFORE decrypting, and throws (fail-closed) if it does not match, so
 * a forged envelope minted by a MITM relay is rejected instead of yielding an
 * attacker-controlled `apiKey`/`endpointUrl`. Only after authenticity is
 * established does it run the ECDH + AES-256-GCM decrypt.
 *
 * There is NO silent unverified fallback: a caller that omits the verification
 * context throws. Anyone who genuinely wants a decoupled two-step can call
 * {@link verifyAccessEnvelope} explicitly — but the open path always enforces it.
 *
 * @param envelope - The AccessEnvelope from the dispatcher (via J41 relay)
 * @param ephPrivKey - Buyer's ephemeral private key (from generateEphemeralKeypair)
 * @param nonce - The nonce from the original AccessRequest (hex, 32 chars / 16 bytes).
 *               MUST be the same nonce returned by buildAccessRequest().
 * @param verify - Verification context: the client + the seller VerusID the buyer
 *               requested access from. Mandatory — the envelope is authenticated
 *               against this seller before any plaintext is returned.
 */
export async function openAccessEnvelope(
  envelope: AccessEnvelope,
  ephPrivKey: Uint8Array,
  nonce: string,
  verify: OpenVerifyContext,
): Promise<AccessPayload> {
  // Fail closed if no verification context is supplied. Earlier SDK versions
  // exposed a 3-arg synchronous form that decrypted WITHOUT authenticating the
  // seller — that path is removed because a semi-trusted relay can forge an
  // envelope that still decrypts. There is deliberately no insecure fallback.
  if (!verify || typeof verify !== 'object' || !verify.client || !verify.sellerVerusId) {
    throw new Error(
      'openAccessEnvelope requires a verification context { client, sellerVerusId }: ' +
      'the envelope MUST be authenticated against the expected seller before it is ' +
      'decrypted. Pass the authenticated J41Client and the seller VerusID you ' +
      'requested access from.',
    );
  }

  // Authenticity FIRST — refuse to decrypt anything the expected seller did not
  // sign. verifyAccessEnvelope also enforces expiry + clock-skew on the signed
  // fields, and resolves the seller's R-addresses via the platform-signer-pinned
  // getIdentityKeys path when available.
  const authentic = await verifyAccessEnvelope(
    envelope,
    verify.client,
    verify.sellerVerusId,
    verify.network ?? 'verustest',
    verify.verifyOpts,
  );
  if (!authentic) {
    throw new Error(
      `Access envelope failed signature verification against the expected seller ` +
      `(${verify.sellerVerusId}) — refusing to decrypt. A relay may have forged this ` +
      `envelope (MITM); the decrypted apiKey/endpointUrl cannot be trusted.`,
    );
  }

  return decryptEnvelope(envelope, ephPrivKey, nonce);
}

/**
 * Explicit, self-documenting alias for {@link openAccessEnvelope} — the
 * verify-then-decrypt open path. Same behaviour; exported so integrators can make
 * the security intent obvious at the call site.
 */
export const openVerifiedAccessEnvelope = openAccessEnvelope;

/**
 * Raw ECDH + AES-256-GCM decrypt of an envelope — NO authenticity check.
 *
 * INTERNAL ONLY, intentionally NOT exported: every caller must go through
 * {@link openAccessEnvelope}, which authenticates the seller signature first
 * (fail-closed) so a forged relay envelope cannot be silently decrypted. Keeping
 * this un-exported is what removes the footgun.
 */
function decryptEnvelope(
  envelope: AccessEnvelope,
  ephPrivKey: Uint8Array,
  nonce: string,
): AccessPayload {
  // Validate nonce format
  if (!nonce || nonce.length !== 32 || !/^[0-9a-f]+$/i.test(nonce)) {
    throw new Error('Invalid nonce: must be 32 hex characters (16 bytes). Use the nonce from buildAccessRequest().');
  }

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

  // Zero ALL sensitive material
  secureZero(sharedPoint);
  secureZero(sharedX);
  secureZero(aesKey);

  return JSON.parse(decrypted.toString('utf8')) as AccessPayload;
}

/**
 * Verify an access envelope's dispatcher signature.
 * Resolves the seller's R-address via J41 platform API, then verifies
 * the signature using bitcoinjs-message.
 *
 * @param envelope - The AccessEnvelope to verify
 * @param client - An authenticated J41Client (or any object with getAgent method)
 * @param sellerVerusId - The seller's VerusID to verify against
 * @param network - 'verus' or 'verustest'
 * @returns true if signature is valid, false otherwise
 */
export async function verifyAccessEnvelope(
  envelope: AccessEnvelope,
  client: {
    getAgent(verusId: string): Promise<any>;
    getIdentityKeys?(idOrName: string): Promise<{ primaryAddresses?: string[]; minimumSignatures?: number }>;
  },
  sellerVerusId: string,
  network: 'verus' | 'verustest' = 'verustest',
  opts: AccessVerifyOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  // Expiry — NEVER accept an envelope whose API key has already expired. The
  // expiresAt is part of the signed canonical string, but a valid signature
  // alone does not imply the key is still usable.
  const expiresMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= now * 1000) return false;

  // Clock-skew guard — reject envelopes timestamped implausibly in the future.
  if (!Number.isFinite(envelope.timestamp) || envelope.timestamp - now > maxAge) return false;

  // Audit 2026-06-02 H3: resolve seller's R-addresses via getIdentityKeys
  // (which honors J41_PLATFORM_SIGNER pinning per H9) instead of getAgent
  // (untrusted). Fall back to getAgent only if the client doesn't expose
  // getIdentityKeys (older SDK shim or test stub) — but warn loudly.
  let primaryAddresses: string[] = [];
  if (typeof client.getIdentityKeys === 'function') {
    try {
      const keys = await client.getIdentityKeys(sellerVerusId);
      primaryAddresses = Array.isArray(keys.primaryAddresses) ? keys.primaryAddresses : [];
    } catch {
      primaryAddresses = [];
    }
  } else {
    console.error(
      '[verifyAccessEnvelope] WARN: client lacks getIdentityKeys; falling back to ' +
      'getAgent which has no platform-signature pin. Upgrade the SDK client to gain ' +
      'J41_PLATFORM_SIGNER protection.',
    );
    const agent = await client.getAgent(sellerVerusId);
    const rAddr = agent.primaryAddresses?.[0] || agent.primaryaddresses?.[0] || agent.address;
    if (rAddr) primaryAddresses = [rAddr];
  }
  if (primaryAddresses.length === 0) throw new Error('Could not resolve seller primary R-addresses');

  // Reconstruct the canonical string that was signed
  const canonical = `J41-ACCESS-ENVELOPE|Cipher:${envelope.ciphertext}|IV:${envelope.iv}|Tag:${envelope.authTag}|DispPub:${envelope.dispatcherEphPub}|Ts:${envelope.timestamp}|Expires:${envelope.expiresAt}`;

  // Accept if signature verifies against ANY of the primary R-addresses
  // (multi-sig identities can have multiple).
  for (const rAddress of primaryAddresses) {
    if (verifyVerusMessage(canonical, rAddress, envelope.dispatcherSignature)) return true;
  }
  return false;
}

/**
 * Verify an access request's buyer signature.
 * Resolves the buyer's R-address via J41 platform API, then verifies
 * the signature using bitcoinjs-message.
 *
 * Used by the dispatcher to verify the buyer is who they claim to be
 * before minting an API key.
 *
 * @param request - The AccessRequest to verify
 * @param client - An authenticated J41Client (or any object with getAgent method)
 * @param network - 'verus' or 'verustest'
 * @returns true if signature is valid, false otherwise
 */
export async function verifyAccessRequest(
  request: AccessRequest,
  client: {
    getAgent(verusId: string): Promise<any>;
    getIdentityKeys?(idOrName: string): Promise<{ primaryAddresses?: string[]; minimumSignatures?: number }>;
  },
  network: 'verus' | 'verustest' = 'verustest',
  opts: AccessVerifyOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  // Freshness — reject stale or future-dated requests before any network I/O.
  if (!Number.isFinite(request.timestamp) || Math.abs(now - request.timestamp) > maxAge) {
    return false;
  }

  // Audit 2026-06-02 H3: same fix as verifyAccessEnvelope — resolve via
  // getIdentityKeys (with J41_PLATFORM_SIGNER pin) when the buyer ID is an
  // i-address; only fall back to getAgent when getIdentityKeys is unavailable.
  let candidateAddresses: string[] = [];
  if (request.buyerVerusId.startsWith('i') && request.buyerVerusId.length > 30) {
    if (typeof client.getIdentityKeys === 'function') {
      try {
        const keys = await client.getIdentityKeys(request.buyerVerusId);
        candidateAddresses = Array.isArray(keys.primaryAddresses) ? keys.primaryAddresses : [];
      } catch {
        candidateAddresses = [];
      }
    } else {
      console.error(
        '[verifyAccessRequest] WARN: client lacks getIdentityKeys; falling back to ' +
        'getAgent which has no platform-signature pin.',
      );
      try {
        const agent = await client.getAgent(request.buyerVerusId);
        const rAddr = agent.primaryAddresses?.[0] || agent.primaryaddresses?.[0] || agent.address;
        if (rAddr) candidateAddresses = [rAddr];
      } catch {
        candidateAddresses = [];
      }
    }
    if (candidateAddresses.length === 0) candidateAddresses = [request.buyerVerusId];
  } else {
    candidateAddresses = [request.buyerVerusId];
  }

  const canonical = `J41-ACCESS-REQUEST|Buyer:${request.buyerVerusId}|Seller:${request.sellerVerusId}|EphPub:${request.ephemeralPubKey}|Nonce:${request.nonce}|Ts:${request.timestamp}`;

  let verified = false;
  for (const rAddress of candidateAddresses) {
    if (verifyVerusMessage(canonical, rAddress, request.buyerSignature)) {
      verified = true;
      break;
    }
  }
  if (!verified) return false;

  // Replay — consult the caller's seen-nonce store only for validly-signed
  // requests (so attackers can't burn nonces with junk).
  if (opts.isReplay && (await opts.isReplay(request.nonce))) return false;

  return true;
}
