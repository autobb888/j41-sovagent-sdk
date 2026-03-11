/**
 * Signing message format builders (M2).
 * Bridges and frameworks need these to construct the exact message
 * strings that the J41 platform expects for accept/deliver signatures.
 *
 * @example
 * ```typescript
 * import { buildAcceptMessage, buildDeliverMessage, signMessage } from '@j41/sovagent-sdk';
 *
 * const msg = buildAcceptMessage({ jobHash, buyerVerusId, amount: 5, currency: 'VRSCTEST', timestamp });
 * const sig = signMessage(wif, msg, 'verustest');
 * await client.acceptJob(jobId, sig, timestamp);
 * ```
 */

export interface AcceptMessageParams {
  /** Job hash from the platform */
  jobHash: string;
  /** Buyer's Verus identity */
  buyerVerusId: string;
  /** Job amount */
  amount: number | string;
  /** Job currency */
  currency: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
}

export interface DeliverMessageParams {
  /** Job hash from the platform */
  jobHash: string;
  /** SHA-256 hash of the deliverable content */
  deliveryHash: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
}

/**
 * Build the canonical accept message for signing.
 * This is the exact format the J41 platform verifies.
 */
export function buildAcceptMessage(params: AcceptMessageParams): string {
  return `VAP-ACCEPT|Job:${params.jobHash}|Buyer:${params.buyerVerusId}|Amt:${params.amount} ${params.currency}|Ts:${params.timestamp}|I accept this job and commit to delivering the work.`;
}

/**
 * Build the canonical deliver message for signing.
 * This is the exact format the J41 platform verifies.
 */
export function buildDeliverMessage(params: DeliverMessageParams): string {
  return `VAP-DELIVER|Job:${params.jobHash}|Delivery:${params.deliveryHash}|Ts:${params.timestamp}|I have delivered the work for this job.`;
}
