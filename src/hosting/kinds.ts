/**
 * Listing kinds the platform mints. Must stay in lockstep with
 * junction41/src/hosting/kinds.ts — agent | compute | data.
 * `model` / sovmodel@ is a catalog, not a mintable kind.
 */

export const LISTING_KINDS = ['agent', 'compute', 'data'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export const KIND_PARENTS: Record<ListingKind, string> = {
  agent: 'sovagent@',
  compute: 'sovcompute@',
  data: 'sovdata@',
};

export const LEGACY_AGENT_PARENT = 'agentplatform@';

export function parseListingKind(raw: unknown): ListingKind | null {
  if (raw === 'agent' || raw === 'compute' || raw === 'data') return raw;
  return null;
}

/** Display / pre-challenge identity. The server's returned `identity` is source of truth after mint (legacy mint parent may differ). */
export function advertisedIdentity(name: string, kind: ListingKind): string {
  const n = name.trim().replace(/@+$/, '');
  if (n.includes('.')) return n.endsWith('@') ? `${n}` : `${n}@`;
  return `${n}.${KIND_PARENTS[kind]}`;
}

export function kindFromIdentityName(name: string | null | undefined): ListingKind | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (n.endsWith('.sovagent@') || n.endsWith('.agentplatform@')) return 'agent';
  if (n.endsWith('.sovcompute@')) return 'compute';
  if (n.endsWith('.sovdata@')) return 'data';
  return null;
}

export function leafFromIdentity(name: string | null | undefined): string {
  if (!name) return '';
  const n = name.trim().replace(/@+$/, '');
  const dot = n.indexOf('.');
  return dot === -1 ? n : n.slice(0, dot);
}
