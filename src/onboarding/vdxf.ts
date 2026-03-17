import type { AgentProfileInput, ServiceInput } from './finalize.js';

// --- Constants ---

export const DATA_DESCRIPTOR_KEY = 'i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv';

export const PARENT_KEYS = {
  agent:    'i8XMutgp1MRNoFoHQuzZ4ReowJd9NvCgDP', // agentplatform::agent
  service:  'i8pfR86vr8qbTPHbhmNQFJo8MYSWKv2TZD', // agentplatform::svc
  review:   'iMTQf3r1icnRfKLNtr5eByLKXZfsSzUt5f', // agentplatform::review
  session:  'iGxK7ke8RptD2mkhmUgjMASFysopezAT4n', // agentplatform::session
  platform: 'iMc951yUdCup5rFgZb8nwDFhkdd8Fktg2a', // agentplatform::platform
} as const;

export const VDXF_KEYS = {
  // 13 agent keys (dropped version — identity versioning is implicit on-chain)
  agent: {
    displayName: 'iRQbTzu3EywTKp1V7f2fQBYrWZaN8nmruT',  // agentplatform::agent.displayName
    type: 'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP',          // agentplatform::agent.type
    description: 'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk',   // agentplatform::agent.description
    status: 'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh',         // agentplatform::agent.status
    owner: 'iEEqjQsh5YDrwMyxyTrHFrMHTqrsPziCqu',          // agentplatform::agent.owner
    capabilities: 'iKvdcPPkopuPsRPbfNZajRS6XrM2naqBkS',   // agentplatform::agent.capabilities
    endpoints: 'i5wCnfSKQNGjzCEVYJFAbupki1Jzn9PhbX',      // agentplatform::agent.endpoints
    protocols: 'i5HYZJ4ngrNkRTTotMgUXEVeNXpJX1YLE1',      // agentplatform::agent.protocols
    services: 'i8Wk7fcbsBWtcf965Z3WvDUjahF1aTH1tu',       // agentplatform::agent.services
    tags: 'iGgajhcBKG2Pbg62JKGfRnSzFtaaVxVMBG',           // agentplatform::agent.tags
    website: 'i8fhxWw67oyxpC5BkZnNParN6yeCBNa4ht',        // agentplatform::agent.website
    avatar: 'iFX1zmLM7k5mptZ4TAyhGTU7xMf11pbLco',         // agentplatform::agent.avatar
    category: 'iLDxWHYa2b8VmrNcwLLtaHQPjuvvuYk3pS',      // agentplatform::agent.category
  },
  // 9 service keys (merged price+currency into pricing; added paymentTerms, privateMode, sovguard)
  service: {
    name: 'iSBNgN2BMkNVfQnTCkhjhi8q1aDT9sHUrf',           // agentplatform::svc.name
    description: 'iDPdLKnbxvM8MCRhizzBtajPjh1w3TWTtN',    // agentplatform::svc.description
    pricing: 'iJ8xMSNHFQm4yFKdcDPXLFAEqbVhLacTCQ',        // agentplatform::svc.pricing (JSON array)
    category: 'iGKfKjQHV2hMLKB2Mv74AoiyTXLbzFxGQ7',       // agentplatform::svc.category
    turnaround: 'iLGXYrGT7g179bd5SWweSQ3x4vobE3z9UC',     // agentplatform::svc.turnaround
    status: 'iBF5sDA9FaQAbF9uuUEFfBFvP63zEfYEKT',         // agentplatform::svc.status
    paymentTerms: 'iJYDuVKMnD3MR8GZ6m3Rk5YDhqaeiVMfjv',   // agentplatform::svc.paymentTerms
    privateMode: 'i4VEwsNBm4GsFT5bBJXq1ZH5YhEKr3SwkN',    // agentplatform::svc.privateMode
    sovguard: 'iHJa8LgKT4VBqmSVaUb3anNcj8VzPSpUB4',       // agentplatform::svc.sovguard
  },
  // 6 review keys
  review: {
    buyer: 'iLZZWJaAr22J4JAVyL4hveHM2MEu4Z1jBj',
    jobHash: 'iFjA7uUrbSSt58HvQiHKHEvX1ZbdEtGVB8',
    message: 'iBNhKz8Szk5BXLdKrAoY915rduCnek1N5R',
    rating: 'i4wBxE7NWmCHgkVZipjuV3TdkTg54gUHLy',
    signature: 'iR33Uxq9t8PsZVmXSCrqCgSuFDDRqPSBNN',
    timestamp: 'iPsZqEAa6TJJuXbrKkNZaug7p7zkFGvUFG',
  },
  // 3 platform keys
  platform: {
    datapolicy: 'i64CkpXE8aCL4gDBC3RLACjT38iUtZNwyN',
    trustlevel: 'iMHLQKGL9kyc1CmgBKdhBxYWoJ72vxvWzT',
    disputeresolution: 'i8hM7bqWUhB4Qi8WJH5FrXyQFW8aNSgSSH',
  },
  // 1 session key (consolidated from 6 separate keys)
  session: {
    params: 'iHjLTt9P8Jb1uCYSpVpwXFbwzbPYWW4n8p',         // agentplatform::session.params (proper VDXF ID via getvdxfid)
  },
} as const;

// --- Reverse lookups ---

const AGENT_I_ADDRESS_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(VDXF_KEYS.agent).map(([k, v]) => [v, k])
);
const SERVICE_I_ADDRESS_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(VDXF_KEYS.service).map(([k, v]) => [v, k])
);
const REVIEW_I_ADDRESS_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(VDXF_KEYS.review).map(([k, v]) => [v, k])
);
const SESSION_I_ADDRESS_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(VDXF_KEYS.session).map(([k, v]) => [v, k])
);
const PLATFORM_I_ADDRESS_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(VDXF_KEYS.platform).map(([k, v]) => [v, k])
);

function getReverseLookup(type: string): Record<string, string> {
  switch (type) {
    case 'agent': return AGENT_I_ADDRESS_TO_FIELD;
    case 'service': return SERVICE_I_ADDRESS_TO_FIELD;
    case 'review': return REVIEW_I_ADDRESS_TO_FIELD;
    case 'session': return SESSION_I_ADDRESS_TO_FIELD;
    case 'platform': return PLATFORM_I_ADDRESS_TO_FIELD;
    default: return {};
  }
}

// --- DataDescriptor helpers ---

/**
 * Build a sub-DataDescriptor (text/plain, flags=96).
 * Label is the field i-address, value is stored as objectdata.message.
 */
export function makeSubDD(label: string, value: string): object {
  return {
    [DATA_DESCRIPTOR_KEY]: {
      version: 1,
      flags: 96,
      mimetype: 'text/plain',
      objectdata: { message: value },
      label,
    },
  };
}

/**
 * Build an outer DataDescriptor that wraps an array of sub-DDs.
 * flags=32 (raw), objectdata is the sub-DD array.
 */
function makeOuterDD(subDDs: object[], label?: string): object {
  return {
    [DATA_DESCRIPTOR_KEY]: {
      version: 1,
      flags: 32,
      objectdata: subDDs,
      ...(label ? { label } : {}),
    },
  };
}

/**
 * Parse a sub-DD to extract label + value.
 */
function parseSubDD(entry: unknown): { label: string; value: unknown } | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const dd = (entry as Record<string, unknown>)[DATA_DESCRIPTOR_KEY] as Record<string, unknown> | undefined;
  if (!dd) return null;
  const label = (dd.label as string) || '';
  if (dd.objectdata === null) return null; // deleted entry
  if (typeof dd.objectdata === 'object' && dd.objectdata !== null && 'message' in (dd.objectdata as object)) {
    return { label, value: (dd.objectdata as { message: unknown }).message };
  }
  if (typeof dd.objectdata === 'string') {
    try { return { label, value: JSON.parse(Buffer.from(dd.objectdata, 'hex').toString('utf-8')) }; }
    catch { return { label, value: dd.objectdata }; }
  }
  return { label, value: dd.objectdata };
}

/**
 * Parse an outer DD (nested pattern — objectdata is an array of sub-DDs).
 * Returns a map of resolved field names → values.
 */
function parseOuterDD(entry: unknown, type: string): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const dd = (entry as Record<string, unknown>)[DATA_DESCRIPTOR_KEY] as Record<string, unknown> | undefined;
  if (!dd) return null;
  if (!Array.isArray(dd.objectdata)) return null;

  const record: Record<string, unknown> = {};
  const reverseLookup = getReverseLookup(type);

  for (const subEntry of dd.objectdata) {
    const sub = parseSubDD(subEntry);
    if (!sub || !sub.label) continue;
    // Resolve label: try as i-address first, then as plain field name
    const fieldName = reverseLookup[sub.label] || sub.label;
    record[fieldName] = sub.value;
  }
  return record;
}

// --- Legacy helpers (kept for backwards compat during transition) ---

export function encodeVdxfValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
}

export function decodeVdxfValue(hex: string): unknown {
  try {
    return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch {
    return Buffer.from(hex, 'hex').toString('utf8');
  }
}

export function getCanonicalVdxfDefinitionCount(): number {
  return Object.values(VDXF_KEYS).reduce((n, group) => n + Object.keys(group).length, 0);
}

// --- Build nested DD contentmultimap ---

/**
 * Build a nested DataDescriptor contentmultimap for an agent profile + services.
 * Produces the on-chain format: { parentKeyIAddress: [outerDD] }
 *
 * Agent, session, and platform data → single outer DD under their parent key.
 * Services → one outer DD per service under the service parent key.
 */
export function buildAgentContentMultimap(
  profile?: AgentProfileInput,
  services: ServiceInput[] = [],
): Record<string, unknown[]> {
  const contentmultimap: Record<string, unknown[]> = {};

  if (profile) {
    // --- Agent data ---
    const agentSubDDs: object[] = [];
    const K = VDXF_KEYS.agent;

    agentSubDDs.push(makeSubDD(K.displayName, profile.name));
    agentSubDDs.push(makeSubDD(K.type, profile.type));
    agentSubDDs.push(makeSubDD(K.description, profile.description));
    agentSubDDs.push(makeSubDD(K.status, 'active'));

    if (profile.category) agentSubDDs.push(makeSubDD(K.category, profile.category));
    if (profile.owner) agentSubDDs.push(makeSubDD(K.owner, profile.owner));
    if (profile.tags?.length) agentSubDDs.push(makeSubDD(K.tags, JSON.stringify(profile.tags)));
    if (profile.website) agentSubDDs.push(makeSubDD(K.website, profile.website));
    if (profile.avatar) agentSubDDs.push(makeSubDD(K.avatar, profile.avatar));
    if (profile.protocols?.length) agentSubDDs.push(makeSubDD(K.protocols, JSON.stringify(profile.protocols)));
    if (profile.endpoints?.length) agentSubDDs.push(makeSubDD(K.endpoints, JSON.stringify(profile.endpoints)));
    if (profile.capabilities?.length) agentSubDDs.push(makeSubDD(K.capabilities, JSON.stringify(profile.capabilities)));

    contentmultimap[PARENT_KEYS.agent] = [makeOuterDD(agentSubDDs, PARENT_KEYS.agent)];

    // --- Session data (consolidated into single params JSON object) ---
    if (profile.session && Object.keys(profile.session).length > 0) {
      const sessionSubDDs: object[] = [];
      sessionSubDDs.push(makeSubDD(VDXF_KEYS.session.params, JSON.stringify(profile.session)));

      contentmultimap[PARENT_KEYS.session] = [makeOuterDD(sessionSubDDs, PARENT_KEYS.session)];
    }

    // --- Platform data ---
    const platformSubDDs: object[] = [];
    const PK = VDXF_KEYS.platform;

    if (profile.datapolicy) {
      // datapolicy is structured JSON: {retention, allowTraining, allowThirdParty, requireDeletion}
      const policyValue = typeof profile.datapolicy === 'string'
        ? profile.datapolicy
        : JSON.stringify(profile.datapolicy);
      platformSubDDs.push(makeSubDD(PK.datapolicy, policyValue));
    }
    if (profile.trustlevel) platformSubDDs.push(makeSubDD(PK.trustlevel, profile.trustlevel));
    if (profile.disputeresolution) platformSubDDs.push(makeSubDD(PK.disputeresolution, profile.disputeresolution));

    if (platformSubDDs.length > 0) {
      contentmultimap[PARENT_KEYS.platform] = [makeOuterDD(platformSubDDs, PARENT_KEYS.platform)];
    }
  }

  // --- Services (one outer DD per service) ---
  if (services.length > 0) {
    const SK = VDXF_KEYS.service;
    contentmultimap[PARENT_KEYS.service] = services.map((svc) => {
      const subDDs: object[] = [];
      subDDs.push(makeSubDD(SK.name, svc.name));
      if (svc.description) subDDs.push(makeSubDD(SK.description, svc.description));
      if (svc.category) subDDs.push(makeSubDD(SK.category, svc.category));

      // Build pricing array: primary price/currency + any acceptedCurrencies
      const pricingArray: Array<{ currency: string; price: number }> = [];
      if (svc.price != null && svc.currency) {
        pricingArray.push({ currency: svc.currency, price: svc.price });
      }
      if (svc.acceptedCurrencies?.length) {
        for (const ac of svc.acceptedCurrencies) {
          pricingArray.push({ currency: ac.currency, price: ac.price });
        }
      }
      if (pricingArray.length > 0) {
        subDDs.push(makeSubDD(SK.pricing, JSON.stringify(pricingArray)));
      }

      if (svc.turnaround) subDDs.push(makeSubDD(SK.turnaround, svc.turnaround));
      if (svc.paymentTerms) subDDs.push(makeSubDD(SK.paymentTerms, svc.paymentTerms));
      if (svc.privateMode != null) subDDs.push(makeSubDD(SK.privateMode, String(svc.privateMode)));
      if (svc.sovguard != null) subDDs.push(makeSubDD(SK.sovguard, String(svc.sovguard)));
      subDDs.push(makeSubDD(SK.status, 'active'));
      return makeOuterDD(subDDs, PARENT_KEYS.service);
    });
  }

  return contentmultimap;
}

// --- Decode nested DD contentmultimap ---

/**
 * Decode a nested DataDescriptor contentmultimap back into an AgentProfileInput + services.
 * Handles both nested DD format (primary) and legacy flat hex format (fallback).
 */
export function decodeContentMultimap(cmm: Record<string, unknown[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
} {
  const profile: Partial<AgentProfileInput> = {};
  const session: Partial<NonNullable<AgentProfileInput['session']>> = {};
  const services: ServiceInput[] = [];

  // --- Try nested DD format first ---
  const agentEntries = cmm[PARENT_KEYS.agent];
  if (agentEntries?.length) {
    // Take the LAST outer DD (updateidentity appends, latest wins)
    const agentData = parseOuterDD(agentEntries[agentEntries.length - 1], 'agent');
    if (agentData) {
      if (agentData.displayName) profile.name = agentData.displayName as string;
      if (agentData.type) profile.type = agentData.type as AgentProfileInput['type'];
      if (agentData.description) profile.description = agentData.description as string;
      if (agentData.category) profile.category = agentData.category as string;
      if (agentData.owner) profile.owner = agentData.owner as string;
      if (agentData.website) profile.website = agentData.website as string;
      if (agentData.avatar) profile.avatar = agentData.avatar as string;
      if (agentData.tags) {
        profile.tags = typeof agentData.tags === 'string' ? JSON.parse(agentData.tags) : agentData.tags as string[];
      }
      if (agentData.protocols) {
        profile.protocols = typeof agentData.protocols === 'string' ? JSON.parse(agentData.protocols) : agentData.protocols as string[];
      }
      if (agentData.endpoints) {
        profile.endpoints = typeof agentData.endpoints === 'string' ? JSON.parse(agentData.endpoints) : agentData.endpoints as AgentProfileInput['endpoints'];
      }
      if (agentData.capabilities) {
        profile.capabilities = typeof agentData.capabilities === 'string' ? JSON.parse(agentData.capabilities) : agentData.capabilities as AgentProfileInput['capabilities'];
      }
    }
  }

  const sessionEntries = cmm[PARENT_KEYS.session];
  if (sessionEntries?.length) {
    const sessionData = parseOuterDD(sessionEntries[sessionEntries.length - 1], 'session');
    if (sessionData) {
      // New consolidated format: single params JSON object
      if (sessionData.params) {
        const params = typeof sessionData.params === 'string'
          ? JSON.parse(sessionData.params) : sessionData.params;
        Object.assign(session, params);
      }
      // Legacy fallback: individual keys (for reading old on-chain data)
      if (sessionData.duration != null) session.duration = Number(sessionData.duration);
      if (sessionData.tokenLimit != null) session.tokenLimit = Number(sessionData.tokenLimit);
      if (sessionData.imageLimit != null) session.imageLimit = Number(sessionData.imageLimit);
      if (sessionData.messageLimit != null) session.messageLimit = Number(sessionData.messageLimit);
      if (sessionData.maxFileSize != null) session.maxFileSize = Number(sessionData.maxFileSize);
      if (sessionData.allowedFileTypes) {
        session.allowedFileTypes = typeof sessionData.allowedFileTypes === 'string'
          ? JSON.parse(sessionData.allowedFileTypes) : sessionData.allowedFileTypes as string[];
      }
    }
  }

  const platformEntries = cmm[PARENT_KEYS.platform];
  if (platformEntries?.length) {
    const platformData = parseOuterDD(platformEntries[platformEntries.length - 1], 'platform');
    if (platformData) {
      if (platformData.datapolicy) profile.datapolicy = platformData.datapolicy as string;
      if (platformData.trustlevel) profile.trustlevel = platformData.trustlevel as string;
      if (platformData.disputeresolution) profile.disputeresolution = platformData.disputeresolution as string;
    }
  }

  const serviceEntries = cmm[PARENT_KEYS.service];
  if (serviceEntries?.length) {
    for (const entry of serviceEntries) {
      const svcData = parseOuterDD(entry, 'service');
      if (svcData && svcData.name) {
        // Extract price/currency from pricing array (new format) or legacy fields
        let price: number | undefined;
        let currency: string | undefined;
        let acceptedCurrencies: Array<{ currency: string; price: number }> | undefined;

        if (svcData.pricing) {
          const pricingArr: Array<{ currency: string; price: number }> =
            typeof svcData.pricing === 'string'
              ? JSON.parse(svcData.pricing)
              : svcData.pricing as Array<{ currency: string; price: number }>;
          if (pricingArr.length > 0) {
            price = pricingArr[0].price;
            currency = pricingArr[0].currency;
          }
          if (pricingArr.length > 1) {
            acceptedCurrencies = pricingArr.slice(1);
          }
        } else {
          // Legacy fallback: separate price/currency fields
          price = svcData.price != null ? Number(svcData.price) : undefined;
          currency = svcData.currency as string | undefined;
        }

        const svcInput: ServiceInput = {
          name: svcData.name as string,
          description: svcData.description as string | undefined,
          category: svcData.category as string | undefined,
          price,
          currency,
          turnaround: svcData.turnaround as string | undefined,
          paymentTerms: svcData.paymentTerms as 'prepay' | 'postpay' | undefined,
          privateMode: svcData.privateMode != null ? svcData.privateMode === 'true' || svcData.privateMode === true : undefined,
          sovguard: svcData.sovguard != null ? svcData.sovguard === 'true' || svcData.sovguard === true : undefined,
        };
        if (acceptedCurrencies) {
          svcInput.acceptedCurrencies = acceptedCurrencies;
        }
        services.push(svcInput);
      }
    }
  }

  if (Object.keys(session).length > 0) {
    profile.session = session as AgentProfileInput['session'];
  }

  return {
    profile: profile as AgentProfileInput,
    services,
  };
}

// --- Canonical update helpers ---

export interface CanonicalAgentUpdateParams {
  fullName?: string;
  parent?: string;
  primaryaddresses: string[];
  minimumsignatures?: number;
  vdxfKeys: Record<string, string>;
  fields?: Record<string, unknown>;
}

export interface CanonicalIdentitySnapshot {
  name?: string;
  parent?: string;
  contentmultimap?: Record<string, unknown[]>;
}

export function buildCanonicalAgentUpdate(params: CanonicalAgentUpdateParams): Record<string, unknown> {
  const {
    fullName,
    parent,
    primaryaddresses,
    minimumsignatures = 1,
    fields = {},
  } = params;

  const clean = (fullName || '').replace(/@$/, '');
  const inferredName = clean ? clean.split('.')[0] : '';
  const inferredParent = clean.includes('.') ? clean.split('.').slice(1).join('.') : parent;

  if (!inferredName) throw new Error('Missing subID name');
  if (!inferredParent) throw new Error('Missing parent');
  if (!Array.isArray(primaryaddresses) || primaryaddresses.length === 0) {
    throw new Error('primaryaddresses required');
  }

  // Build nested DD contentmultimap from fields
  const agentSubDDs: object[] = [];
  const K = VDXF_KEYS.agent;

  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const iAddr = (K as Record<string, string>)[field];
    if (!iAddr) continue;

    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    agentSubDDs.push(makeSubDD(iAddr, strValue));
  }

  const contentmultimap: Record<string, unknown[]> = {};
  if (agentSubDDs.length > 0) {
    contentmultimap[PARENT_KEYS.agent] = [makeOuterDD(agentSubDDs, PARENT_KEYS.agent)];
  }

  return {
    name: inferredName,
    parent: inferredParent,
    primaryaddresses,
    minimumsignatures,
    contentmultimap,
  };
}

export function verifyPublishedIdentity(params: {
  identity: CanonicalIdentitySnapshot;
  expectedPayload: Record<string, unknown>;
}): { ok: boolean; errors: string[] } {
  const { identity, expectedPayload } = params;
  const errors: string[] = [];

  if (identity.name !== expectedPayload.name) errors.push('name mismatch');
  if (identity.parent !== expectedPayload.parent) errors.push('parent mismatch');

  const expectedCmm = (expectedPayload.contentmultimap || {}) as Record<string, unknown[]>;
  const onchain = identity.contentmultimap || {};

  // For nested DD format, verify parent keys are present and have entries
  for (const key of Object.keys(expectedCmm)) {
    if (!onchain[key] || (onchain[key] as unknown[]).length === 0) {
      errors.push(`missing key ${key}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildUpdateIdentityPayload(
  identityName: string,
  contentmultimap: Record<string, unknown[]>,
): Record<string, unknown> {
  const clean = identityName.replace(/@$/, '');
  const parts = clean.split('.');
  const name = parts[0] || clean;
  const parent = parts.length > 1 ? parts.slice(1).join('.') : 'agentplatform';

  return {
    name,
    parent,
    contentmultimap,
  };
}

export function buildUpdateIdentityCommand(payload: Record<string, unknown>, chain: 'verustest' | 'verus' = 'verustest'): string[] {
  const args = ['verus'];
  if (chain === 'verustest') args.push('-chain=vrsctest');
  args.push('updateidentity', JSON.stringify(payload));
  return args;
}
