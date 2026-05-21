/**
 * Signing message format builders (M2).
 * Bridges and frameworks need these to construct the exact message
 * strings that the J41 platform expects for accept/deliver signatures.
 *
 * @example
 * ```typescript
 * import { buildAcceptMessage, buildDeliverMessage, signMessage } from '@junction41/sovagent-sdk';
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

/**
 * Reject a string formatted as a J41 protocol message. Used to stop the
 * auth/onboarding challenge-signing paths from acting as a signing oracle: a
 * MITM'd `/auth/challenge` could otherwise return a fully-formed `J41-*` message
 * (deposit report, access envelope, status change) which the agent would sign
 * with its identity key, handing the attacker a valid privileged signature.
 * Normalizes compatibility/zero-width/dash forms so the prefix can't be
 * smuggled past the check. Auth challenges are opaque/random and never begin
 * with `J41-`, so this has no false positives.
 */
export function assertNotProtocolMessage(text: string): void {
  if (/[\u200B-\u200F\u2028\u2029\u2060\uFEFF]/.test(text)) {
    throw new Error('Refusing to sign a challenge containing zero-width or format characters.');
  }
  const head = text.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').replace(/^\s+/, '');
  // Block signed protocol messages of the form "J41-<ACTION>|...". The
  // trailing pipe is the structural marker of a protocol message; opaque
  // auth challenges (e.g. "j41-onboard:...") have no pipe and are allowed.
  if (/^j41-[a-z0-9-]*\|/i.test(head)) {
    throw new Error('Refusing to sign a J41-protocol-formatted challenge (possible MITM/forgery attempt).');
  }
}

// ------------------------------------------
// Deposit reporting
// ------------------------------------------

export interface DepositReportParams {
  /** VerusID claiming the deposit (must control the signing key). */
  buyerVerusId: string;
  /** Seller agent's VerusID the deposit was paid to. */
  sellerVerusId: string;
  /** Transaction ID of the on-chain deposit. */
  txid: string;
  /** Amount in VRSC (string or number; stringified into the message). */
  amount: number | string;
  /** Single-use random nonce (replay protection). */
  nonce: string;
  /** Unix seconds when the report was signed (freshness window). */
  timestamp: number;
}

/**
 * Build the canonical deposit-report message for signing.
 *
 * The dispatcher's /j41/deposit/report endpoint requires this exact string to
 * be signed by `buyerVerusId` so an attacker cannot claim someone else's
 * on-chain payment as their own credit. `nonce` and `timestamp` are bound into
 * the signature for replay protection. The buyer signs with `signMessage`; the
 * dispatcher verifies with `verifyMessage` against the buyer's on-chain
 * primary address. Field order/format MUST stay byte-identical on both sides.
 */
export function buildDepositReportMessage(params: DepositReportParams): string {
  return `J41-DEPOSIT-REPORT|Buyer:${params.buyerVerusId}|Seller:${params.sellerVerusId}|Txid:${params.txid}|Amt:${params.amount}|Nonce:${params.nonce}|Ts:${params.timestamp}|I attest I sent this deposit and claim its credit.`;
}
