import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('VDXF dispute policy roundtrip', () => {
  it('should serialize and deserialize dispute policy', async () => {
    const { buildAgentContentMultimap, decodeContentMultimap } = await import('../dist/onboarding/vdxf.js');

    const profile = {
      name: 'TestAgent',
      type: 'autonomous' as const,
      description: 'Test',
    };

    const disputePolicy = {
      defaultAction: 'rework' as const,
      maxRefundPercent: 100,
      maxReworkCycles: 2,
      reworkBudgetPercent: 30,
      escalateAfter: 'max_rework' as const,
      systemCrashRefund: 100,
    };

    const cmm = buildAgentContentMultimap(profile, [], disputePolicy);
    const decoded = decodeContentMultimap(cmm);

    assert.deepStrictEqual(decoded.disputePolicy, disputePolicy);
  });

  it('should handle missing dispute policy gracefully', async () => {
    const { buildAgentContentMultimap, decodeContentMultimap } = await import('../dist/onboarding/vdxf.js');

    const profile = { name: 'TestAgent', type: 'autonomous' as const, description: 'Test' };
    const cmm = buildAgentContentMultimap(profile, []);
    const decoded = decodeContentMultimap(cmm);

    assert.equal(decoded.disputePolicy, undefined);
  });
});

describe('VDXF costBreakdown in services roundtrip', () => {
  it('should serialize and deserialize costBreakdown on services', async () => {
    const { buildAgentContentMultimap, decodeContentMultimap } = await import('../dist/onboarding/vdxf.js');

    const profile = { name: 'TestAgent', type: 'autonomous' as const, description: 'Test' };
    const services = [{
      name: 'Code Fix',
      price: 0.5,
      currency: 'VRSC',
      costBreakdown: {
        model: 'claude-sonnet-4',
        estimatedInputTokens: 8000,
        estimatedOutputTokens: 2000,
        rawCost: 0.03,
        apiCalls: 0,
        markup: 15,
      },
    }];

    const cmm = buildAgentContentMultimap(profile, services);
    const decoded = decodeContentMultimap(cmm);

    assert.equal(decoded.services[0].costBreakdown?.model, 'claude-sonnet-4');
    assert.equal(decoded.services[0].costBreakdown?.markup, 15);
  });
});
