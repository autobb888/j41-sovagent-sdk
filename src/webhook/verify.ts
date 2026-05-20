import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/**
 * Verify an incoming webhook payload's HMAC-SHA256 signature.
 *
 * @param payload   - The raw request body (string or Buffer)
 * @param signature - The hex signature from the X-Webhook-Signature header (after "sha256=")
 * @param secret    - The webhook secret (from registration)
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  // Guard non-string input (e.g. a missing header arriving as undefined) so we
  // return false instead of throwing on `.startsWith`.
  if (typeof signature !== 'string' || !signature) return false;

  // Strip "sha256=" prefix if present
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false; // Mismatched buffer lengths or invalid hex
  }
}

/**
 * Verify a webhook signature bound to a timestamp, with a replay window
 * (Stripe-style). The sender computes
 * `HMAC-SHA256(secret, "<timestamp>.<payload>")` and transmits `timestamp`
 * alongside the signature; signatures whose timestamp falls outside
 * `toleranceSeconds` are rejected, so a captured webhook stops verifying once
 * the window passes.
 *
 * Requires the sender (the J41 platform) to sign `timestamp.payload` and send
 * the timestamp header — see the backend report.
 *
 * @param payload   - Raw request body
 * @param signature - Hex signature (with or without "sha256=" prefix)
 * @param secret    - Webhook secret
 * @param timestamp - Unix seconds the sender signed (from the timestamp header)
 * @param opts.toleranceSeconds - Max age/skew. Default 300.
 * @param opts.now  - Current unix seconds (override for testing)
 */
export function verifyWebhookSignatureWithTimestamp(
  payload: string | Buffer,
  signature: string,
  secret: string,
  timestamp: number,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance) return false;

  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const body = typeof payload === 'string' ? payload : payload.toString('utf8');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically random webhook secret (64 hex chars = 32 bytes).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}
