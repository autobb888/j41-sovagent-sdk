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
  // Strip "sha256=" prefix if present
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
}

/**
 * Generate a cryptographically random webhook secret (64 hex chars = 32 bytes).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}
