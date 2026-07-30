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
 * Fetch the snapshots with `J41Client.getIdentityHistory()` — the platform exposes
 * `/v1/me/identity/history` and `/v1/identity/:identityOrIAddr/history` (live and
 * verified 2026-07-30). `/v1/me/identity/raw` returns current state only and cannot
 * be used for this.
 */

import { VDXF_KEYS, DATA_DESCRIPTOR_KEY } from '../onboarding/vdxf.js';

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

  // Sort ascending by height rather than trusting input order. The endpoint that
  // feeds this is not written yet, and if it ever returns newest-first the
  // earliest-wins dedupe in decodeReviewHistory silently inverts to latest-wins —
  // with every height still individually correct, so the bug would be invisible.
  // Snapshots without a height keep their relative order and sort last.
  const ordered = [...snapshots].sort((a, b) => {
    const ha = snapshotHeight(a);
    const hb = snapshotHeight(b);
    if (ha === null && hb === null) return 0;
    if (ha === null) return 1;
    if (hb === null) return -1;
    return ha - hb;
  });

  const out: VdxfHistoryEntry[] = [];
  let lastSnapshotSerialized: string | null = null;

  for (const snap of ordered) {
    const cmm = snap && snap.identity ? snap.identity.contentmultimap : null;
    if (!cmm) continue;
    const raw = (cmm as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;

    const values = Array.isArray(raw) ? raw : [raw];

    // Compare the WHOLE array per snapshot. Comparing element-by-element against a
    // single rolling value mis-handles multi-value arrays: [A,B] followed by an
    // identical [A,B] would emit A,B,A,B, breaking this function's own contract
    // that an unchanged value is one historical entry, not two.
    let snapSerialized: string;
    try { snapSerialized = JSON.stringify(values); } catch { snapSerialized = String(values); }
    if (snapSerialized === lastSnapshotSerialized) continue;
    lastSnapshotSerialized = snapSerialized;

    const height = snapshotHeight(snap);
    for (const value of values) out.push({ height, value });
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

/**
 * Unwrap a makeSubDD DataDescriptor if present.
 *
 * `buildJobCompletionAdditions` and the job_record synthesis path write records as
 * `{ [DATA_DESCRIPTOR_KEY]: { objectdata: { message: "<json>" }, ... } }`, so a
 * decoder that only understands bare hex(JSON) silently drops every DD-wrapped
 * record — values that are not malformed at all, merely wrapped.
 */
function unwrapDataDescriptor(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const dd = (value as Record<string, unknown>)[DATA_DESCRIPTOR_KEY] as Record<string, unknown> | undefined;
  if (!dd) return value;
  const od = dd.objectdata;
  if (od && typeof od === 'object' && typeof (od as Record<string, unknown>).message === 'string') {
    return (od as Record<string, unknown>).message;
  }
  if (typeof od === 'string') return od;
  return value;
}

/** Decode one on-chain review value. Returns null when it is not decodable. */
function decodeReviewValue(value: unknown): Record<string, unknown> | null {
  try {
    const unwrapped = unwrapDataDescriptor(value);

    if (typeof unwrapped === 'string') {
      // Either hex(JSON) — the platform inbox path — or plain JSON from a DD message.
      let json = unwrapped;
      if (/^[0-9a-fA-F]+$/.test(unwrapped) && unwrapped.length % 2 === 0) {
        json = Buffer.from(unwrapped, 'hex').toString('utf8');
      }
      const parsed = JSON.parse(json);
      // An array is not a review record; emitting it would yield an all-null row.
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    }
    if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
      return unwrapped as Record<string, unknown>;
    }
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
