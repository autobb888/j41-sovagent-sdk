import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  VDXF_KEYS,
  PARENT_KEYS,
  buildAgentContentMultimap,
  decodeContentMultimap,
  getCanonicalVdxfDefinitionCount,
  makeSubDD,
} = require('../dist/index.js');

describe('VDXF Schema', () => {
  it('has exactly 34 keys', () => {
    assert.strictEqual(getCanonicalVdxfDefinitionCount(), 34);
  });

  it('dropped agent.version', () => {
    assert.strictEqual((VDXF_KEYS.agent as any).version, undefined);
  });

  it('has consolidated session.params', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.session).length, 1);
    assert.ok(VDXF_KEYS.session.params);
  });

  it('agent uses displayName not name', () => {
    assert.ok(VDXF_KEYS.agent.displayName);
    assert.strictEqual((VDXF_KEYS.agent as any).name, undefined);
  });

  it('service has paymentTerms, privateMode, sovguard', () => {
    assert.ok(VDXF_KEYS.service.paymentTerms);
    assert.ok(VDXF_KEYS.service.privateMode);
    assert.ok(VDXF_KEYS.service.sovguard);
  });

  it('has 13 agent keys', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.agent).length, 13);
  });

  it('has 11 service keys', () => {
    assert.strictEqual(Object.keys(VDXF_KEYS.service).length, 11);
  });
});

describe('buildAgentContentMultimap', () => {
  it('builds agent data without version field', () => {
    const cmm = buildAgentContentMultimap({
      name: 'Test Agent',
      type: 'autonomous',
      description: 'A test agent for unit testing',
    });
    assert.ok(cmm[PARENT_KEYS.agent]);
    // Verify no version sub-DD
    const outerDD = (cmm[PARENT_KEYS.agent][0] as any)['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
    const labels = outerDD.objectdata.map((d: any) =>
      d['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'].label
    );
    // agent.version i-address was iEU6E9tmvSEXohKD6frHajc8jV8K2Pw75y
    assert.ok(!labels.includes('iEU6E9tmvSEXohKD6frHajc8jV8K2Pw75y'), 'should not contain version key');
  });

  it('consolidates session into single params JSON', () => {
    const cmm = buildAgentContentMultimap({
      name: 'Test',
      type: 'autonomous',
      description: 'Testing session consolidation',
      session: { duration: 3600, tokenLimit: 100000, messageLimit: 50 },
    });
    assert.ok(cmm[PARENT_KEYS.session]);
    const sessionDD = (cmm[PARENT_KEYS.session][0] as any)['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
    assert.strictEqual(sessionDD.objectdata.length, 1, 'should have exactly 1 sub-DD (params)');
    const paramDD = sessionDD.objectdata[0]['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
    assert.strictEqual(paramDD.label, VDXF_KEYS.session.params);
    const parsed = JSON.parse(paramDD.objectdata.message);
    assert.strictEqual(parsed.duration, 3600);
    assert.strictEqual(parsed.tokenLimit, 100000);
    assert.strictEqual(parsed.messageLimit, 50);
  });

  it('includes new service fields', () => {
    const cmm = buildAgentContentMultimap(undefined, [{
      name: 'Test Svc',
      price: 1,
      currency: 'VRSC',
      paymentTerms: 'prepay' as const,
      privateMode: true,
      sovguard: true,
    }]);
    const svcDD = (cmm[PARENT_KEYS.service][0] as any)['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
    const labels = svcDD.objectdata.map((d: any) =>
      d['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'].label
    );
    assert.ok(labels.includes(VDXF_KEYS.service.paymentTerms));
    assert.ok(labels.includes(VDXF_KEYS.service.privateMode));
    assert.ok(labels.includes(VDXF_KEYS.service.sovguard));
  });

  it('handles structured datapolicy', () => {
    const policy = { retention: 'ephemeral', allowTraining: false, allowThirdParty: false, requireDeletion: true };
    const cmm = buildAgentContentMultimap({
      name: 'Test',
      type: 'autonomous',
      description: 'Testing datapolicy format',
      datapolicy: JSON.stringify(policy),
    });
    assert.ok(cmm[PARENT_KEYS.platform]);
  });
});

describe('decodeContentMultimap round-trip', () => {
  it('round-trips profile with displayName', () => {
    const cmm = buildAgentContentMultimap({
      name: 'My Display Name',
      type: 'autonomous',
      description: 'Agent with a display name',
      category: 'ai-assistant',
      tags: ['test', 'unit'],
    });
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.name, 'My Display Name');
    assert.strictEqual(decoded.profile.type, 'autonomous');
    assert.strictEqual(decoded.profile.category, 'ai-assistant');
    assert.deepStrictEqual(decoded.profile.tags, ['test', 'unit']);
  });

  it('round-trips consolidated session params', () => {
    const cmm = buildAgentContentMultimap({
      name: 'Test',
      type: 'autonomous',
      description: 'Testing session round-trip',
      session: { duration: 7200, tokenLimit: 50000, imageLimit: 10 },
    });
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.session?.duration, 7200);
    assert.strictEqual(decoded.profile.session?.tokenLimit, 50000);
    assert.strictEqual(decoded.profile.session?.imageLimit, 10);
  });

  it('round-trips new service fields', () => {
    const cmm = buildAgentContentMultimap(undefined, [{
      name: 'Premium Service',
      price: 5,
      currency: 'VRSC',
      paymentTerms: 'prepay' as const,
      privateMode: true,
      sovguard: false,
    }]);
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.services.length, 1);
    assert.strictEqual(decoded.services[0].name, 'Premium Service');
    assert.strictEqual(decoded.services[0].paymentTerms, 'prepay');
    assert.strictEqual(decoded.services[0].privateMode, true);
    assert.strictEqual(decoded.services[0].sovguard, false);
  });

  it('round-trips multiple services', () => {
    const cmm = buildAgentContentMultimap(undefined, [
      { name: 'Svc1', price: 1, currency: 'VRSC' },
      { name: 'Svc2', price: 2, currency: 'VRSC', sovguard: true },
    ]);
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.services.length, 2);
    assert.strictEqual(decoded.services[0].name, 'Svc1');
    assert.strictEqual(decoded.services[1].name, 'Svc2');
    assert.strictEqual(decoded.services[1].sovguard, true);
  });
});

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
