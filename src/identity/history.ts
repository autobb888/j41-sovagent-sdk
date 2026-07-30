/**
 * Reconstructing on-chain history from `getidentityhistory`.
 *
 * Why this exists: every record type we write on-chain lives under ONE fixed VDXF
 * key — `review.record`, `review.attestation`, `job.record` are each a single
 * i-address, not one key per record. `buildIdentityUpdateTx` REPLACES a key's
 * array (`update.ts:117-120`), so an identity's CURRENT contentmultimap holds only
 * the newest value for each. Reading current state therefore shows exactly one
 * review, however many an agent has actually received.
 *
 * That is not data loss. Verus retains every prior state: `getidentityhistory`
 * returns complete identity snapshots at each update height, contentmultimap
 * included, so the full timeline is reconstructible.
 *
 *   verus getidentityhistory "name@ || iid" (heightstart) (heightend) (txproofs) (txproofheight)
 *
 * These helpers are the client-side half of that reconstruction. They are pure —
 * given snapshots, they walk them — so they are useful and testable regardless of
 * how the snapshots are obtained.
 *
 * NOTE: fetching the snapshots requires a platform endpoint that does not exist
 * yet (`/v1/me/identity/raw` returns current state only). See
 * `J41Client.getIdentityHistory()` for the proposed contract.
 */

import { VDXF_KEYS } from '../onboarding/vdxf.js';

/** One complete identity snapshot as returned by getidentityhistory. */
export interface IdentityHistorySnapshot {
  height?: number;
  blockheight?: number;
  identity?: {
    contentmultimap?: Record<string, unknown> | null;
    [k: string]: unknown;
  } | null;
  [k: string]: unknown;
}

/** One historical value observed under a VDXF key, with the height it appeared at. */
export interface VdxfHistoryEntry {
  height: number | null;
  value: unknown;
}

function snapshotHeight(s: IdentityHistorySnapshot): number | null {
  if (typeof s.height === 'number') return s.height;
  if (typeof s.blockheight === 'number') return s.blockheight;
  return null;
}

/**
 * Walk identity snapshots oldest-first and collect every distinct value that has
 * appeared under `key`.
 *
 * Consecutive duplicates are collapsed: an update that changed some *other* key
 * leaves this one unchanged, and that is one historical entry, not two.
 */
export function extractVdxfHistory(
  snapshots: IdentityHistorySnapshot[] | null | undefined,
  key: string,
): VdxfHistoryEntry[] {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

  const out: VdxfHistoryEntry[] = [];
  let lastSerialized: string | null = null;

  for (const snap of snapshots) {
    const cmm = snap && snap.identity ? snap.identity.contentmultimap : null;
    if (!cmm) continue;
    const raw = (cmm as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;

    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      let serialized: string;
      try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
      if (serialized === lastSerialized) continue; // unchanged across this update
      lastSerialized = serialized;
      out.push({ height: snapshotHeight(snap), value });
    }
  }
  return out;
}

/** A review recovered from identity history. */
export interface HistoricalReview {
  height: number | null;
  jobHash: string | null;
  buyer: string | null;
  rating: number | null;
  timestamp: number | null;
  signature: string | null;
  raw: unknown;
}

/** Decode one on-chain review value. Returns null when it is not decodable. */
function decodeReviewValue(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value === 'string') {
      // On-chain reviews are hex(JSON).
      if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return null;
      const json = Buffer.from(value, 'hex').toString('utf8');
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    }
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch { /* fall through */ }
  return null;
}

/**
 * Reconstruct an agent's full review history from identity snapshots.
 *
 * Oldest-first. Deduplicated by `jobHash` keeping the EARLIEST height — the
 * platform's review re-submit is not idempotent, so the same review can be written
 * more than once; the first write is the one that happened.
 *
 * An undecodable entry is skipped rather than aborting: one malformed legacy value
 * must not cost an agent its entire verifiable history.
 */
export function decodeReviewHistory(
  snapshots: IdentityHistorySnapshot[] | null | undefined,
): HistoricalReview[] {
  const entries = extractVdxfHistory(snapshots, VDXF_KEYS.review.record);
  const seen = new Set<string>();
  const out: HistoricalReview[] = [];

  for (const e of entries) {
    const rec = decodeReviewValue(e.value);
    if (!rec) continue;
    const jobHash = typeof rec.jobHash === 'string' ? rec.jobHash : null;
    if (jobHash) {
      if (seen.has(jobHash)) continue;
      seen.add(jobHash);
    }
    out.push({
      height: e.height,
      jobHash,
      buyer: typeof rec.buyer === 'string' ? rec.buyer : null,
      rating: typeof rec.rating === 'number' ? rec.rating : null,
      timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : null,
      signature: typeof rec.signature === 'string' ? rec.signature : null,
      raw: rec,
    });
  }
  return out;
}
