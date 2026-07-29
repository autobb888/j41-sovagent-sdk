/**
 * Per-type VDXF allowlists for inbox accepts — the single source of truth.
 *
 * Why this module exists: `acceptReview`, `acceptAttestationTuple` and
 * `acceptJobRecord` each carried their own inline copy of an allowlist. Audit
 * 2026-06-02 H8 added them; commit 52f8d07 later had to NARROW the review one
 * after a review found it admitting the attestation key — a compromised platform
 * inbox could otherwise hand back any VDXF key (e.g. `agent.payAddress`) and we
 * would write attacker-controlled data to our own on-chain identity.
 *
 * Three inline copies is three chances to drift. Batched accepts
 * (`acceptInboxBatch`) add a fourth caller, so the allowlists live here and every
 * path — single and batched — goes through `buildInboxVdxfAdditions`. An item's
 * additions are gated against ITS OWN type before any merging happens, so a key
 * can never ride into a batch under a different item's type.
 *
 * Pure: no network, no wallet, no chain. Error messages are byte-compatible with
 * the previous inline implementations because existing tests pin them
 * (`test/accept-review-path.test.ts`, `test/accept-attestation.test.ts`) — those
 * tests are the regression proof that 52f8d07 is preserved.
 */

import { VDXF_KEYS, makeSubDD, contentmultimapValueByteSize } from '../onboarding/vdxf.js';

export type InboxAcceptType = 'review' | 'attestation' | 'job_record';

/**
 * Conservative ceiling on the TOTAL additions merged into one batch tx.
 *
 * The per-value cliff (~5.5KB script element) is enforced separately by
 * `assertContentmultimapValueSizes`; this is a belt-and-braces total. The
 * one-item-per-key rule structurally caps a batch at 3 distinct keys today
 * (review.record, review.attestation, job.record), so 3 x ~5000 = 15000 is an
 * upper bound that should never bind in practice. It exists so that if the key
 * set grows later, a batch degrades by DEFERRING items to the next cycle rather
 * than silently building an oversized transaction.
 */
export const MAX_BATCH_ADDITION_BYTES = 15000;

const ALLOWLISTS: Record<InboxAcceptType, ReadonlySet<string>> = {
  // Exactly review.record. NOT the attestation key — see 52f8d07.
  review: new Set([VDXF_KEYS.review.record]),
  // Exactly the attestation key.
  attestation: new Set([VDXF_KEYS.review.attestation]),
  // The job.* namespace (currently just job.record).
  job_record: new Set(Object.values(VDXF_KEYS.job)),
};

/** The exact allowlist for one inbox item type. Throws on an unknown type — never defaults open. */
export function inboxAllowlistForType(type: InboxAcceptType): ReadonlySet<string> {
  const allow = ALLOWLISTS[type];
  if (!allow) throw new Error(`unsupported inbox type: ${String(type)}`);
  return allow;
}

/** Human-readable namespace label used in the pinned error strings. */
const NAMESPACE_LABEL: Record<InboxAcceptType, string> = {
  review: 'review.*',
  attestation: 'review.attestation',
  job_record: 'job.*',
};

/** What a dropped-key warning says the expected namespace was. */
const DROP_LABEL: Record<InboxAcceptType, string> = {
  review: 'not in review.* namespace',
  attestation: 'not review.attestation',
  job_record: 'not in job.* namespace',
};

/**
 * The subset of an inbox item this module reads. Deliberately NOT an index
 * signature: `InboxItemDetail` has no index signature, so requiring one here
 * would make the real type non-assignable. `amount` / `currency` / `completedAt`
 * are not on `InboxItem` at all (the previous inline code reached them via
 * `as any`) — they are typed `unknown` so callers can pass them when present.
 */
export interface InboxItemLike {
  vdxfData?: Record<string, unknown> | null;
  senderVerusId?: string;
  jobHash?: string;
  amount?: unknown;
  currency?: unknown;
  completedAt?: unknown;
}

/**
 * Validate one inbox item's vdxfData against ITS OWN type gate and return the
 * vdxfAdditions map for that item alone.
 *
 * Throws when the item is unusable: unknown type, nothing left after the
 * whitelist, or absent vdxfData for a type that must not synthesize. `review`
 * and `attestation` must never be synthesized — the buyer's signature covers the
 * exact bytes the platform emitted, so rebuilding locally would stamp a fresh
 * timestamp and produce an unverifiable record. `job_record` keeps its historical
 * synthesis fallback.
 *
 * `label` prefixes messages, e.g. "acceptReview <inboxId>".
 */
export function buildInboxVdxfAdditions(
  type: InboxAcceptType,
  inboxItem: InboxItemLike,
  label: string,
): Record<string, unknown[]> {
  const allow = inboxAllowlistForType(type);
  // Null-prototype: the membership test below must not consult Object.prototype.
  const vdxfAdditions: Record<string, unknown[]> = Object.create(null);

  const hasData = !!inboxItem.vdxfData && Object.keys(inboxItem.vdxfData).length > 0;

  if (hasData) {
    for (const [key, value] of Object.entries(inboxItem.vdxfData!)) {
      if (value == null) continue;
      if (!allow.has(key)) {
        console.error(
          `[J41] ${label}: dropping unexpected VDXF key ${key} ` +
          `(${DROP_LABEL[type]}) — possible platform tampering`,
        );
        continue;
      }
      vdxfAdditions[key] = Array.isArray(value) ? value : [value];
    }
    if (Object.keys(vdxfAdditions).length === 0) {
      throw new Error(`${label}: inbox vdxfData contained no ${NAMESPACE_LABEL[type]} keys after whitelist`);
    }
    return vdxfAdditions;
  }

  // No pre-formatted VDXF payload.
  if (type === 'job_record') {
    const jobRecord: Record<string, unknown> = { timestamp: Math.floor(Date.now() / 1000) };
    if (inboxItem.senderVerusId) jobRecord.buyer = inboxItem.senderVerusId;
    if (inboxItem.jobHash) jobRecord.jobHash = inboxItem.jobHash;
    if (inboxItem.amount != null) jobRecord.amount = inboxItem.amount;
    if (inboxItem.currency) jobRecord.currency = inboxItem.currency;
    if (inboxItem.completedAt) jobRecord.completedAt = inboxItem.completedAt;
    vdxfAdditions[VDXF_KEYS.job.record] = [makeSubDD(VDXF_KEYS.job.record, JSON.stringify(jobRecord))];
    return vdxfAdditions;
  }

  const missingKey = type === 'review' ? 'review.record' : 'review.attestation';
  throw new Error(
    `${label}: inbox item has no VDXF ${missingKey} — ` +
    `refusing to synthesize one (would produce an unverifiable on-chain record)`,
  );
}

/** Total byte size of every value across an additions map. */
export function additionsByteSize(additions: Record<string, unknown[]>): number {
  let total = 0;
  for (const values of Object.values(additions)) {
    for (const v of values) total += contentmultimapValueByteSize(v);
  }
  return total;
}

/** One item to include in a batched accept. */
export interface InboxBatchItemRef {
  id: string;
  type: InboxAcceptType;
}

/**
 * Outcome of one batched accept. Every item lands in exactly one bucket, so the
 * caller can apply the right retry semantics per item rather than treating the
 * whole batch as a single success/failure.
 */
export interface InboxBatchResult {
  /** Broadcast txid, or null when nothing needed a chain write. */
  txid: string | null;
  /**
   * The expiryHeight stamped into the broadcast tx, or null when nothing was
   * broadcast. The caller needs this to decide when a pending write is provably
   * dead rather than merely slow: a wall-clock guess would release the gate while
   * the tx is still valid in the mempool and rebuild the double-spend.
   */
  expiryHeight: number | null;
  /** Items whose value is on-chain (freshly written, or already present). */
  written: InboxBatchItemRef[];
  /** Inbox ids the backend has acknowledged as accepted. */
  acked: string[];
  /** On-chain but the ack failed — transient; must NOT count against a retry budget. */
  ackFailed: Array<{ id: string; error: string }>;
  /** Hard, item-specific failures. The caller dead-letters these individually. */
  rejected: Array<{ id: string; type: string; error: string }>;
  /** Transient, item-specific — retried next cycle, neither counted nor cleared. */
  deferred: Array<{ id: string; type: string; reason: string }>;
  /** Items the backend already reported as non-pending when fetched. */
  alreadyDone: string[];
}

/** Safe message extraction — a non-Error throw must not break a catch block. */
export function errMsg(e: unknown): string {
  return (e && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e)) || String(e);
}

/**
 * True when the backend reports this inbox item was already accepted.
 *
 * The ack handler flips status→accepted and then best-effort inserts a cached
 * review row; those two steps are NOT in one transaction. Once the status UPDATE
 * commits the item is accepted no matter what follows, and re-accepting returns
 * 400 ALREADY_PROCESSED. That is terminal success — it is what a lost ack
 * response looks like on retry. Matched on the machine code, never the prose.
 */
export function isAlreadyProcessed(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as { code?: string }).code === 'ALREADY_PROCESSED');
}

/**
 * True when `key`'s value is already present on-chain with the same content.
 *
 * Used to skip a redundant broadcast when only the backend ack is outstanding.
 * Without it, a persistently failing ack rebroadcasts identical data every cycle
 * at 10,000 sats a time. Compared structurally — on-chain values round-trip
 * through JSON, so reference equality is not available.
 */
export function valueAlreadyOnChain(
  onChain: Record<string, unknown>,
  key: string,
  values: unknown[],
): boolean {
  const existing = onChain?.[key];
  if (existing === undefined || existing === null) return false;
  const existingArr = Array.isArray(existing) ? existing : [existing];
  if (existingArr.length !== values.length) return false;
  try {
    return JSON.stringify(existingArr) === JSON.stringify(values);
  } catch {
    return false;
  }
}
