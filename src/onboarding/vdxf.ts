import type {
  AgentProfileInput,
  ServiceInput,
  SessionInput,
  NetworkInput,
  ProfileInput,
  PlatformConfigInput,
  WorkspaceCapabilityInput,
  JobRecordInput,
  ReviewRecordInput,
  WorkspaceAttestationInput,
} from './finalize.js';

// --- Constants ---

export const DATA_DESCRIPTOR_KEY = 'i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv';

export const PARENT_KEYS = {
  agent:     'i8XMutgp1MRNoFoHQuzZ4ReowJd9NvCgDP', // agentplatform::agent
  service:   'i8pfR86vr8qbTPHbhmNQFJo8MYSWKv2TZD', // agentplatform::svc
  review:    'iMTQf3r1icnRfKLNtr5eByLKXZfsSzUt5f', // agentplatform::review
  session:   'iGxK7ke8RptD2mkhmUgjMASFysopezAT4n', // agentplatform::session
  platform:  'iMc951yUdCup5rFgZb8nwDFhkdd8Fktg2a', // agentplatform::platform
  bounty:    'i5L3iHEG4sFm4Lp5HSN1NLLxKQUfFaoU8S', // agentplatform::bounty
  workspace: 'iEibMMaoeMGjoSLSY61wSPB8Qy5rXnXjAk', // agentplatform::workspace
  job:       'iC6GEa5mq15EBatbHiwVtd53QHb8HiEDnT', // agentplatform::job
} as const;

export const VDXF_KEYS = {
  // 8 agent keys
  agent: {
    displayName: 'iKkdwxhdupLgf7v2qn4JGBQHntsBb17kjW',  // agentplatform::agent.displayname
    type:        'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP',  // agentplatform::agent.type
    description: 'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk',  // agentplatform::agent.description
    status:      'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh',  // agentplatform::agent.status
    owner:       'iEEqjQsh5YDrwMyxyTrHFrMHTqrsPziCqu',  // agentplatform::agent.owner
    services:    'i8Wk7fcbsBWtcf965Z3WvDUjahF1aTH1tu',  // agentplatform::agent.services
    network:     'iJ15GBkMfyMxvEf7wivLKbXRjpqS119QrM',  // agentplatform::agent.network
    profile:     'iAFyowB5a3W5BLEv6tE7EPHAmGhaYcGJCt',  // agentplatform::agent.profile
  },
  // 2 service schema keys (on agentplatform@ only — agents don't write these)
  service: {
    schema:  'i4D2ifpAG7BYnfJZGVT1Tph7BMkp9qZPyS',  // agentplatform::svc.schema
    dispute: 'iFxerhcrMr2e5eWyvHiXuWHXj2dnhEZF8p',   // agentplatform::svc.dispute
  },
  // 1 review key
  review: {
    record: 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad',   // agentplatform::review.record
  },
  // 2 bounty keys (schema only)
  bounty: {
    record:      'i6PC1B9vgVf8bLtHcdsNunLtr6ibtnL7ZC',  // agentplatform::bounty.record
    application: 'iE8Z7gZmAs4NU8AqEJzV9MWHUCoUBQqfum',  // agentplatform::bounty.application
  },
  // 1 platform key (on agentplatform@ only)
  platform: {
    config: 'iMs3n1aCWQh5rmkXCNLRi8WqbzZrq3F7Ye',    // agentplatform::platform.config
  },
  // 1 session key
  session: {
    params: 'iHjLTt9P8Jb1uCYSpVpwXFbwzbPYWW4n8p',    // agentplatform::session.params
  },
  // 2 workspace keys
  workspace: {
    attestation: 'i8xp9AgvueoAHyYXbxNACMgRQfEXF82V5D',  // agentplatform::workspace.attestation
    capability:  'iMxAXRfTWUkKBmLGEZtEJbKj58kDi1GjZ9',  // agentplatform::workspace.capability
  },
  // 1 job key
  job: {
    record: 'iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn',     // agentplatform::job.record
  },
} as const;

// --- Reverse lookups ---

const REVERSE_LOOKUPS: Record<string, Record<string, string>> = {};
for (const [group, keys] of Object.entries(VDXF_KEYS)) {
  REVERSE_LOOKUPS[group] = Object.fromEntries(
    Object.entries(keys).map(([k, v]) => [v, k])
  );
}

function getReverseLookup(type: string): Record<string, string> {
  return REVERSE_LOOKUPS[type] || {};
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

// --- Service serialization helper (DRY) ---

function serializeServiceArray(services: ServiceInput[]): Record<string, unknown>[] {
  return services.map(svc => {
    const obj: Record<string, unknown> = { name: svc.name, status: svc.status || 'active' };
    if (svc.description) obj.description = svc.description;
    if (svc.category) obj.category = svc.category;
    const pricing: Array<{ currency: string; amount: string }> = [];
    if (svc.price != null && svc.currency) {
      pricing.push({ currency: svc.currency, amount: String(svc.price) });
    }
    if (svc.acceptedCurrencies?.length) {
      for (const ac of svc.acceptedCurrencies) {
        pricing.push({ currency: ac.currency, amount: String(ac.price) });
      }
    }
    if (pricing.length) obj.pricing = pricing;
    if (svc.turnaround) obj.turnaround = svc.turnaround;
    if (svc.paymentTerms) obj.paymentTerms = svc.paymentTerms;
    if (svc.privateMode != null) obj.privateMode = svc.privateMode;
    if (svc.sovguard != null) obj.sovguard = svc.sovguard;
    if (svc.resolutionWindow != null) obj.resolutionWindow = svc.resolutionWindow;
    if (svc.refundPolicy) obj.refundPolicy = svc.refundPolicy;
    return obj;
  });
}

// --- Build nested DD contentmultimap ---

/**
 * Build a nested DataDescriptor contentmultimap for an agent profile + services.
 * Produces the on-chain format: { parentKeyIAddress: [outerDD] }
 *
 * Agent core fields + services JSON array + network/profile blobs → agent parent key.
 * Session params → session parent key.
 * Platform config → platform parent key (single JSON blob).
 * Workspace capability → workspace parent key.
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

    if (profile.owner) agentSubDDs.push(makeSubDD(K.owner, profile.owner));

    // Services as JSON array under agent.services
    if (services.length > 0) {
      agentSubDDs.push(makeSubDD(K.services, JSON.stringify(serializeServiceArray(services))));
    }

    // Consolidated network blob → agent.network
    if (profile.network && Object.keys(profile.network).length > 0) {
      agentSubDDs.push(makeSubDD(K.network, JSON.stringify(profile.network)));
    }

    // Consolidated profile blob → agent.profile
    if (profile.profile && Object.keys(profile.profile).length > 0) {
      agentSubDDs.push(makeSubDD(K.profile, JSON.stringify(profile.profile)));
    }

    contentmultimap[PARENT_KEYS.agent] = [makeOuterDD(agentSubDDs, PARENT_KEYS.agent)];

    // --- Session data (consolidated into single params JSON object) ---
    if (profile.session && Object.keys(profile.session).length > 0) {
      const sessionSubDDs: object[] = [];
      sessionSubDDs.push(makeSubDD(VDXF_KEYS.session.params, JSON.stringify(profile.session)));

      contentmultimap[PARENT_KEYS.session] = [makeOuterDD(sessionSubDDs, PARENT_KEYS.session)];
    }

    // --- Platform data (single config JSON blob) ---
    if (profile.platformConfig && Object.keys(profile.platformConfig).length > 0) {
      const platformSubDDs: object[] = [];
      platformSubDDs.push(makeSubDD(VDXF_KEYS.platform.config, JSON.stringify(profile.platformConfig)));
      contentmultimap[PARENT_KEYS.platform] = [makeOuterDD(platformSubDDs, PARENT_KEYS.platform)];
    }

    // --- Workspace capability ---
    if (profile.workspaceCapability) {
      const wsSubDDs: object[] = [];
      wsSubDDs.push(makeSubDD(VDXF_KEYS.workspace.capability, JSON.stringify(profile.workspaceCapability)));
      contentmultimap[PARENT_KEYS.workspace] = [makeOuterDD(wsSubDDs, PARENT_KEYS.workspace)];
    }
  } else if (services.length > 0) {
    // Services-only (no profile) — still goes under agent parent
    const agentSubDDs: object[] = [];
    agentSubDDs.push(makeSubDD(VDXF_KEYS.agent.services, JSON.stringify(serializeServiceArray(services))));
    contentmultimap[PARENT_KEYS.agent] = [makeOuterDD(agentSubDDs, PARENT_KEYS.agent)];
  }

  return contentmultimap;
}

// --- Decode nested DD contentmultimap ---

/**
 * Decode a nested DataDescriptor contentmultimap back into an AgentProfileInput + services.
 * Handles the 18-key consolidated format.
 */
export function decodeContentMultimap(cmm: Record<string, unknown[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
} {
  const profile: Partial<AgentProfileInput> = {};
  const session: Partial<NonNullable<AgentProfileInput['session']>> = {};
  const services: ServiceInput[] = [];

  // --- Agent data ---
  const agentEntries = cmm[PARENT_KEYS.agent];
  if (agentEntries?.length) {
    // Take the LAST outer DD (updateidentity appends, latest wins)
    const agentData = parseOuterDD(agentEntries[agentEntries.length - 1], 'agent');
    if (agentData) {
      if (agentData.displayName) profile.name = agentData.displayName as string;
      if (agentData.type) profile.type = agentData.type as AgentProfileInput['type'];
      if (agentData.description) profile.description = agentData.description as string;
      if (agentData.owner) profile.owner = agentData.owner as string;

      // Decode consolidated network blob
      if (agentData.network) {
        const net = typeof agentData.network === 'string'
          ? JSON.parse(agentData.network) : agentData.network;
        profile.network = net as NetworkInput;
      }

      // Decode consolidated profile blob
      if (agentData.profile) {
        const prof = typeof agentData.profile === 'string'
          ? JSON.parse(agentData.profile) : agentData.profile;
        profile.profile = prof as ProfileInput;
      }

      // Decode services JSON array
      if (agentData.services) {
        const svcArr: Record<string, unknown>[] = typeof agentData.services === 'string'
          ? JSON.parse(agentData.services) : agentData.services as Record<string, unknown>[];
        for (const svc of svcArr) {
          if (!svc.name) continue;
          let price: number | undefined;
          let currency: string | undefined;
          let acceptedCurrencies: Array<{ currency: string; price: number }> | undefined;

          if (svc.pricing && Array.isArray(svc.pricing)) {
            const pricingArr = svc.pricing as Array<Record<string, unknown>>;
            if (pricingArr.length > 0) {
              price = Number((pricingArr[0] as Record<string, unknown>).amount ?? (pricingArr[0] as Record<string, unknown>).price);
              currency = (pricingArr[0] as Record<string, unknown>).currency as string;
            }
            if (pricingArr.length > 1) {
              acceptedCurrencies = pricingArr.slice(1).map(p => ({
                currency: p.currency as string,
                price: Number(p.amount ?? p.price),
              }));
            }
          }

          const svcInput: ServiceInput = {
            name: svc.name as string,
            description: svc.description as string | undefined,
            category: svc.category as string | undefined,
            price,
            currency,
            turnaround: svc.turnaround as string | undefined,
            paymentTerms: svc.paymentTerms as ServiceInput['paymentTerms'],
            privateMode: svc.privateMode != null ? svc.privateMode === true || svc.privateMode === 'true' : undefined,
            sovguard: svc.sovguard != null ? svc.sovguard === true || svc.sovguard === 'true' : undefined,
            status: svc.status as string | undefined,
          };
          if (acceptedCurrencies) svcInput.acceptedCurrencies = acceptedCurrencies;
          if (svc.resolutionWindow != null) svcInput.resolutionWindow = Number(svc.resolutionWindow);
          if (svc.refundPolicy) {
            svcInput.refundPolicy = typeof svc.refundPolicy === 'string'
              ? JSON.parse(svc.refundPolicy as string)
              : svc.refundPolicy as ServiceInput['refundPolicy'];
          }
          services.push(svcInput);
        }
      }
    }
  }

  // --- Session data ---
  const sessionEntries = cmm[PARENT_KEYS.session];
  if (sessionEntries?.length) {
    const sessionData = parseOuterDD(sessionEntries[sessionEntries.length - 1], 'session');
    if (sessionData) {
      // Consolidated format: single params JSON object
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

  // --- Platform data (single config JSON blob) ---
  const platformEntries = cmm[PARENT_KEYS.platform];
  if (platformEntries?.length) {
    const platformData = parseOuterDD(platformEntries[platformEntries.length - 1], 'platform');
    if (platformData) {
      if (platformData.config) {
        const cfg = typeof platformData.config === 'string'
          ? JSON.parse(platformData.config) : platformData.config;
        profile.platformConfig = cfg as PlatformConfigInput;
      }
    }
  }

  // --- Workspace capability ---
  const workspaceEntries = cmm[PARENT_KEYS.workspace];
  if (workspaceEntries?.length) {
    const wsData = parseOuterDD(workspaceEntries[workspaceEntries.length - 1], 'workspace');
    if (wsData?.capability) {
      const cap = typeof wsData.capability === 'string'
        ? JSON.parse(wsData.capability) : wsData.capability;
      profile.workspaceCapability = cap as WorkspaceCapabilityInput;
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

// --- Job completion helpers ---

/**
 * Build contentmultimap additions for job completion (read-merge-write pattern).
 * Creates outer DDs for job record, optional review record, and optional workspace attestation.
 */
export function buildJobCompletionAdditions(params: {
  jobRecord: JobRecordInput;
  reviewRecord?: ReviewRecordInput;
  workspaceAttestation?: WorkspaceAttestationInput;
}): Record<string, unknown[]> {
  const additions: Record<string, unknown[]> = {};

  const jobSubDDs = [makeSubDD(VDXF_KEYS.job.record, JSON.stringify(params.jobRecord))];
  additions[PARENT_KEYS.job] = [makeOuterDD(jobSubDDs, PARENT_KEYS.job)];

  if (params.reviewRecord) {
    const reviewSubDDs = [makeSubDD(VDXF_KEYS.review.record, JSON.stringify(params.reviewRecord))];
    additions[PARENT_KEYS.review] = [makeOuterDD(reviewSubDDs, PARENT_KEYS.review)];
  }

  if (params.workspaceAttestation) {
    const wsSubDDs = [makeSubDD(VDXF_KEYS.workspace.attestation, JSON.stringify(params.workspaceAttestation))];
    additions[PARENT_KEYS.workspace] = [makeOuterDD(wsSubDDs, PARENT_KEYS.workspace)];
  }

  return additions;
}

/**
 * Merge two contentmultimaps. Values from `additions` are appended to `existing`.
 */
export function mergeContentMultimap(
  existing: Record<string, unknown[]>,
  additions: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};

  for (const [key, values] of Object.entries(existing)) {
    merged[key] = Array.isArray(values) ? [...values] : [values];
  }

  for (const [key, values] of Object.entries(additions)) {
    if (merged[key]) {
      merged[key] = [...merged[key], ...values];
    } else {
      merged[key] = [...values];
    }
  }

  return merged;
}
