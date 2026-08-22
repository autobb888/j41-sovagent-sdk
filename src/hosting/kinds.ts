/**
 * Listing kinds the platform mints. Must stay in lockstep with
 * junction41/src/hosting/kinds.ts — agent | compute | data | model.
 *
 * Intended parents are sov<kind>@. VRSCTEST DeFi is off, so new names mint
 * under agentplatform@ and the real kind is config.kind. advertisedIdentity
 * shows the name that will actually be minted.
 */

export const LISTING_KINDS = ['agent', 'compute', 'data', 'model'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export const KIND_PARENTS: Record<ListingKind, string> = {
  agent: 'sovagent@',
  compute: 'sovcompute@',
  data: 'sovdata@',
  model: 'sovmodel@',
};

export const LEGACY_AGENT_PARENT = 'agentplatform@';

export function parseListingKind(raw: unknown): ListingKind | null {
  if (raw === 'agent' || raw === 'compute' || raw === 'data' || raw === 'model') return raw;
  return null;
}

/** Display / pre-challenge identity. While DeFi is off this is always name.agentplatform@. */
export function advertisedIdentity(name: string, kind: ListingKind): string {
  const n = name.trim().replace(/@+$/, '');
  if (n.includes('.')) return n.endsWith('@') ? `${n}` : `${n}@`;
  return `${n}.${LEGACY_AGENT_PARENT}`;
}

export function kindFromIdentityName(name: string | null | undefined): ListingKind | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  if (n.endsWith('.sovagent@') || n.endsWith('.agentplatform@')) return 'agent';
  if (n.endsWith('.sovcompute@')) return 'compute';
  if (n.endsWith('.sovdata@')) return 'data';
  if (n.endsWith('.sovmodel@')) return 'model';
  return null;
}

export function leafFromIdentity(name: string | null | undefined): string {
  if (!name) return '';
  const n = name.trim().replace(/@+$/, '');
  const dot = n.indexOf('.');
  return dot === -1 ? n : n.slice(0, dot);
}
