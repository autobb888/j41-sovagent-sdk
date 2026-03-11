import type { AgentProfileInput, ServiceInput } from './finalize.js';

export const VDXF_KEYS = {
  agent: {
    version: 'iBShCc1dESnTq25WkxzrKGjHvHwZFSoq6b',
    type: 'i9YN6ovGcotCnFdNyUtNh72Nw11WcBuD8y',
    name: 'i3oa8uNjgZjmC1RS8rg1od8czBP8bsh5A8',
    description: 'i9Ww2jR4sFt7nzdc5vRy5MHUCjTWULXCqH',
    status: 'iNCvffXEYWNBt1K5izxKFSFKBR5LPAAfxW',
    capabilities: 'i7Aumh6Akeq7SC8VJBzpmJrqKNCvREAWMA',
    endpoints: 'i9n5Vu8fjXLP5CxzcdpwHbSzaW22dJxvHc',
    protocols: 'iFQzXU4V6am1M9q6LGBfR4uyNAtjhJiW2d',
    owner: 'i5uUotnF2LzPci3mkz9QaozBtFjeFtAw45',
    services: 'iGVUNBQSNeGzdwjA4km5z6R9h7T2jao9Lz',
    tags: 'iJ3Vh2auC5VRbTKtjvKr9tWg515xAHKzN7',
    website: 'iMGHWAQgGM4VSDfsRTHwBipbwMemt9WdP8',
    avatar: 'iR5a34uDHJLquQgvffXWZ7pSU8spiFEgzh',
    category: 'iGzkSnpGYjTy3eG2FakUDQrXgFMGyCvTGi',
  },
  service: {
    name: 'iNTrSV1bqDAoaGRcpR51BeoS5wQvQ4P9Qj',
    description: 'i7ZUWAqwLu9b4E8oXZq4uX6X5W6BJnkuHz',
    price: 'iLjLxTk1bkEd7SAAWT27VQ7ECFuLtTnuKv',
    currency: 'iANfkUFM797eunQt4nFV3j7SvK8pUkfsJe',
    category: 'iGiUqVQcdLC3UAj8mHtSyWNsAKdEVXUFVC',
    turnaround: 'iNGq3xh28oV2U3VmMtQ3gjMX8jrH1ohKfp',
    status: 'iNbPugdyVSCv54zsZs68vAfvifcf14btX2',
  },
  review: {
    buyer: 'iPbx6NP7ZVLySKJU5Rfbt3saxNLaxHHV85',
    jobHash: 'iFgEMF3Fbj1EFU7bAPjmrvMKUU9QfZumNP',
    message: 'iKokqh2YmULa4HkSWRRJaywNMvGzRv7JTt',
    rating: 'iDznRwvMsTaMmQ6zkfQTJKWb5YCh8RHyp5',
    signature: 'iJZHVjWN22cLXx3MPWjpq7VeSBndjFtZB5',
    timestamp: 'iL13pKpKAQZ4hm2vECGQ5EmFBqRzEneJrq',
  },
  platform: {
    datapolicy: 'i6y4XPg5m9YeeP1Rk2iqJGiZwtWWK8pBoC',
    trustlevel: 'iDDiY2y6Juo9vUprbB69utX55pzcpkNKoW',
    disputeresolution: 'iJjCHbDoE6r4PqWe2i7SXGuPCn4Fw48Krw',
  },
  session: {
    duration: 'iEfV7FSNNorTcoukVXpUadneaCB44GJXRt',
    tokenLimit: 'iK7AVbtFj9hKxy7XaCyzc4iPo8jfpeENQG',
    imageLimit: 'i733ccahSD96tjGLvypVFozZ5i15xPSzZu',
    messageLimit: 'iLrDehY12RhJJ5XGi49QTfZsasY1L7RKWz',
    maxFileSize: 'i6iGYRcbtaPHyagDsv77Sja66HNFcA73Fw',
    allowedFileTypes: 'i4WmLAEe78myVEPKdWSfRBTEb5sRoWhwjR',
  },
} as const;

export function getCanonicalVdxfDefinitionCount(): number {
  return Object.values(VDXF_KEYS).reduce((n, group) => n + Object.keys(group).length, 0);
}

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

export function buildAgentContentMultimap(profile?: AgentProfileInput, services: ServiceInput[] = []): Record<string, string[]> {
  const contentmultimap: Record<string, string[]> = {};

  if (profile) {
    contentmultimap[VDXF_KEYS.agent.version] = [encodeVdxfValue('1')];
    contentmultimap[VDXF_KEYS.agent.type] = [encodeVdxfValue(profile.type)];
    contentmultimap[VDXF_KEYS.agent.name] = [encodeVdxfValue(profile.name)];
    contentmultimap[VDXF_KEYS.agent.description] = [encodeVdxfValue(profile.description)];
    contentmultimap[VDXF_KEYS.agent.status] = [encodeVdxfValue('active')];

    if (profile.category) {
      contentmultimap[VDXF_KEYS.agent.category] = [encodeVdxfValue(profile.category)];
    }
    if (profile.owner) {
      contentmultimap[VDXF_KEYS.agent.owner] = [encodeVdxfValue(profile.owner)];
    }
    if (profile.tags?.length) {
      contentmultimap[VDXF_KEYS.agent.tags] = [encodeVdxfValue(profile.tags)];
    }
    if (profile.website) {
      contentmultimap[VDXF_KEYS.agent.website] = [encodeVdxfValue(profile.website)];
    }
    if (profile.avatar) {
      contentmultimap[VDXF_KEYS.agent.avatar] = [encodeVdxfValue(profile.avatar)];
    }
    if (profile.protocols?.length) {
      contentmultimap[VDXF_KEYS.agent.protocols] = [encodeVdxfValue(profile.protocols)];
    }
    if (profile.endpoints?.length) {
      contentmultimap[VDXF_KEYS.agent.endpoints] = profile.endpoints.map(ep => encodeVdxfValue(ep));
    }
    if (profile.capabilities?.length) {
      contentmultimap[VDXF_KEYS.agent.capabilities] = profile.capabilities.map(cap => encodeVdxfValue(cap));
    }

    if (profile.session) {
      if (profile.session.duration != null) {
        contentmultimap[VDXF_KEYS.session.duration] = [encodeVdxfValue(profile.session.duration)];
      }
      if (profile.session.tokenLimit != null) {
        contentmultimap[VDXF_KEYS.session.tokenLimit] = [encodeVdxfValue(profile.session.tokenLimit)];
      }
      if (profile.session.imageLimit != null) {
        contentmultimap[VDXF_KEYS.session.imageLimit] = [encodeVdxfValue(profile.session.imageLimit)];
      }
      if (profile.session.messageLimit != null) {
        contentmultimap[VDXF_KEYS.session.messageLimit] = [encodeVdxfValue(profile.session.messageLimit)];
      }
      if (profile.session.maxFileSize != null) {
        contentmultimap[VDXF_KEYS.session.maxFileSize] = [encodeVdxfValue(profile.session.maxFileSize)];
      }
      if (profile.session.allowedFileTypes?.length) {
        contentmultimap[VDXF_KEYS.session.allowedFileTypes] = [encodeVdxfValue(profile.session.allowedFileTypes)];
      }
    }

    // Platform-level keys
    if (profile.datapolicy) {
      contentmultimap[VDXF_KEYS.platform.datapolicy] = [encodeVdxfValue(profile.datapolicy)];
    }
    if (profile.trustlevel) {
      contentmultimap[VDXF_KEYS.platform.trustlevel] = [encodeVdxfValue(profile.trustlevel)];
    }
    if (profile.disputeresolution) {
      contentmultimap[VDXF_KEYS.platform.disputeresolution] = [encodeVdxfValue(profile.disputeresolution)];
    }
  }

  if (services.length > 0) {
    contentmultimap[VDXF_KEYS.agent.services] = services.map((svc) =>
      encodeVdxfValue({
        name: svc.name,
        description: svc.description,
        category: svc.category,
        price: svc.price,
        currency: svc.currency,
        turnaround: svc.turnaround,
        status: 'active',
      })
    );
  }

  return contentmultimap;
}

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
  contentmultimap?: Record<string, string[]>;
}

export function buildCanonicalAgentUpdate(params: CanonicalAgentUpdateParams): Record<string, unknown> {
  const {
    fullName,
    parent,
    primaryaddresses,
    minimumsignatures = 1,
    vdxfKeys,
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

  const contentmultimap: Record<string, string[]> = {};

  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    const key = vdxfKeys[field];
    if (!key) continue;

    if (field === 'services' && Array.isArray(value)) {
      const encoded = value
        .filter((svc) => svc && typeof svc === 'object' && Object.keys(svc as object).length > 0)
        .map((svc) => encodeVdxfValue(svc));

      if (encoded.length > 0) {
        contentmultimap[key] = encoded;
      }
    } else {
      contentmultimap[key] = [encodeVdxfValue(value)];
    }
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

  const expectedCmm = (expectedPayload.contentmultimap || {}) as Record<string, string[]>;
  const onchain = identity.contentmultimap || {};

  for (const [key, value] of Object.entries(expectedCmm)) {
    if (!onchain[key] || onchain[key].length === 0) {
      errors.push(`missing key ${key}`);
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) continue;

    if (onchain[key].length !== value.length) {
      errors.push(`array length mismatch on ${key}: expected ${value.length}, got ${onchain[key].length}`);
      continue;
    }

    for (let i = 0; i < value.length; i++) {
      if (onchain[key][i] !== value[i]) {
        const e = decodeVdxfValue(value[i]);
        const a = decodeVdxfValue(onchain[key][i]);
        if (JSON.stringify(e) !== JSON.stringify(a)) {
          errors.push(`value mismatch on ${key}[${i}]`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Reverse-decode a VDXF contentmultimap back into an AgentProfileInput (M3).
 * Used by A2A Gateway to generate Agent Cards from on-chain identity data.
 *
 * @param cmm - On-chain contentmultimap (i-address keys → hex-encoded values)
 * @returns Decoded agent profile + services
 */
export function decodeContentMultimap(cmm: Record<string, string[]>): {
  profile: AgentProfileInput;
  services: ServiceInput[];
} {
  // Build reverse lookup: i-address → [group, field]
  const reverseMap = new Map<string, [string, string]>();
  for (const [group, keys] of Object.entries(VDXF_KEYS)) {
    for (const [field, iAddr] of Object.entries(keys)) {
      reverseMap.set(iAddr, [group, field]);
    }
  }

  const profile: Partial<AgentProfileInput> = {};
  const session: Partial<NonNullable<AgentProfileInput['session']>> = {};
  const services: ServiceInput[] = [];

  for (const [key, values] of Object.entries(cmm)) {
    const mapping = reverseMap.get(key);
    if (!mapping || !values?.length) continue;

    const [group, field] = mapping;

    if (group === 'agent') {
      switch (field) {
        case 'name': profile.name = decodeVdxfValue(values[0]) as string; break;
        case 'type': profile.type = decodeVdxfValue(values[0]) as AgentProfileInput['type']; break;
        case 'description': profile.description = decodeVdxfValue(values[0]) as string; break;
        case 'category': profile.category = decodeVdxfValue(values[0]) as string; break;
        case 'owner': profile.owner = decodeVdxfValue(values[0]) as string; break;
        case 'tags': profile.tags = decodeVdxfValue(values[0]) as string[]; break;
        case 'website': profile.website = decodeVdxfValue(values[0]) as string; break;
        case 'avatar': profile.avatar = decodeVdxfValue(values[0]) as string; break;
        case 'protocols': profile.protocols = decodeVdxfValue(values[0]) as string[]; break;
        case 'endpoints': profile.endpoints = values.map(v => decodeVdxfValue(v) as AgentProfileInput['endpoints'] extends (infer T)[] | undefined ? T : never); break;
        case 'capabilities': profile.capabilities = values.map(v => decodeVdxfValue(v) as AgentProfileInput['capabilities'] extends (infer T)[] | undefined ? T : never); break;
        case 'services':
          for (const v of values) {
            services.push(decodeVdxfValue(v) as ServiceInput);
          }
          break;
      }
    } else if (group === 'session') {
      const decoded = decodeVdxfValue(values[0]);
      switch (field) {
        case 'duration': session.duration = decoded as number; break;
        case 'tokenLimit': session.tokenLimit = decoded as number; break;
        case 'imageLimit': session.imageLimit = decoded as number; break;
        case 'messageLimit': session.messageLimit = decoded as number; break;
        case 'maxFileSize': session.maxFileSize = decoded as number; break;
        case 'allowedFileTypes': session.allowedFileTypes = decoded as string[]; break;
      }
    } else if (group === 'platform') {
      const decoded = decodeVdxfValue(values[0]) as string;
      switch (field) {
        case 'datapolicy': profile.datapolicy = decoded; break;
        case 'trustlevel': profile.trustlevel = decoded; break;
        case 'disputeresolution': profile.disputeresolution = decoded; break;
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

export function buildUpdateIdentityPayload(identityName: string, contentmultimap: Record<string, string[]>): Record<string, unknown> {
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
  // Only pass -chain for testnet; mainnet is the default and doesn't need a chain argument
  if (chain === 'verustest') args.push('-chain=vrsctest');
  args.push('updateidentity', JSON.stringify(payload));
  return args;
}
