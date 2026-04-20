/**
 * Types for the ECDH key envelope protocol.
 *
 * Flow: buyer generates ephemeral keypair → builds AccessRequest →
 * J41 forwards to seller's dispatcher → dispatcher mints key,
 * encrypts with ECDH+AES-256-GCM → returns AccessEnvelope →
 * buyer decrypts with ephemeral private key → gets AccessPayload.
 *
 * J41 never sees the API key — only ciphertext.
 */

/** Buyer → J41 → Dispatcher: request API access */
export interface AccessRequest {
  buyerVerusId: string;
  sellerVerusId: string;
  /** Compressed secp256k1 public key (hex, 33 bytes / 66 chars) */
  ephemeralPubKey: string;
  /** Random 16 bytes (hex, 32 chars) — used as HKDF salt */
  nonce: string;
  /** Unix seconds */
  timestamp: number;
  /** Verus message signature of the canonical request string (base64) */
  buyerSignature: string;
}

/** Dispatcher → J41 → Buyer: encrypted API key envelope */
export interface AccessEnvelope {
  /** AES-256-GCM ciphertext containing AccessPayload JSON (base64) */
  ciphertext: string;
  /** AES-GCM IV (hex, 12 bytes / 24 chars) */
  iv: string;
  /** AES-GCM auth tag (hex, 16 bytes / 32 chars) */
  authTag: string;
  /** Dispatcher's ephemeral public key for ECDH (hex, 33 bytes compressed) */
  dispatcherEphPub: string;
  /** Verus message signature of the envelope (base64) */
  dispatcherSignature: string;
  /** ISO 8601 expiry for the API key */
  expiresAt: string;
  /** Unix seconds — when the envelope was created */
  timestamp: number;
}

/** Decrypted payload inside the envelope */
export interface AccessPayload {
  /** The minted API key (sk-<shortId>-<hex>) */
  apiKey: string;
  /** Seller's backend URL (e.g. https://my-gpu.com/v1) */
  endpointUrl: string;
  /** ISO 8601 expiry */
  expiresAt: string;
  /** Available models */
  models: string[];
  /** Per-model token pricing */
  modelPricing?: Array<{
    model: string;
    inputTokenRate: number;
    outputTokenRate: number;
  }>;
  /** Per-buyer rate limits */
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
}
