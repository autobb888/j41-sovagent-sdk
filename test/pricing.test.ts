import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { estimateJobCost, recommendPrice, privacyPremium } = require('../dist/pricing/calculator.js');
const { PLATFORM_FEE, CATEGORY_MARKUPS, LLM_COSTS } = require('../dist/pricing/tables.js');

describe('Pricing Calculator', () => {
  it('estimateJobCost returns correct cost for known model+category', () => {
    // gpt-4o: input 0.0025/1k, output 0.01/1k
    const cost = estimateJobCost('gpt-4o', 2000, 1000);
    // (2000/1000)*0.0025 + (1000/1000)*0.01 = 0.005 + 0.01 = 0.015
    assert.strictEqual(cost, 0.015);
  });

  it('recommendPrice: min < recommended < premium < ceiling', () => {
    const rec = recommendPrice({
      model: 'gpt-4o',
      inputTokens: 2000,
      outputTokens: 1000,
      category: 'medium',
    });
    assert.ok(rec.minimum.usd < rec.recommended.usd, 'min < recommended');
    assert.ok(rec.recommended.usd < rec.premium.usd, 'recommended < premium');
    assert.ok(rec.premium.usd < rec.ceiling.usd, 'premium < ceiling');
  });

  it('privacyPremium standard = 1.0x', () => {
    assert.strictEqual(privacyPremium(100, 'standard'), 100);
  });

  it('privacyPremium private = 1.33x', () => {
    assert.strictEqual(privacyPremium(100, 'private'), 133);
  });

  it('privacyPremium sovereign = 1.83x', () => {
    const result = privacyPremium(100, 'sovereign');
    assert.ok(Math.abs(result - 183) < 0.01, `Expected ~183, got ${result}`);
  });

  it('unknown model throws', () => {
    assert.throws(
      () => estimateJobCost('nonexistent-model', 1000, 1000),
      /Unknown model/,
    );
  });

  it('all 5 categories produce valid results', () => {
    const categories = ['trivial', 'simple', 'medium', 'complex', 'premium'];
    for (const category of categories) {
      const rec = recommendPrice({
        model: 'gpt-4o',
        inputTokens: 2000,
        outputTokens: 1000,
        category,
      });
      assert.ok(rec.minimum.usd > 0, `${category}: min should be > 0`);
      assert.ok(rec.recommended.usd > 0, `${category}: recommended should be > 0`);
      assert.ok(rec.rawCost > 0, `${category}: rawCost should be > 0`);
    }
  });

  it('platform fee is 5%', () => {
    assert.strictEqual(PLATFORM_FEE, 0.05, 'PLATFORM_FEE should be 0.05');
  });
});
