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
  DisputePolicy,
} from './finalize.js';

// --- Constants ---

export const DATA_DESCRIPTOR_KEY = 'i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv';

/**
 * @deprecated Parent group keys removed in 25-key flat format (2026-03-28).
 * Kept ONLY for backwards-compatible reading of old on-chain data.
 * Do NOT use for new writes — use flat VDXF_KEYS directly.
 */
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

/**
 * 25 flat VDXF keys — each is its own top-level contentmultimap entry.
 * No parent group wrapping. Values wrapped via makeSubDD().
 */
export const VDXF_KEYS = {
  // 15 agent keys
  agent: {
    displayName:          'iKkdwxhdupLgf7v2qn4JGBQHntsBb17kjW',  // agentplatform::agent.displayname
    type:                 'iNxeLSDFARVQezfEt4i8CBZjTSRpFTPAyP',  // agentplatform::agent.type
    description:          'iQr3yKEn2DXaG4GQGVAVYivC3jwcvScfzk',  // agentplatform::agent.description
    status:               'iLy373iaKafmRCY43ahty4m8aLQx32y8Fh',  // agentplatform::agent.status
    payAddress:           'iRxxUvbDXJT5wVpnx7oc9nkYALCoDh6aTD',  // agentplatform::agent.payaddress
    services:             'i8Wk7fcbsBWtcf965Z3WvDUjahF1aTH1tu',  // agentplatform::agent.services
    models:               'iQJUQmdFSmM49cvLJfKLZnuRYsjXSmTTHY',  // agentplatform::agent.models
    markup:               'iBLx3rga8DewiN6gyQyC5avFin8fnnojnS',  // agentplatform::agent.markup
    networkCapabilities:  'iF7174LxgcAnu3qZ7iJzSyJYthDJXBzQNw',  // agentplatform::agent.network.capabilities
    networkEndpoints:     'i5VzGsiFmJYuRr7b8aUyHzAS8vd9DC4puS',  // agentplatform::agent.network.endpoints
    networkProtocols:     'iSAVTXMb9TyWWuDDnWopFhgZpjm21WPigv',  // agentplatform::agent.network.protocols
    profileTags:          'iKM57qfzmgM1sxBgR3XBQa2XCRURZ2YVo2',  // agentplatform::agent.profile.tags
    profileWebsite:       'i7HY93tqfqCkpyKYiNtcDbioAgF8gRL9TQ',  // agentplatform::agent.profile.website
    profileAvatar:        'iALo91Z75iXZxMvymvQMRwo7GAeHv5veKc',  // agentplatform::agent.profile.avatar
    profileCategory:      'iD3quozCGbzJyZ29uvRCeecr12np2dMsvN',  // agentplatform::agent.profile.category
    disputePolicy:        'iFxerhcrMr2e5eWyvHiXuWHXj2dnhEZF8p',  // agentplatform::agent.disputepolicy (was svc.dispute)
  },
  // 1 service schema key (on agentplatform@ only — agents don't write these)
  service: {
    schema:  'i4D2ifpAG7BYnfJZGVT1Tph7BMkp9qZPyS',  // agentplatform::svc.schema
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

// Legacy agent keys removed in 25-key migration (for backwards-compat decoding)
const LEGACY_AGENT_KEYS: Record<string, string> = {
  'iEEqjQsh5YDrwMyxyTrHFrMHTqrsPziCqu': 'owner',   // agent.owner — REMOVED
  'iJ15GBkMfyMxvEf7wivLKbXRjpqS119QrM': 'network',  // agent.network — REMOVED (split into 3)
  'iAFyowB5a3W5BLEv6tE7EPHAmGhaYcGJCt': 'profile',  // agent.profile — REMOVED (split into 4)
};

// --- Reverse lookups ---

const REVERSE_LOOKUPS: Record<string, Record<string, string>> = {};
for (const [group, keys] of Object.entries(VDXF_KEYS)) {
  REVERSE_LOOKUPS[group] = Object.fromEntries(
    Object.entries(keys).map(([k, v]) => [v, k])
  );
}

// Build legacy agent reverse lookup (current keys + removed keys)
const LEGACY_AGENT_REVERSE: Record<string, string> = {
  ...REVERSE_LOOKUPS['agent'],
  ...LEGACY_AGENT_KEYS,
};

// Global flat reverse: i-address → field name (across all groups)
const ALL_KEYS_FLAT: Record<string, string> = {};
for (const [, keys] of Object.entries(VDXF_KEYS)) {
  for (const [field, iAddr] of Object.entries(keys)) {
    ALL_KEYS_FLAT[iAddr] = field;
  }
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
 * Parse an outer DD (legacy nested pattern — objectdata is an array of sub-DDs).
 * Returns a map of resolved field names -> values.
 */
function parseOuterDD(entry: unknown, reverseLookup: Record<string, string>): Record<string, unknown> | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const dd = (entry as Record<string, unknown>)[DATA_DESCRIPTOR_KEY] as Record<string, unknown> | undefined;
  if (!dd) return null;
  if (!Array.isArray(dd.objectdata)) return null;

  const record: Record<string, unknown> = {};
  for (const subEntry of dd.objectdata) {
    const sub = parseSubDD(subEntry);
    if (!sub || !sub.label) continue;
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
  } catch (e) {
    console.warn(`[VDXF] decodeVdxfValue: JSON parse failed, returning raw string. Error: ${(e as Error).message}`);
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
    if (svc.costBreakdown) obj.costBreakdown = svc.costBreakdown;
    return obj;
  });
}

// --- Build flat contentmultimap (25-key format) ---

/**
 * Build a flat contentmultimap for an agent profile + services.
 * Each field is its own top-level key wrapped in makeSubDD().
 *
 * Network fields → 3 separate keys (capabilities, endpoints, protocols).
 * Profile fields → 4 separate keys (tags, website, avatar, category).
 * No parent key wrapping.
 */
export function buildAgentContentMultimap(
  profile?: AgentProfileInput,
  services: ServiceInput[] = [],
  disputePolicy?: DisputePolicy,
): Record<string, unknown[]> {
  const cmm: Record<string, unknown[]> = {};
  const K = VDXF_KEYS.agent;

  if (profile) {
    // Core agent fields
    cmm[K.displayName] = [makeSubDD(K.displayName, profile.name)];
    cmm[K.type] = [makeSubDD(K.type, profile.type)];
    cmm[K.description] = [makeSubDD(K.description, profile.description)];
    cmm[K.status] = [makeSubDD(K.status, 'active')];

    if (profile.payAddress) {
      cmm[K.payAddress] = [makeSubDD(K.payAddress, profile.payAddress)];
    }

    // Services as JSON array
    if (services.length > 0) {
      cmm[K.services] = [makeSubDD(K.services, JSON.stringify(serializeServiceArray(services)))];
    }

    // Network fields → 3 individual flat keys
    if (profile.network) {
      if (profile.network.capabilities?.length) {
        cmm[K.networkCapabilities] = [makeSubDD(K.networkCapabilities, JSON.stringify(profile.network.capabilities))];
      }
      if (profile.network.endpoints?.length) {
        cmm[K.networkEndpoints] = [makeSubDD(K.networkEndpoints, JSON.stringify(profile.network.endpoints))];
      }
      if (profile.network.protocols?.length) {
        cmm[K.networkProtocols] = [makeSubDD(K.networkProtocols, JSON.stringify(profile.network.protocols))];
      }
    }

    // Profile fields → 4 individual flat keys
    if (profile.profile) {
      if (profile.profile.tags?.length) {
        cmm[K.profileTags] = [makeSubDD(K.profileTags, JSON.stringify(profile.profile.tags))];
      }
      if (profile.profile.website) {
        cmm[K.profileWebsite] = [makeSubDD(K.profileWebsite, profile.profile.website)];
      }
      if (profile.profile.avatar) {
        cmm[K.profileAvatar] = [makeSubDD(K.profileAvatar, profile.profile.avatar)];
      }
      if (profile.profile.category) {
        cmm[K.profileCategory] = [makeSubDD(K.profileCategory, profile.profile.category)];
      }
    }

    // LLM models → agent.models (JSON array)
    if (profile.models?.length) {
      cmm[K.models] = [makeSubDD(K.models, JSON.stringify(profile.models))];
    }

    // Pricing markup → agent.markup
    if (profile.markup != null && profile.markup >= 1 && profile.markup <= 50) {
      cmm[K.markup] = [makeSubDD(K.markup, String(profile.markup))];
    }

    // Session params → session.params (JSON object)
    if (profile.session && Object.keys(profile.session).length > 0) {
      cmm[VDXF_KEYS.session.params] = [makeSubDD(VDXF_KEYS.session.params, JSON.stringify(profile.session))];
    }

    // Platform config → platform.config (JSON object)
    if (profile.platformConfig && Object.keys(profile.platformConfig).length > 0) {
      cmm[VDXF_KEYS.platform.config] = [makeSubDD(VDXF_KEYS.platform.config, JSON.stringify(profile.platformConfig))];
    }

    // Workspace capability → workspace.capability (JSON object)
    if (profile.workspaceCapability) {
      cmm[VDXF_KEYS.workspace.capability] = [makeSubDD(VDXF_KEYS.workspace.capability, JSON.stringify(profile.workspaceCapability))];
    }

    // Dispute policy → agent.disputePolicy (JSON object)
    if (disputePolicy) {
      cmm[K.disputePolicy] = [makeSubDD(K.disputePolicy, JSON.stringify(disputePolicy))];
    }
  } else if (services.length > 0) {
    // Services-only (no profile)
    cmm[K.services] = [makeSubDD(K.services, JSON.stringify(serializeServiceArray(services)))];
  }

  return cmm;
}

// --- Decode contentmultimap (supports both flat + legacy formats) ---

/**
 * Detect whether a contentmultimap uses the legacy parent-keyed format.
 * Only triggers if the agent parent key is present (the main profile container).
 * Stray legacy keys (e.g. review parent from pre-migration) don't trigger legacy mode.
 */
function isLegacyFormat(cmm: Record<string, unknown[]>): boolean {
  return !!cmm[PARENT_KEYS.agent];
}

/**
 * Decode a flat-format contentmultimap entry: parse the sub-DD value.
 */
function parseFlatEntry(entries: unknown[]): unknown {
  if (!entries?.length) return null;
  // Take the LAST entry (updateidentity appends, latest wins)
  const sub = parseSubDD(entries[entries.length - 1]);
  return sub?.value ?? null;
}

/**
 * Try to parse a string value as JSON, return original if not JSON.
 */
function tryParseJson(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

/**
 * Decode services from a JSON array value.
 */
function decodeServicesArray(raw: unknown): ServiceInput[] {
  const svcArr: Record<string, unknown>[] = typeof raw === 'string'
    ? JSON.parse(raw) : raw as Record<string, unknown>[];
  const services: ServiceInput[] = [];

  for (const svc of svcArr) {
    if (!svc.name) continue;
    let price: number | undefined;
    let currency: string | undefined;
    let acceptedCurrencies: Array<{ currency: string; price: number }> | undefined;

    if (svc.pricing && Array.isArray(svc.pricing)) {
      const pricingArr = svc.pricing as Array<Record<string, unknown>>;
      if (pricingArr.length > 0) {
        price = Number(pricingArr[0].amount ?? pricingArr[0].price);
        currency = pricingArr[0].currency as string;
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
    if (svc.costBreakdown) {
      svcInput.costBreakdown = typeof svc.costBreakdown === 'string'
        ? JSON.parse(svc.costBreakdown as string)
        : svc.costBreakdown as ServiceInput['costBreakdown'];
    }
    services.push(svcInput);
  }
  return services;
}

/**
 * Decode a contentmultimap back into AgentProfileInput + services.
 * Supports BOTH the new 25-key flat format and the legacy parent-keyed format.
 */
export function decodeContentMultimap(cmm: Record<string, unknown[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
  disputePolicy?: DisputePolicy;
} {
  if (isLegacyFormat(cmm)) {
    return decodeLegacyContentMultimap(cmm);
  }
  return decodeFlatContentMultimap(cmm);
}

/**
 * Decode new 25-key flat format.
 */
function decodeFlatContentMultimap(cmm: Record<string, unknown[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
  disputePolicy?: DisputePolicy;
} {
  const profile: Partial<AgentProfileInput> = {};
  const services: ServiceInput[] = [];
  const K = VDXF_KEYS.agent;

  // Core agent fields
  const name = parseFlatEntry(cmm[K.displayName]);
  if (name) profile.name = name as string;
  const type = parseFlatEntry(cmm[K.type]);
  if (type) profile.type = type as AgentProfileInput['type'];
  const desc = parseFlatEntry(cmm[K.description]);
  if (desc) profile.description = desc as string;
  const payAddr = parseFlatEntry(cmm[K.payAddress]);
  if (payAddr) profile.payAddress = payAddr as string;

  // Services
  const svcRaw = parseFlatEntry(cmm[K.services]);
  if (svcRaw) {
    services.push(...decodeServicesArray(svcRaw));
  }

  // Network (3 individual keys → NetworkInput)
  const network: NetworkInput = {};
  const caps = parseFlatEntry(cmm[K.networkCapabilities]);
  if (caps) network.capabilities = tryParseJson(caps) as string[];
  const eps = parseFlatEntry(cmm[K.networkEndpoints]);
  if (eps) network.endpoints = tryParseJson(eps) as string[];
  const protos = parseFlatEntry(cmm[K.networkProtocols]);
  if (protos) network.protocols = tryParseJson(protos) as string[];
  if (Object.keys(network).length > 0) profile.network = network;

  // Profile (4 individual keys → ProfileInput)
  const profileBlob: ProfileInput = {};
  const tags = parseFlatEntry(cmm[K.profileTags]);
  if (tags) profileBlob.tags = tryParseJson(tags) as string[];
  const website = parseFlatEntry(cmm[K.profileWebsite]);
  if (website) profileBlob.website = website as string;
  const avatar = parseFlatEntry(cmm[K.profileAvatar]);
  if (avatar) profileBlob.avatar = avatar as string;
  const category = parseFlatEntry(cmm[K.profileCategory]);
  if (category) profileBlob.category = category as string;
  if (Object.keys(profileBlob).length > 0) profile.profile = profileBlob;

  // Models
  const models = parseFlatEntry(cmm[K.models]);
  if (models) {
    const parsed = tryParseJson(models);
    if (Array.isArray(parsed)) profile.models = parsed as string[];
  }

  // Markup
  const markup = parseFlatEntry(cmm[K.markup]);
  if (markup != null) profile.markup = Number(markup);

  // Dispute policy
  const disputeRaw = parseFlatEntry(cmm[K.disputePolicy]);
  let disputePolicy: DisputePolicy | undefined;
  if (disputeRaw) {
    disputePolicy = tryParseJson(disputeRaw) as DisputePolicy;
  }

  // Session params
  const sessionRaw = parseFlatEntry(cmm[VDXF_KEYS.session.params]);
  if (sessionRaw) {
    const parsed = tryParseJson(sessionRaw);
    if (typeof parsed === 'object' && parsed !== null) {
      profile.session = parsed as AgentProfileInput['session'];
    }
  }

  // Platform config
  const platformRaw = parseFlatEntry(cmm[VDXF_KEYS.platform.config]);
  if (platformRaw) {
    const parsed = tryParseJson(platformRaw);
    if (typeof parsed === 'object' && parsed !== null) {
      profile.platformConfig = parsed as PlatformConfigInput;
    }
  }

  // Workspace capability
  const wsRaw = parseFlatEntry(cmm[VDXF_KEYS.workspace.capability]);
  if (wsRaw) {
    const parsed = tryParseJson(wsRaw);
    if (typeof parsed === 'object' && parsed !== null) {
      profile.workspaceCapability = parsed as WorkspaceCapabilityInput;
    }
  }

  return { profile: profile as AgentProfileInput, services, disputePolicy };
}

/**
 * Decode legacy parent-keyed contentmultimap (pre-migration on-chain data).
 */
function decodeLegacyContentMultimap(cmm: Record<string, unknown[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
  disputePolicy?: DisputePolicy;
} {
  const profile: Partial<AgentProfileInput> = {};
  const session: Partial<NonNullable<AgentProfileInput['session']>> = {};
  const services: ServiceInput[] = [];

  // --- Agent data (legacy parent key) ---
  const agentEntries = cmm[PARENT_KEYS.agent];
  if (agentEntries?.length) {
    const agentData = parseOuterDD(agentEntries[agentEntries.length - 1], LEGACY_AGENT_REVERSE);
    if (agentData) {
      if (agentData.displayName) profile.name = agentData.displayName as string;
      if (agentData.type) profile.type = agentData.type as AgentProfileInput['type'];
      if (agentData.description) profile.description = agentData.description as string;
      // agent.owner mapped to payAddress for migration
      if (agentData.owner) profile.payAddress = agentData.owner as string;

      // Decode legacy consolidated network blob
      if (agentData.network) {
        const net = typeof agentData.network === 'string'
          ? JSON.parse(agentData.network) : agentData.network;
        profile.network = net as NetworkInput;
      }

      // Decode legacy consolidated profile blob
      if (agentData.profile) {
        const prof = typeof agentData.profile === 'string'
          ? JSON.parse(agentData.profile) : agentData.profile;
        profile.profile = prof as ProfileInput;
      }

      // Decode services JSON array
      if (agentData.services) {
        services.push(...decodeServicesArray(agentData.services));
      }

      // Models
      if (agentData.models) {
        const models = typeof agentData.models === 'string'
          ? JSON.parse(agentData.models) : agentData.models;
        if (Array.isArray(models)) profile.models = models as string[];
      }

      // Markup
      if (agentData.markup != null) {
        profile.markup = Number(agentData.markup);
      }
    }
  }

  // --- Session data (legacy parent key) ---
  const sessionEntries = cmm[PARENT_KEYS.session];
  if (sessionEntries?.length) {
    const sessionData = parseOuterDD(sessionEntries[sessionEntries.length - 1], getReverseLookup('session'));
    if (sessionData) {
      if (sessionData.params) {
        const params = typeof sessionData.params === 'string'
          ? JSON.parse(sessionData.params) : sessionData.params;
        Object.assign(session, params);
      }
      // Legacy individual session keys fallback
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

  // --- Platform data (legacy parent key) ---
  const platformEntries = cmm[PARENT_KEYS.platform];
  if (platformEntries?.length) {
    const platformData = parseOuterDD(platformEntries[platformEntries.length - 1], getReverseLookup('platform'));
    if (platformData?.config) {
      const cfg = typeof platformData.config === 'string'
        ? JSON.parse(platformData.config) : platformData.config;
      profile.platformConfig = cfg as PlatformConfigInput;
    }
  }

  // --- Workspace capability (legacy parent key) ---
  const workspaceEntries = cmm[PARENT_KEYS.workspace];
  if (workspaceEntries?.length) {
    const wsData = parseOuterDD(workspaceEntries[workspaceEntries.length - 1], getReverseLookup('workspace'));
    if (wsData?.capability) {
      const cap = typeof wsData.capability === 'string'
        ? JSON.parse(wsData.capability) : wsData.capability;
      profile.workspaceCapability = cap as WorkspaceCapabilityInput;
    }
  }

  if (Object.keys(session).length > 0) {
    profile.session = session as AgentProfileInput['session'];
  }

  return { profile: profile as AgentProfileInput, services, disputePolicy: undefined };
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

/**
 * Build a flat contentmultimap from field-name -> value pairs.
 * Each field is mapped to its VDXF_KEYS.agent i-address.
 */
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

  // Build flat contentmultimap from fields
  const contentmultimap: Record<string, unknown[]> = {};
  const K = VDXF_KEYS.agent;

  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const iAddr = (K as Record<string, string>)[field];
    if (!iAddr) continue;

    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    contentmultimap[iAddr] = [makeSubDD(iAddr, strValue)];
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
 * Build flat contentmultimap additions for job completion (read-merge-write pattern).
 * Each record is its own top-level key.
 */
export function buildJobCompletionAdditions(params: {
  jobRecord: JobRecordInput;
  reviewRecord?: ReviewRecordInput;
  workspaceAttestation?: WorkspaceAttestationInput;
}): Record<string, unknown[]> {
  const additions: Record<string, unknown[]> = {};

  additions[VDXF_KEYS.job.record] = [makeSubDD(VDXF_KEYS.job.record, JSON.stringify(params.jobRecord))];

  if (params.reviewRecord) {
    additions[VDXF_KEYS.review.record] = [makeSubDD(VDXF_KEYS.review.record, JSON.stringify(params.reviewRecord))];
  }

  if (params.workspaceAttestation) {
    additions[VDXF_KEYS.workspace.attestation] = [makeSubDD(VDXF_KEYS.workspace.attestation, JSON.stringify(params.workspaceAttestation))];
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
