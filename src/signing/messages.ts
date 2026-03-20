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
  return `J41-ACCEPT|Job:${params.jobHash}|Buyer:${params.buyerVerusId}|Amt:${params.amount} ${params.currency}|Ts:${params.timestamp}|I accept this job and commit to delivering the work.`;
}

/**
 * Build the canonical deliver message for signing.
 * This is the exact format the J41 platform verifies.
 */
export function buildDeliverMessage(params: DeliverMessageParams): string {
  return `J41-DELIVER|Job:${params.jobHash}|Delivery:${params.deliveryHash}|Ts:${params.timestamp}|I have delivered the work for this job.`;
}

export interface DisputeRespondMessageParams {
  /** Job hash (or request_signature) from the platform */
  jobHash: string;
  /** Dispute response action */
  action: 'refund' | 'rework' | 'rejected';
  /** Unix timestamp (seconds) */
  timestamp: number;
}

export interface ReworkAcceptMessageParams {
  /** Job hash (or request_signature) from the platform */
  jobHash: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
}

/**
 * Build the canonical dispute-respond message for signing.
 * Uses first 16 chars of jobHash per platform spec.
 */
export function buildDisputeRespondMessage(params: DisputeRespondMessageParams): string {
  return `J41-DISPUTE-RESPOND|Job:${params.jobHash.slice(0, 16)}|Action:${params.action}|Ts:${params.timestamp}`;
}

/**
 * Build the canonical rework-accept message for signing.
 * Uses first 16 chars of jobHash per platform spec.
 */
export function buildReworkAcceptMessage(params: ReworkAcceptMessageParams): string {
  return `J41-REWORK-ACCEPT|Job:${params.jobHash.slice(0, 16)}|Ts:${params.timestamp}`;
}

/**
 * Build the canonical complete message for signing.
 * Used by buyers to confirm work has been delivered satisfactorily.
 */
export function buildCompleteMessage(jobHash: string, timestamp: number): string {
  return `J41-COMPLETE|Job:${jobHash}|Ts:${timestamp}|I confirm the work has been delivered satisfactorily.`;
}

/**
 * Build the canonical dispute message for signing.
 * Used by buyers to raise a dispute on a job.
 */
export function buildDisputeMessage(jobHash: string, reason: string, timestamp: number): string {
  return `J41-DISPUTE|Job:${jobHash}|Reason:${reason}|Ts:${timestamp}|I am raising a dispute on this job.`;
}

// ------------------------------------------
// Bounty signing messages
// ------------------------------------------

/**
 * Build the canonical post-bounty message for signing.
 * Must match the exact format the J41 platform verifies.
 */
export function buildPostBountyMessage(title: string, amount: number | string, currency: string, timestamp: number): string {
  return `J41-BOUNTY|Post:${title}|Amount:${amount}|Currency:${currency}|Ts:${timestamp}|I commit to funding this bounty.`;
}

/**
 * Build the canonical apply-to-bounty message for signing.
 */
export function buildApplyBountyMessage(bountyId: string, timestamp: number): string {
  return `J41-BOUNTY-APPLY|Bounty:${bountyId}|Ts:${timestamp}`;
}

/**
 * Build the canonical select-claimants message for signing.
 */
export function buildSelectClaimantsMessage(bountyId: string, applicantIds: string[], timestamp: number): string {
  return `J41-BOUNTY-SELECT|Bounty:${bountyId}|Selected:${applicantIds.join(',')}|Ts:${timestamp}`;
}
