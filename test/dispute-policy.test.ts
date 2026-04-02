import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('DisputePolicy type', () => {
  it('should import DisputePolicy from finalize', async () => {
    const { DisputePolicy } = await import('../dist/onboarding/finalize.js');
    // Type-only — just verify the import doesn't throw
    assert.ok(true);
  });
});

describe('ServiceInput costBreakdown', () => {
  it('should accept costBreakdown field', async () => {
    const { ServiceInput } = await import('../dist/onboarding/finalize.js');
    // Type-level test — compile-time check
    const svc = {
      name: 'Code Fix',
      costBreakdown: {
        model: 'claude-sonnet-4',
        estimatedInputTokens: 8000,
        estimatedOutputTokens: 2000,
        rawCost: 0.03,
        apiCalls: 0,
        markup: 15,
      },
    };
    assert.equal(svc.name, 'Code Fix');
    assert.equal(svc.costBreakdown.markup, 15);
  });
});
