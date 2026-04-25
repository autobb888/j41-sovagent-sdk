import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  VDXF_KEYS,
  PARENT_KEYS,
  DATA_DESCRIPTOR_KEY,
  buildAgentContentMultimap,
  decodeContentMultimap,
  buildJobCompletionAdditions,
  mergeContentMultimap,
  getCanonicalVdxfDefinitionCount,
  makeSubDD,
} = require('../dist/index.js');

const DD = DATA_DESCRIPTOR_KEY;

// ─── 1. VDXF Schema (25 flat keys) ─────────────────────────────────

describe('VDXF Schema', () => {
  it('has exactly 25 keys', () => {
    assert.strictEqual(getCanonicalVdxfDefinitionCount(), 25);
  });

  it('PARENT_KEYS still exported (deprecated, for legacy compat)', () => {
    assert.strictEqual(Object.keys(PARENT_KEYS).length, 8);
  });

  it('agent has 16 keys (flat — no more owner/network/profile blobs)', () => {
    const keys = Object.keys(VDXF_KEYS.agent);
    assert.strictEqual(keys.length, 16);
    for (const k of [
      'displayName', 'type', 'description', 'status', 'payAddress',
      'services', 'models', 'markup',
      'networkCapabilities', 'networkEndpoints', 'networkProtocols',
      'profileTags', 'profileWebsite', 'profileAvatar', 'profileCategory',
      'disputePolicy',
    ]) {
      assert.ok(VDXF_KEYS.agent[k], `agent.${k} must be defined`);
    }
  });

  it('removed keys no longer present (owner, network blob, profile blob)', () => {
    for (const k of ['owner', 'network', 'profile']) {
      assert.strictEqual((VDXF_KEYS.agent as any)[k], undefined, `agent.${k} should be removed`);
    }
  });

  it('service has 1 key (schema only — dispute moved to agent.disputePolicy)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.service).length, 1);
    assert.ok(VDXF_KEYS.service.schema);
  });

  it('review has 1 key (record)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.review).length, 1);
    assert.ok(VDXF_KEYS.review.record);
  });

  it('bounty has 2 keys (record, application)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.bounty).length, 2);
  });

  it('platform has 1, session has 1, workspace has 2, job has 1', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.platform).length, 1);
    assert.strictEqual(Object.keys(VDXF_KEYS.session).length, 1);
    assert.strictEqual(Object.keys(VDXF_KEYS.workspace).length, 2);
    assert.strictEqual(Object.keys(VDXF_KEYS.job).length, 1);
  });
});

// ─── 2. buildAgentContentMultimap (flat format) ─────────────────────

describe('buildAgentContentMultimap (flat format)', () => {
  /** Helper: extract sub-DD value from a flat key entry. */
  function getValue(cmm: Record<string, any[]>, key: string): any {
    const entry = cmm[key]?.[0]?.[DD];
    if (!entry) return undefined;
    return entry.objectdata?.message;
  }

  it('produces flat keys (no parent key wrapping)', () => {
    const cmm = buildAgentContentMultimap({
      name: 'TestBot',
      type: 'autonomous',
      description: 'A test agent',
    });

    // Flat keys present
    assert.ok(cmm[VDXF_KEYS.agent.displayName], 'displayName key must exist');
    assert.ok(cmm[VDXF_KEYS.agent.type], 'type key must exist');
    assert.ok(cmm[VDXF_KEYS.agent.description], 'description key must exist');
    assert.ok(cmm[VDXF_KEYS.agent.status], 'status key must exist');

    // No parent keys
    for (const pk of Object.values(PARENT_KEYS)) {
      assert.strictEqual(cmm[pk], undefined, `parent key ${pk} must NOT be present`);
    }
  });

  it('splits network into 3 flat keys (capabilities, endpoints, protocols)', () => {
    const cmm = buildAgentContentMultimap({
      name: 'NetBot',
      type: 'autonomous',
      description: 'Network test',
      network: { capabilities: ['text'], endpoints: ['https://api.test.com'], protocols: ['rest'] },
    });

    assert.ok(cmm[VDXF_KEYS.agent.networkCapabilities]);
    assert.ok(cmm[VDXF_KEYS.agent.networkEndpoints]);
    assert.ok(cmm[VDXF_KEYS.agent.networkProtocols]);

    const caps = JSON.parse(getValue(cmm, VDXF_KEYS.agent.networkCapabilities));
    assert.deepStrictEqual(caps, ['text']);
    const eps = JSON.parse(getValue(cmm, VDXF_KEYS.agent.networkEndpoints));
    assert.deepStrictEqual(eps, ['https://api.test.com']);
    const protos = JSON.parse(getValue(cmm, VDXF_KEYS.agent.networkProtocols));
    assert.deepStrictEqual(protos, ['rest']);
  });

  it('splits profile into 4 flat keys (tags, website, avatar, category)', () => {
    const cmm = buildAgentContentMultimap({
      name: 'ProfBot',
      type: 'autonomous',
      description: 'Profile test',
      profile: { tags: ['ai', 'test'], website: 'https://test.com', avatar: 'https://test.com/av.png', category: 'assistant' },
    });

    assert.ok(cmm[VDXF_KEYS.agent.profileTags]);
    assert.ok(cmm[VDXF_KEYS.agent.profileWebsite]);
    assert.ok(cmm[VDXF_KEYS.agent.profileAvatar]);
    assert.ok(cmm[VDXF_KEYS.agent.profileCategory]);

    const tags = JSON.parse(getValue(cmm, VDXF_KEYS.agent.profileTags));
    assert.deepStrictEqual(tags, ['ai', 'test']);
    assert.strictEqual(getValue(cmm, VDXF_KEYS.agent.profileWebsite), 'https://test.com');
    assert.strictEqual(getValue(cmm, VDXF_KEYS.agent.profileCategory), 'assistant');
  });

  it('includes payAddress as flat key', () => {
    const cmm = buildAgentContentMultimap({
      name: 'PayBot',
      type: 'autonomous',
      description: 'Pay test',
      payAddress: 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2',
    });

    assert.ok(cmm[VDXF_KEYS.agent.payAddress]);
    assert.strictEqual(getValue(cmm, VDXF_KEYS.agent.payAddress), 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2');
  });

  it('puts services as JSON array under agent.services (flat key)', () => {
    const cmm = buildAgentContentMultimap(
      { name: 'SvcBot', type: 'autonomous', description: 'Has services' },
      [{ name: 'SvcA', price: 1, currency: 'VRSC' }],
    );

    assert.ok(cmm[VDXF_KEYS.agent.services]);
    const parsed = JSON.parse(getValue(cmm, VDXF_KEYS.agent.services));
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed[0].name, 'SvcA');
  });

  it('session.params as flat key', () => {
    const cmm = buildAgentContentMultimap({
      name: 'SessionBot',
      type: 'autonomous',
      description: 'Session test',
      session: { duration: 3600, tokenLimit: 100000 },
    });

    assert.ok(cmm[VDXF_KEYS.session.params]);
    const parsed = JSON.parse(getValue(cmm, VDXF_KEYS.session.params));
    assert.strictEqual(parsed.duration, 3600);
    assert.strictEqual(parsed.tokenLimit, 100000);
  });

  it('platform.config and workspace.capability as flat keys', () => {
    const cmm = buildAgentContentMultimap({
      name: 'CfgBot',
      type: 'autonomous',
      description: 'Config test',
      platformConfig: { datapolicy: 'strict' },
      workspaceCapability: { workspace: true, modes: ['supervised'], tools: ['readFile'] },
    });

    assert.ok(cmm[VDXF_KEYS.platform.config]);
    assert.ok(cmm[VDXF_KEYS.workspace.capability]);
    const wsCap = JSON.parse(getValue(cmm, VDXF_KEYS.workspace.capability));
    assert.strictEqual(wsCap.workspace, true);
  });

  it('services-only (no profile) still produces flat key', () => {
    const cmm = buildAgentContentMultimap(undefined, [
      { name: 'StandaloneSvc', price: 2, currency: 'VRSC' },
    ]);

    assert.ok(cmm[VDXF_KEYS.agent.services]);
    assert.strictEqual(cmm[VDXF_KEYS.agent.displayName], undefined, 'no profile keys when profile omitted');
  });
});

// ─── 3. decodeContentMultimap round-trip (flat format) ──────────────

describe('decodeContentMultimap round-trip (flat format)', () => {
  it('round-trips profile with network and profile fields', () => {
    const cmm = buildAgentContentMultimap({
      name: 'RoundTrip Bot',
      type: 'hybrid',
      description: 'Tests round-trip',
      payAddress: 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D',
      network: { capabilities: ['text', 'image'], endpoints: ['https://api.rt.com'], protocols: ['rest', 'ws'] },
      profile: { tags: ['ai', 'demo'], website: 'https://rt.com', avatar: 'https://rt.com/av.png', category: 'demo' },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.name, 'RoundTrip Bot');
    assert.strictEqual(decoded.profile.type, 'hybrid');
    assert.strictEqual(decoded.profile.description, 'Tests round-trip');
    assert.strictEqual(decoded.profile.payAddress, 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D');
    assert.deepStrictEqual(decoded.profile.network?.capabilities, ['text', 'image']);
    assert.deepStrictEqual(decoded.profile.network?.endpoints, ['https://api.rt.com']);
    assert.deepStrictEqual(decoded.profile.network?.protocols, ['rest', 'ws']);
    assert.deepStrictEqual(decoded.profile.profile?.tags, ['ai', 'demo']);
    assert.strictEqual(decoded.profile.profile?.website, 'https://rt.com');
    assert.strictEqual(decoded.profile.profile?.avatar, 'https://rt.com/av.png');
    assert.strictEqual(decoded.profile.profile?.category, 'demo');
  });

  it('round-trips services with pricing, refundPolicy, resolutionWindow', () => {
    const cmm = buildAgentContentMultimap(
      { name: 'SvcRT', type: 'autonomous', description: 'Service round-trip' },
      [{
        name: 'Premium',
        price: 5,
        currency: 'VRSC',
        paymentTerms: 'prepay' as const,
        privateMode: true,
        sovguard: false,
        resolutionWindow: 72,
        refundPolicy: { policy: 'fixed' as const, percent: 50 },
      }],
    );

    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.services.length, 1);
    const svc = decoded.services[0];
    assert.strictEqual(svc.name, 'Premium');
    assert.strictEqual(svc.price, 5);
    assert.strictEqual(svc.currency, 'VRSC');
    assert.strictEqual(svc.paymentTerms, 'prepay');
    assert.strictEqual(svc.privateMode, true);
    assert.strictEqual(svc.sovguard, false);
    assert.strictEqual(svc.resolutionWindow, 72);
    assert.deepStrictEqual(svc.refundPolicy, { policy: 'fixed', percent: 50 });
  });

  it('round-trips session, platformConfig, workspace', () => {
    const cmm = buildAgentContentMultimap({
      name: 'FullRT',
      type: 'autonomous',
      description: 'Full round-trip',
      session: { duration: 7200, tokenLimit: 50000, imageLimit: 10 },
      platformConfig: { datapolicy: 'strict', trustlevel: 'high', disputeresolution: 'mediation' },
      workspaceCapability: { workspace: true, modes: ['supervised', 'standard'], tools: ['readFile'] },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.session?.duration, 7200);
    assert.strictEqual(decoded.profile.session?.tokenLimit, 50000);
    assert.strictEqual(decoded.profile.session?.imageLimit, 10);
    assert.strictEqual(decoded.profile.platformConfig?.datapolicy, 'strict');
    assert.strictEqual(decoded.profile.platformConfig?.disputeresolution, 'mediation');
    assert.strictEqual(decoded.profile.workspaceCapability?.workspace, true);
    assert.deepStrictEqual(decoded.profile.workspaceCapability?.modes, ['supervised', 'standard']);
  });

  it('round-trips models and markup', () => {
    const cmm = buildAgentContentMultimap({
      name: 'ModelsBot',
      type: 'autonomous',
      description: 'Models test',
      models: ['claude-sonnet-4-6', 'kimi-k2.5'],
      markup: 3,
    });

    const decoded = decodeContentMultimap(cmm);
    assert.deepStrictEqual(decoded.profile.models, ['claude-sonnet-4-6', 'kimi-k2.5']);
    assert.strictEqual(decoded.profile.markup, 3);
  });
});

// ─── 4. Legacy format decode (backwards compat) ────────────────────

describe('decodeContentMultimap legacy format', () => {
  /**
   * Build a legacy parent-keyed contentmultimap (simulates old on-chain data).
   */
  function buildLegacyCmm(): Record<string, any[]> {
    const oldAgentNetworkKey = 'iJ15GBkMfyMxvEf7wivLKbXRjpqS119QrM';
    const oldAgentProfileKey = 'iAFyowB5a3W5BLEv6tE7EPHAmGhaYcGJCt';

    const agentSubDDs = [
      makeSubDD(VDXF_KEYS.agent.displayName, 'LegacyBot'),
      makeSubDD(VDXF_KEYS.agent.type, 'autonomous'),
      makeSubDD(VDXF_KEYS.agent.description, 'Old format agent'),
      makeSubDD(oldAgentNetworkKey, JSON.stringify({ capabilities: ['chat'], protocols: ['rest'] })),
      makeSubDD(oldAgentProfileKey, JSON.stringify({ tags: ['legacy'], category: 'old' })),
    ];

    const outerDD = {
      [DD]: {
        version: 1,
        flags: 32,
        objectdata: agentSubDDs,
        label: PARENT_KEYS.agent,
      },
    };

    return {
      [PARENT_KEYS.agent]: [outerDD],
    };
  }

  it('detects and decodes legacy parent-keyed format', () => {
    const cmm = buildLegacyCmm();
    const decoded = decodeContentMultimap(cmm);

    assert.strictEqual(decoded.profile.name, 'LegacyBot');
    assert.strictEqual(decoded.profile.type, 'autonomous');
    assert.strictEqual(decoded.profile.description, 'Old format agent');
    assert.deepStrictEqual(decoded.profile.network?.capabilities, ['chat']);
    assert.deepStrictEqual(decoded.profile.network?.protocols, ['rest']);
    assert.deepStrictEqual(decoded.profile.profile?.tags, ['legacy']);
    assert.strictEqual(decoded.profile.profile?.category, 'old');
  });
});

// ─── 5. Job completion helpers (flat format) ────────────────────────

describe('Job completion helpers (flat format)', () => {
  const jobRecord = {
    jobHash: 'abc123',
    buyer: 'iBuyer1',
    description: 'Test job',
    amount: 10,
    currency: 'VRSC',
    completedAt: 1700000000,
    completionSignature: 'sig123',
  };

  const reviewRecord = {
    buyer: 'iBuyer1',
    jobHash: 'abc123',
    message: 'Great work',
    rating: 5,
    signature: 'rsig456',
    timestamp: 1700000100,
  };

  const workspaceAttestation = {
    jobId: 'job-1',
    buyer: 'iBuyer1',
    duration: 3600,
    filesRead: 5,
    filesWritten: 2,
    sovguardFlags: 0,
    completedClean: true,
    mode: 'supervised' as const,
  };

  it('buildJobCompletionAdditions produces flat keys (not parent keys)', () => {
    const additions = buildJobCompletionAdditions({ jobRecord });

    // Flat keys present
    assert.ok(additions[VDXF_KEYS.job.record], 'job.record key must exist');
    // No parent keys
    assert.strictEqual(additions[PARENT_KEYS.job], undefined, 'job parent key must NOT be present');

    const jobDD = additions[VDXF_KEYS.job.record][0][DD];
    assert.strictEqual(jobDD.label, VDXF_KEYS.job.record);
    const parsed = JSON.parse(jobDD.objectdata.message);
    assert.strictEqual(parsed.jobHash, 'abc123');
    assert.strictEqual(parsed.amount, 10);
  });

  it('buildJobCompletionAdditions with all 3 records', () => {
    const additions = buildJobCompletionAdditions({
      jobRecord,
      reviewRecord,
      workspaceAttestation,
    });

    const keys = Object.keys(additions);
    assert.strictEqual(keys.length, 3);
    assert.ok(additions[VDXF_KEYS.job.record]);
    assert.ok(additions[VDXF_KEYS.review.record]);
    assert.ok(additions[VDXF_KEYS.workspace.attestation]);

    // Verify review
    const reviewDD = additions[VDXF_KEYS.review.record][0][DD];
    const parsedReview = JSON.parse(reviewDD.objectdata.message);
    assert.strictEqual(parsedReview.rating, 5);

    // Verify workspace
    const wsDD = additions[VDXF_KEYS.workspace.attestation][0][DD];
    const parsedWs = JSON.parse(wsDD.objectdata.message);
    assert.strictEqual(parsedWs.completedClean, true);
  });

  it('mergeContentMultimap preserves existing flat keys and adds new', () => {
    const existing = buildAgentContentMultimap({
      name: 'MergeBot',
      type: 'autonomous',
      description: 'Testing merge',
    });

    const additions = buildJobCompletionAdditions({ jobRecord, reviewRecord });
    const merged = mergeContentMultimap(existing, additions);

    // Existing agent keys preserved
    assert.ok(merged[VDXF_KEYS.agent.displayName], 'displayName preserved');
    // New keys added
    assert.ok(merged[VDXF_KEYS.job.record], 'job record added');
    assert.ok(merged[VDXF_KEYS.review.record], 'review record added');
  });

  it('mergeContentMultimap appends to existing key', () => {
    const existing: Record<string, unknown[]> = {};
    const firstJob = buildJobCompletionAdditions({ jobRecord });
    const secondJob = buildJobCompletionAdditions({
      jobRecord: { ...jobRecord, jobHash: 'def456' },
    });

    const step1 = mergeContentMultimap(existing, firstJob);
    const step2 = mergeContentMultimap(step1, secondJob);

    assert.strictEqual(step2[VDXF_KEYS.job.record].length, 2, 'should have 2 job entries');
  });
});

// ─── 6. Existing tests that still apply ──────────────────────────────

describe('registerService field mapping', () => {
  it('maps currency to priceCurrency and coerces string price', () => {
    const { J41Agent } = require('../dist/agent.js');
    const { generateKeypair } = require('../dist/identity/keypair.js');
    const kp = generateKeypair('verustest');
    const agent = new J41Agent({ apiUrl: 'https://api.example.com', wif: kp.wif, identityName: 'test@', iAddress: 'iTest' });

    // Mock login and client
    agent.login = async () => {};
    let captured: any = null;
    agent._client.registerService = async (data: any) => {
      captured = data;
      return { serviceId: 'test-id' };
    };

    return agent.registerService({
      name: 'Test',
      price: '0.5' as any,
      currency: 'VRSC',
      turnaround: '5 minutes',
      paymentTerms: 'prepay',
      privateMode: true,
      sovguard: false,
    }).then(() => {
      assert.strictEqual(captured.priceCurrency, 'VRSC', 'should map currency to priceCurrency');
      assert.strictEqual(captured.price, 0.5, 'should coerce string price to number');
      assert.strictEqual(typeof captured.price, 'number');
      assert.strictEqual(captured.turnaround, '5 minutes');
      assert.strictEqual(captured.paymentTerms, 'prepay');
      assert.strictEqual(captured.privateMode, true);
      assert.strictEqual(captured.sovguard, false);
      assert.strictEqual(captured.currency, undefined, 'should not pass raw currency');
    });
  });
});

describe('RegistrationTimeoutError', () => {
  it('carries onboardId, lastStatus, identityName', () => {
    const { RegistrationTimeoutError } = require('../dist/index.js');
    const err = new RegistrationTimeoutError('onb-123', 'confirming', 'test.agentplatform@');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'RegistrationTimeoutError');
    assert.strictEqual(err.onboardId, 'onb-123');
    assert.strictEqual(err.lastStatus, 'confirming');
    assert.strictEqual(err.identityName, 'test.agentplatform@');
    assert.ok(err.message.includes('test.agentplatform@'));
  });
});
