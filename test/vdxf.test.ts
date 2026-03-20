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

// ─── 1. VDXF Schema ─────────────────────────────────────────────────

describe('VDXF Schema', () => {
  it('has exactly 18 keys', () => {
    assert.strictEqual(getCanonicalVdxfDefinitionCount(), 18);
  });

  it('has 8 parent keys', () => {
    assert.strictEqual(Object.keys(PARENT_KEYS).length, 8);
  });

  it('agent has 8 keys (displayName, type, description, status, owner, services, network, profile)', () => {
    const keys = Object.keys(VDXF_KEYS.agent);
    assert.strictEqual(keys.length, 8);
    for (const k of ['displayName', 'type', 'description', 'status', 'owner', 'services', 'network', 'profile']) {
      assert.ok(VDXF_KEYS.agent[k], `agent.${k} must be defined`);
    }
  });

  it('service has 2 keys (schema, dispute)', () => {
    const keys = Object.keys(VDXF_KEYS.service);
    assert.strictEqual(keys.length, 2);
    assert.ok(VDXF_KEYS.service.schema);
    assert.ok(VDXF_KEYS.service.dispute);
  });

  it('review has 1 key (record)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.review).length, 1);
    assert.ok(VDXF_KEYS.review.record);
  });

  it('bounty has 2 keys (record, application)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.bounty).length, 2);
    assert.ok(VDXF_KEYS.bounty.record);
    assert.ok(VDXF_KEYS.bounty.application);
  });

  it('platform has 1 key (config)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.platform).length, 1);
    assert.ok(VDXF_KEYS.platform.config);
  });

  it('session has 1 key (params)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.session).length, 1);
    assert.ok(VDXF_KEYS.session.params);
  });

  it('workspace has 2 keys (attestation, capability)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.workspace).length, 2);
    assert.ok(VDXF_KEYS.workspace.attestation);
    assert.ok(VDXF_KEYS.workspace.capability);
  });

  it('job has 1 key (record)', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.job).length, 1);
    assert.ok(VDXF_KEYS.job.record);
  });

  it('old individual agent keys are gone (capabilities, endpoints, protocols, tags, website, avatar, category)', () => {
    for (const k of ['capabilities', 'endpoints', 'protocols', 'tags', 'website', 'avatar', 'category']) {
      assert.strictEqual((VDXF_KEYS.agent as any)[k], undefined, `agent.${k} should not exist`);
    }
  });

  it('agent uses displayName not name', () => {
    assert.ok(VDXF_KEYS.agent.displayName);
    assert.strictEqual((VDXF_KEYS.agent as any).name, undefined);
  });
});

// ─── 2. buildAgentContentMultimap ────────────────────────────────────

describe('buildAgentContentMultimap', () => {
  /** Helper: extract sub-DD labels from a parent key's outer DD. */
  function extractLabels(cmm: Record<string, any[]>, parentKey: string): string[] {
    const outerDD = cmm[parentKey][0][DD];
    return outerDD.objectdata.map((d: any) => d[DD].label);
  }

  it('builds with network and profile blobs — sub-DDs have correct labels', () => {
    const cmm = buildAgentContentMultimap({
      name: 'TestBot',
      type: 'autonomous',
      description: 'A test agent',
      network: { capabilities: ['text'], endpoints: ['https://api.test.com'], protocols: ['rest'] },
      profile: { tags: ['ai', 'test'], website: 'https://test.com', category: 'assistant' },
    });

    assert.ok(cmm[PARENT_KEYS.agent], 'agent parent key must exist');
    const labels = extractLabels(cmm, PARENT_KEYS.agent);

    assert.ok(labels.includes(VDXF_KEYS.agent.network), 'should include agent.network label');
    assert.ok(labels.includes(VDXF_KEYS.agent.profile), 'should include agent.profile label');
    assert.ok(labels.includes(VDXF_KEYS.agent.displayName), 'should include agent.displayName');
    assert.ok(labels.includes(VDXF_KEYS.agent.type), 'should include agent.type');
    assert.ok(labels.includes(VDXF_KEYS.agent.description), 'should include agent.description');
  });

  it('puts services as JSON array in agent.services (NOT under service parent)', () => {
    const cmm = buildAgentContentMultimap(
      { name: 'SvcBot', type: 'autonomous', description: 'Has services' },
      [{ name: 'SvcA', price: 1, currency: 'VRSC' }],
    );

    // Should be under agent parent, NOT service parent
    assert.ok(cmm[PARENT_KEYS.agent], 'agent parent key must exist');
    assert.strictEqual(cmm[PARENT_KEYS.service], undefined, 'service parent key must NOT be set');

    const labels = extractLabels(cmm, PARENT_KEYS.agent);
    assert.ok(labels.includes(VDXF_KEYS.agent.services), 'agent.services label present');

    // Parse the services JSON
    const outerDD = cmm[PARENT_KEYS.agent][0][DD];
    const svcSubDD = outerDD.objectdata.find((d: any) => d[DD].label === VDXF_KEYS.agent.services);
    const parsed = JSON.parse(svcSubDD[DD].objectdata.message);
    assert.ok(Array.isArray(parsed), 'services value should be a JSON array');
    assert.strictEqual(parsed[0].name, 'SvcA');
  });

  it('consolidates session into single params JSON', () => {
    const cmm = buildAgentContentMultimap({
      name: 'SessionBot',
      type: 'autonomous',
      description: 'Testing session consolidation',
      session: { duration: 3600, tokenLimit: 100000, messageLimit: 50 },
    });

    assert.ok(cmm[PARENT_KEYS.session], 'session parent key must exist');
    const sessionDD = cmm[PARENT_KEYS.session][0][DD];
    assert.strictEqual(sessionDD.objectdata.length, 1, 'should have exactly 1 sub-DD (params)');
    const paramDD = sessionDD.objectdata[0][DD];
    assert.strictEqual(paramDD.label, VDXF_KEYS.session.params);
    const parsed = JSON.parse(paramDD.objectdata.message);
    assert.strictEqual(parsed.duration, 3600);
    assert.strictEqual(parsed.tokenLimit, 100000);
    assert.strictEqual(parsed.messageLimit, 50);
  });

  it('consolidates platform config into single config JSON', () => {
    const cmm = buildAgentContentMultimap({
      name: 'PlatBot',
      type: 'autonomous',
      description: 'Testing platform config',
      platformConfig: { datapolicy: 'strict', trustlevel: 'high' },
    });

    assert.ok(cmm[PARENT_KEYS.platform], 'platform parent key must exist');
    const platDD = cmm[PARENT_KEYS.platform][0][DD];
    assert.strictEqual(platDD.objectdata.length, 1, 'should have exactly 1 sub-DD (config)');
    const cfgDD = platDD.objectdata[0][DD];
    assert.strictEqual(cfgDD.label, VDXF_KEYS.platform.config);
    const parsed = JSON.parse(cfgDD.objectdata.message);
    assert.strictEqual(parsed.datapolicy, 'strict');
    assert.strictEqual(parsed.trustlevel, 'high');
  });

  it('includes workspace capability when provided', () => {
    const cmm = buildAgentContentMultimap({
      name: 'WsBot',
      type: 'autonomous',
      description: 'Workspace-capable agent',
      workspaceCapability: { workspace: true, modes: ['supervised'], tools: ['readFile', 'writeFile'] },
    });

    assert.ok(cmm[PARENT_KEYS.workspace], 'workspace parent key must exist');
    const wsDD = cmm[PARENT_KEYS.workspace][0][DD];
    const capDD = wsDD.objectdata[0][DD];
    assert.strictEqual(capDD.label, VDXF_KEYS.workspace.capability);
    const parsed = JSON.parse(capDD.objectdata.message);
    assert.strictEqual(parsed.workspace, true);
    assert.deepStrictEqual(parsed.modes, ['supervised']);
    assert.deepStrictEqual(parsed.tools, ['readFile', 'writeFile']);
  });

  it('services-without-profile still goes under agent parent', () => {
    const cmm = buildAgentContentMultimap(undefined, [
      { name: 'StandaloneSvc', price: 2, currency: 'VRSC' },
    ]);

    assert.ok(cmm[PARENT_KEYS.agent], 'agent parent key must exist for service-only');
    assert.strictEqual(cmm[PARENT_KEYS.service], undefined, 'service parent key must NOT be set');
    const labels = extractLabels(cmm, PARENT_KEYS.agent);
    assert.ok(labels.includes(VDXF_KEYS.agent.services), 'agent.services label present');
  });
});

// ─── 3. decodeContentMultimap round-trip ─────────────────────────────

describe('decodeContentMultimap round-trip', () => {
  it('round-trips profile with network and profile blobs', () => {
    const cmm = buildAgentContentMultimap({
      name: 'RoundTrip Bot',
      type: 'hybrid',
      description: 'Tests round-trip',
      network: { capabilities: ['text', 'image'], endpoints: ['https://api.rt.com'], protocols: ['rest', 'ws'] },
      profile: { tags: ['ai', 'demo'], website: 'https://rt.com', avatar: 'https://rt.com/av.png', category: 'demo' },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.name, 'RoundTrip Bot');
    assert.strictEqual(decoded.profile.type, 'hybrid');
    assert.strictEqual(decoded.profile.description, 'Tests round-trip');
    assert.deepStrictEqual(decoded.profile.network?.capabilities, ['text', 'image']);
    assert.deepStrictEqual(decoded.profile.network?.endpoints, ['https://api.rt.com']);
    assert.deepStrictEqual(decoded.profile.network?.protocols, ['rest', 'ws']);
    assert.deepStrictEqual(decoded.profile.profile?.tags, ['ai', 'demo']);
    assert.strictEqual(decoded.profile.profile?.website, 'https://rt.com');
    assert.strictEqual(decoded.profile.profile?.avatar, 'https://rt.com/av.png');
    assert.strictEqual(decoded.profile.profile?.category, 'demo');
  });

  it('round-trips services as JSON array (including resolutionWindow, refundPolicy)', () => {
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

  it('round-trips session params', () => {
    const cmm = buildAgentContentMultimap({
      name: 'SessionRT',
      type: 'autonomous',
      description: 'Session round-trip',
      session: { duration: 7200, tokenLimit: 50000, imageLimit: 10 },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.session?.duration, 7200);
    assert.strictEqual(decoded.profile.session?.tokenLimit, 50000);
    assert.strictEqual(decoded.profile.session?.imageLimit, 10);
  });

  it('round-trips platform config', () => {
    const cmm = buildAgentContentMultimap({
      name: 'PlatRT',
      type: 'autonomous',
      description: 'Platform round-trip',
      platformConfig: { datapolicy: 'strict', trustlevel: 'high', disputeresolution: 'mediation' },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.ok(decoded.profile.platformConfig);
    assert.strictEqual(decoded.profile.platformConfig.datapolicy, 'strict');
    assert.strictEqual(decoded.profile.platformConfig.trustlevel, 'high');
    assert.strictEqual(decoded.profile.platformConfig.disputeresolution, 'mediation');
  });

  it('round-trips workspace capability', () => {
    const cmm = buildAgentContentMultimap({
      name: 'WsRT',
      type: 'autonomous',
      description: 'Workspace round-trip',
      workspaceCapability: { workspace: true, modes: ['supervised', 'standard'], tools: ['readFile'] },
    });

    const decoded = decodeContentMultimap(cmm);
    assert.ok(decoded.profile.workspaceCapability);
    assert.strictEqual(decoded.profile.workspaceCapability.workspace, true);
    assert.deepStrictEqual(decoded.profile.workspaceCapability.modes, ['supervised', 'standard']);
    assert.deepStrictEqual(decoded.profile.workspaceCapability.tools, ['readFile']);
  });
});

// ─── 4. Job completion helpers ───────────────────────────────────────

describe('Job completion helpers', () => {
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

  it('buildJobCompletionAdditions with job record only (1 parent key)', () => {
    const additions = buildJobCompletionAdditions({ jobRecord });
    const parentKeys = Object.keys(additions);
    assert.strictEqual(parentKeys.length, 1, 'should have 1 parent key');
    assert.ok(additions[PARENT_KEYS.job], 'job parent key must exist');

    const jobDD = additions[PARENT_KEYS.job][0][DD];
    assert.strictEqual(jobDD.objectdata.length, 1);
    const sub = jobDD.objectdata[0][DD];
    assert.strictEqual(sub.label, VDXF_KEYS.job.record);
    const parsed = JSON.parse(sub.objectdata.message);
    assert.strictEqual(parsed.jobHash, 'abc123');
    assert.strictEqual(parsed.buyer, 'iBuyer1');
    assert.strictEqual(parsed.amount, 10);
  });

  it('buildJobCompletionAdditions with job + review + workspace (3 parent keys)', () => {
    const additions = buildJobCompletionAdditions({
      jobRecord,
      reviewRecord,
      workspaceAttestation,
    });

    const parentKeys = Object.keys(additions);
    assert.strictEqual(parentKeys.length, 3, 'should have 3 parent keys');
    assert.ok(additions[PARENT_KEYS.job], 'job parent key must exist');
    assert.ok(additions[PARENT_KEYS.review], 'review parent key must exist');
    assert.ok(additions[PARENT_KEYS.workspace], 'workspace parent key must exist');

    // Verify review sub-DD
    const reviewDD = additions[PARENT_KEYS.review][0][DD];
    const reviewSub = reviewDD.objectdata[0][DD];
    assert.strictEqual(reviewSub.label, VDXF_KEYS.review.record);
    const parsedReview = JSON.parse(reviewSub.objectdata.message);
    assert.strictEqual(parsedReview.rating, 5);
    assert.strictEqual(parsedReview.message, 'Great work');

    // Verify workspace attestation sub-DD
    const wsDD = additions[PARENT_KEYS.workspace][0][DD];
    const wsSub = wsDD.objectdata[0][DD];
    assert.strictEqual(wsSub.label, VDXF_KEYS.workspace.attestation);
    const parsedWs = JSON.parse(wsSub.objectdata.message);
    assert.strictEqual(parsedWs.duration, 3600);
    assert.strictEqual(parsedWs.completedClean, true);
    assert.strictEqual(parsedWs.mode, 'supervised');
  });

  it('mergeContentMultimap preserves existing and adds new', () => {
    const existing = buildAgentContentMultimap({
      name: 'MergeBot',
      type: 'autonomous',
      description: 'Testing merge',
    });

    const additions = buildJobCompletionAdditions({ jobRecord, reviewRecord });
    const merged = mergeContentMultimap(existing, additions);

    // Existing agent parent preserved
    assert.ok(merged[PARENT_KEYS.agent], 'agent parent key preserved');
    // New job and review parent keys added
    assert.ok(merged[PARENT_KEYS.job], 'job parent key added');
    assert.ok(merged[PARENT_KEYS.review], 'review parent key added');

    // Existing data intact
    const agentDD = merged[PARENT_KEYS.agent][0][DD];
    const labels = agentDD.objectdata.map((d: any) => d[DD].label);
    assert.ok(labels.includes(VDXF_KEYS.agent.displayName));
  });

  it('mergeContentMultimap appends to existing parent key', () => {
    const existing: Record<string, unknown[]> = {};
    const firstJob = buildJobCompletionAdditions({ jobRecord });
    const secondJob = buildJobCompletionAdditions({
      jobRecord: { ...jobRecord, jobHash: 'def456' },
    });

    const step1 = mergeContentMultimap(existing, firstJob);
    const step2 = mergeContentMultimap(step1, secondJob);

    // Two outer DDs under job parent
    assert.strictEqual(step2[PARENT_KEYS.job].length, 2, 'should have 2 job outer DDs');
  });
});

// ─── 5. Existing tests that still apply ──────────────────────────────

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
