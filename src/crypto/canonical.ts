/**
 * Canonical-v1 signing envelope — implements the buyer→platform signed envelope
 * per docs/spec/api-session-signing-v2.md (rev 2.1, autobb888/junction41@d696135).
 *
 * Companion to the existing v1 pipe-delimited signMessage() path in identity/signer.ts.
 * This module handles the v2 canonical JSON envelope with RFC 8785 JCS canonicalization.
 *
 * Wire format on the request body:
 *   { envelope: <object>, signatures: [base64, ...] }
 *
 * The 14-step verifier flow lives in verifyCanonical() below and must produce byte-identical
 * results to the backend's src/auth/envelope-v2.ts. Golden-vector tests enforce that.
 */
import { canonicalize } from 'json-canonicalize';
import { signMessage } from '../identity/signer.js';

// ── Constants (match backend) ──

export const CANONICAL_MAX_BYTES = 8192;
export const CLOCK_SKEW_MS = 300_000;

export const SUPPORTED_VERSIONS = [1] as const;
export const SUPPORTED_SUITES = ['verus-signmessage-v1'] as const;

export const ACTIONS = ['request-access', 'review-api-session', 'review-submit', 'budget-request'] as const;
export type Action = typeof ACTIONS[number];

/** Per-action maximum (expiresAt - issuedAt), in milliseconds. Matches backend verifier table. */
export const ACTION_MAX_WINDOW_MS: Record<Action, number> = {
  'request-access': 5 * 60 * 1000,          // 5 minutes
  'review-api-session': 7 * 24 * 60 * 60 * 1000, // 7 days
  'review-submit': 7 * 24 * 60 * 60 * 1000,     // 7 days
  'budget-request': 60 * 60 * 1000,         // 1 hour
};

/** RFC 3339 format: YYYY-MM-DDTHH:mm:ss.sssZ — millisecond precision, Z suffix, no offset. */
const RFC3339_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 34-char i-address starting with 'i'. */
const IADDRESS_RE = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;

/** 32-char lowercase hex nonce. */
const NONCE_RE = /^[0-9a-f]{32}$/;

// ── Types ──

export interface EnvelopeV1 {
  version: 1;
  cryptoSuite: 'verus-signmessage-v1';
  action: Action;
  buyer: { iaddress: string; name?: string };
  seller: { iaddress: string; name?: string };
  payload: Record<string, unknown>;
  contentHash?: { alg: 'sha256'; digest: string };
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedEnvelopeV1 {
  envelope: EnvelopeV1;
  signatures: string[];
}

export type CanonicalErrorCode =
  | 'INVALID_BODY'
  | 'CANONICAL_TOO_LARGE'
  | 'UNEXPECTED_FIELD'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_SUITE'
  | 'UNKNOWN_ACTION'
  | 'EXPIRES_BEFORE_ISSUED'
  | 'EXPIRES_TOO_FAR'
  | 'EXPIRED'
  | 'ISSUED_IN_FUTURE'
  | 'NAME_IADDRESS_MISMATCH'
  | 'CONTENT_HASH_MISMATCH'
  | 'NONCE_REPLAY'
  | 'RPC_UNAVAILABLE'
  | 'INVALID_SIGNATURE';

export class CanonicalError extends Error {
  readonly code: CanonicalErrorCode;
  constructor(code: CanonicalErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CanonicalError';
  }
}

// Top-level keys permitted in the envelope (spec §Field rules). Strict enforcement.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'version', 'cryptoSuite', 'action', 'buyer', 'seller', 'payload',
  'contentHash', 'nonce', 'issuedAt', 'expiresAt',
]);

const REQUIRED_TOP_LEVEL_KEYS = [
  'version', 'cryptoSuite', 'action', 'buyer', 'seller', 'payload',
  'nonce', 'issuedAt', 'expiresAt',
];

const ALLOWED_BUYER_SELLER_KEYS = new Set(['iaddress', 'name']);
const ALLOWED_CONTENT_HASH_KEYS = new Set(['alg', 'digest']);

// ── Canonicalization ──

/**
 * Canonicalize an envelope to RFC 8785 (JCS) bytes.
 * Used for both signing (producer) and verifying (consumer). Both sides MUST agree
 * byte-for-byte; the backend's golden vector in docs/spec/api-session-signing-v2.md
 * is the reference.
 *
 * Throws CANONICAL_TOO_LARGE if output exceeds CANONICAL_MAX_BYTES.
 */
export function canonicalBytes(envelope: EnvelopeV1): Buffer {
  const s = canonicalize(envelope);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length > CANONICAL_MAX_BYTES) {
    throw new CanonicalError('CANONICAL_TOO_LARGE', `Canonical bytes exceed ${CANONICAL_MAX_BYTES} (got ${buf.length})`);
  }
  return buf;
}

// ── Structural validation (runs before signature verification) ──

/**
 * Validate envelope shape and window rules. Throws CanonicalError on any violation.
 * Mirrors steps 3–10 of the backend verifier flow.
 *
 * @param now - override for "now" in ms; defaults to Date.now(). Lets tests inject deterministic time.
 */
export function validateEnvelope(envelope: EnvelopeV1, now: number = Date.now()): void {
  if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new CanonicalError('INVALID_BODY', 'envelope must be an object');
  }

  // Strict top-level keys — UNEXPECTED_FIELD before any other field-level check.
  for (const k of Object.keys(envelope)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(k)) {
      throw new CanonicalError('UNEXPECTED_FIELD', `envelope has unknown top-level key "${k}"`);
    }
  }
  for (const k of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(k in envelope)) {
      throw new CanonicalError('INVALID_BODY', `envelope missing required key "${k}"`);
    }
  }

  // Version (step 5) — UNSUPPORTED_VERSION is 426 on backend but thrown as a code here;
  // caller maps to HTTP if applicable.
  if (!SUPPORTED_VERSIONS.includes(envelope.version as 1)) {
    throw new CanonicalError('UNSUPPORTED_VERSION', `unsupported version ${envelope.version}`);
  }

  // Suite (step 6)
  if (!SUPPORTED_SUITES.includes(envelope.cryptoSuite as 'verus-signmessage-v1')) {
    throw new CanonicalError('UNSUPPORTED_SUITE', `unsupported cryptoSuite "${envelope.cryptoSuite}"`);
  }

  // Action (step 7)
  if (!ACTIONS.includes(envelope.action as Action)) {
    throw new CanonicalError('UNKNOWN_ACTION', `unknown action "${envelope.action}"`);
  }

  // buyer / seller shape
  validatePartyObject(envelope.buyer, 'buyer');
  validatePartyObject(envelope.seller, 'seller');

  // payload must be an object (may be empty)
  if (envelope.payload == null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new CanonicalError('INVALID_BODY', 'payload must be an object');
  }

  // contentHash shape (optional)
  if ('contentHash' in envelope && envelope.contentHash !== undefined) {
    validateContentHash(envelope.contentHash);
  }

  // nonce
  if (typeof envelope.nonce !== 'string' || !NONCE_RE.test(envelope.nonce)) {
    throw new CanonicalError('INVALID_BODY', 'nonce must be 32 hex characters (16 bytes)');
  }

  // issuedAt / expiresAt
  if (typeof envelope.issuedAt !== 'string' || !RFC3339_MS_RE.test(envelope.issuedAt)) {
    throw new CanonicalError('INVALID_BODY', 'issuedAt must be RFC 3339 with millisecond precision and Z suffix');
  }
  if (typeof envelope.expiresAt !== 'string' || !RFC3339_MS_RE.test(envelope.expiresAt)) {
    throw new CanonicalError('INVALID_BODY', 'expiresAt must be RFC 3339 with millisecond precision and Z suffix');
  }

  const issuedAtMs = Date.parse(envelope.issuedAt);
  const expiresAtMs = Date.parse(envelope.expiresAt);

  // Window rules (step 8) — order matches backend: EXPIRES_BEFORE_ISSUED before EXPIRES_TOO_FAR before EXPIRED/ISSUED_IN_FUTURE.
  if (expiresAtMs <= issuedAtMs) {
    throw new CanonicalError('EXPIRES_BEFORE_ISSUED', 'expiresAt must be strictly greater than issuedAt');
  }

  const actionMax = ACTION_MAX_WINDOW_MS[envelope.action as Action];
  if (expiresAtMs - issuedAtMs > actionMax) {
    throw new CanonicalError('EXPIRES_TOO_FAR', `expiresAt - issuedAt exceeds per-action max (${actionMax}ms)`);
  }

  if (now > expiresAtMs + CLOCK_SKEW_MS) {
    throw new CanonicalError('EXPIRED', 'envelope has expired');
  }
  if (issuedAtMs > now + CLOCK_SKEW_MS) {
    throw new CanonicalError('ISSUED_IN_FUTURE', 'issuedAt is more than 300s in the future');
  }
}

function validatePartyObject(party: unknown, label: 'buyer' | 'seller'): void {
  if (party == null || typeof party !== 'object' || Array.isArray(party)) {
    throw new CanonicalError('INVALID_BODY', `${label} must be an object`);
  }
  for (const k of Object.keys(party as object)) {
    if (!ALLOWED_BUYER_SELLER_KEYS.has(k)) {
      throw new CanonicalError('UNEXPECTED_FIELD', `${label} has unknown key "${k}"`);
    }
  }
  const p = party as { iaddress?: unknown; name?: unknown };
  if (typeof p.iaddress !== 'string' || !IADDRESS_RE.test(p.iaddress)) {
    throw new CanonicalError('INVALID_BODY', `${label}.iaddress must be a 34-char i-address`);
  }
  if ('name' in p && p.name !== undefined && typeof p.name !== 'string') {
    throw new CanonicalError('INVALID_BODY', `${label}.name must be a string if present`);
  }
}

function validateContentHash(ch: unknown): void {
  if (ch == null || typeof ch !== 'object' || Array.isArray(ch)) {
    throw new CanonicalError('INVALID_BODY', 'contentHash must be an object');
  }
  for (const k of Object.keys(ch as object)) {
    if (!ALLOWED_CONTENT_HASH_KEYS.has(k)) {
      throw new CanonicalError('UNEXPECTED_FIELD', `contentHash has unknown key "${k}"`);
    }
  }
  const c = ch as { alg?: unknown; digest?: unknown };
  if (c.alg !== 'sha256') {
    throw new CanonicalError('INVALID_BODY', 'contentHash.alg must be "sha256"');
  }
  if (typeof c.digest !== 'string' || !/^[0-9a-f]{64}$/.test(c.digest)) {
    throw new CanonicalError('INVALID_BODY', 'contentHash.digest must be 64 hex chars');
  }
}

// ── Signing ──

/**
 * Build a canonical-v1 envelope and sign it.
 *
 * @param wif - buyer's WIF (primary signing key for the i-address)
 * @param envelope - fully-constructed EnvelopeV1 object
 * @param network - 'verus' or 'verustest'
 * @returns { envelope, signatures: [base64] } — ready to POST as the request body
 *
 * The caller is responsible for building the envelope's payload, nonce, and timestamps.
 * For multisig identities, call signMessage separately for each co-signer and merge
 * signatures array — verifier sums over minimumsignatures.
 */
export function signCanonical(
  wif: string,
  envelope: EnvelopeV1,
  network: 'verus' | 'verustest' = 'verustest',
): SignedEnvelopeV1 {
  validateEnvelope(envelope);
  const bytes = canonicalBytes(envelope);
  const signature = signMessage(wif, bytes.toString('utf8'), network);
  emitFormatMetric('v2-canonical', envelope.cryptoSuite, envelope.action);
  return { envelope, signatures: [signature] };
}

/** Convenience for the common request-access path — generates nonce + timestamps. */
export function buildRequestAccessEnvelope(params: {
  buyerIAddress: string;
  buyerName?: string;
  sellerIAddress: string;
  sellerName?: string;
  ephemeralPubKey: string;
  ttlSeconds?: number;   // defaults to 60s (recommended window)
}): EnvelopeV1 {
  const now = Date.now();
  const ttl = Math.min(params.ttlSeconds ?? 60, 300);
  const nonce = randomHex(16);
  return {
    version: 1,
    cryptoSuite: 'verus-signmessage-v1',
    action: 'request-access',
    buyer: params.buyerName ? { iaddress: params.buyerIAddress, name: params.buyerName } : { iaddress: params.buyerIAddress },
    seller: params.sellerName ? { iaddress: params.sellerIAddress, name: params.sellerName } : { iaddress: params.sellerIAddress },
    payload: { ephemeralPubKey: params.ephemeralPubKey },
    nonce,
    issuedAt: rfc3339Ms(now),
    expiresAt: rfc3339Ms(now + ttl * 1000),
  };
}

function randomHex(bytes: number): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.randomBytes(bytes).toString('hex');
}

function rfc3339Ms(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1Z'); // toISOString() already produces ms precision
}

// ── Telemetry ──

/**
 * SDK-side format counter per spec §Telemetry.
 * Implementation: structured log line on stderr. Operators can scrape logs into Prometheus
 * via promtail / fluentbit without an in-process Prom client dependency.
 */
let _metricEmitter: (e: { event: string; format: string; cryptoSuite: string; action: string }) => void = (e) => {
  if (process.env.J41_SDK_METRICS !== '0') {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ts: new Date().toISOString(), ...e }));
  }
};

export function setMetricEmitter(fn: typeof _metricEmitter): void {
  _metricEmitter = fn;
}

function emitFormatMetric(format: 'v1-pipe' | 'v2-canonical', cryptoSuite: string, action: string): void {
  try {
    _metricEmitter({ event: 'j41_sdk_signature_format_total', format, cryptoSuite, action });
  } catch {
    // Never let metrics break the signing path.
  }
}

/** Exported for v1 callsites to increment the counter when they still emit v1. */
export function recordV1FormatEmission(action: string): void {
  emitFormatMetric('v1-pipe', 'pre-canonical', action);
}

// ── Signature verification (dispatcher mirror verifier) ──

/**
 * Verify the signatures on a v2 canonical envelope using the public J41 keys-resolver
 * endpoint (`GET /v1/identity/:idOrName/keys`).
 *
 * Steps:
 *   1. Canonicalize the envelope to bytes (idempotent JCS).
 *   2. Resolve `envelope.buyer.iaddress` via `client.getIdentityKeys()` → primary
 *      R-addresses + minimumSignatures threshold.
 *   3. For each address, find at most one signature from `signatures` that validates
 *      against it via bitcoinjs-message. Count distinct addresses that validated.
 *   4. Pass iff that count is ≥ minimumSignatures.
 *
 * No fallthrough: if the keys endpoint is unreachable, the resolved address list is
 * empty, or fewer signatures validate than the threshold requires, returns false.
 *
 * Structural validation (size, fields, windows) is NOT done here — call
 * validateEnvelope() first. This function assumes the envelope is well-formed.
 *
 * @param envelope - validated canonical envelope
 * @param signatures - base64 signatures over canonicalBytes(envelope)
 * @param client - must expose getIdentityKeys(idOrName) returning { primaryAddresses, minimumSignatures }
 * @param network - 'verus' or 'verustest'
 */
export async function verifyCanonicalSignatures(
  envelope: EnvelopeV1,
  signatures: string[],
  client: {
    getIdentityKeys(idOrName: string): Promise<{
      primaryAddresses: string[];
      minimumSignatures: number;
    }>;
  },
  network: 'verus' | 'verustest' = 'verustest',
): Promise<boolean> {
  if (!Array.isArray(signatures) || signatures.length === 0) return false;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bitcoinMessage = require('bitcoinjs-message');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const utxolib = require('@bitgo/utxo-lib');
  const net = network === 'verustest' ? utxolib.networks.verustest : utxolib.networks.verus;

  const canonical = canonicalBytes(envelope).toString('utf8');

  let resolved: { primaryAddresses: string[]; minimumSignatures: number };
  try {
    resolved = await client.getIdentityKeys(envelope.buyer.iaddress);
  } catch {
    return false;
  }

  const { primaryAddresses, minimumSignatures } = resolved;
  if (!Array.isArray(primaryAddresses) || primaryAddresses.length === 0) return false;
  const threshold = Number.isFinite(minimumSignatures) && minimumSignatures > 0 ? minimumSignatures : 1;

  // Each primary address can satisfy at most one signature. For multisig we need at
  // least `threshold` distinct addresses to validate.
  const matchedAddresses = new Set<string>();
  for (const addr of primaryAddresses) {
    for (const sig of signatures) {
      try {
        if (bitcoinMessage.verify(canonical, addr, sig, net.messagePrefix)) {
          matchedAddresses.add(addr);
          break;
        }
      } catch {
        // Try next signature.
      }
    }
    if (matchedAddresses.size >= threshold) return true;
  }

  return matchedAddresses.size >= threshold;
}
