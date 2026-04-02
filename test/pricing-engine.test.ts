import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('calculateListedPrice', () => {
  it('should apply markup to raw cost', async () => {
    const { calculateListedPrice } = await import('../dist/pricing/calculator.js');

    const result = calculateListedPrice({
      model: 'claude-sonnet-4.6',
      inputTokens: 8000,
      outputTokens: 2000,
      markupPercent: 15,
    });

    assert.ok(result.rawCost > 0);
    assert.ok(result.listedPrice > result.rawCost);
    assert.equal(result.markupPercent, 15);
    const expected = result.rawCost * 1.15;
    assert.ok(Math.abs(result.listedPrice - expected) < 0.000001);
  });

  it('should include API costs', async () => {
    const { calculateListedPrice } = await import('../dist/pricing/calculator.js');

    const withApi = calculateListedPrice({
      model: 'claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 1000,
      markupPercent: 10,
      additionalApis: [{ api: 'web-search', count: 4 }],
    });

    const withoutApi = calculateListedPrice({
      model: 'claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 1000,
      markupPercent: 10,
    });

    assert.ok(withApi.rawCost > withoutApi.rawCost);
  });

  it('should reject markup outside 1-50 range', async () => {
    const { calculateListedPrice } = await import('../dist/pricing/calculator.js');

    assert.throws(() => calculateListedPrice({
      model: 'claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 1000,
      markupPercent: 0,
    }), /markup/i);

    assert.throws(() => calculateListedPrice({
      model: 'claude-sonnet-4.6',
      inputTokens: 1000,
      outputTokens: 1000,
      markupPercent: 51,
    }), /markup/i);
  });
});

describe('budgetToTokens', () => {
  it('should convert USD budget to estimated token count using blended rate', async () => {
    const { budgetToTokens } = await import('../dist/pricing/calculator.js');

    const tokens = budgetToTokens('claude-sonnet-4.6', 0.10);
    assert.ok(tokens > 0);
    assert.ok(Number.isFinite(tokens));
  });

  it('should throw for unknown model', async () => {
    const { budgetToTokens } = await import('../dist/pricing/calculator.js');

    assert.throws(() => budgetToTokens('nonexistent-model', 0.10), /Unknown model/);
  });

  it('should throw for non-positive budget', async () => {
    const { budgetToTokens } = await import('../dist/pricing/calculator.js');

    assert.throws(() => budgetToTokens('claude-sonnet-4.6', 0), /budget/i);
    assert.throws(() => budgetToTokens('claude-sonnet-4.6', -1), /budget/i);
  });
});
