/**
 * TDD: computeExpiryHeight helper — RED first, then GREEN after implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { computeExpiryHeight } = require('../dist/agent.js');

test('computeExpiryHeight adds the delta to the tip', () => {
  assert.equal(computeExpiryHeight(1000, 60), 1060);
  assert.equal(computeExpiryHeight(undefined, 60), undefined); // no tip → let builder fall back
});

test('computeExpiryHeight works with IDENTITY_EXPIRY_DELTA (200)', () => {
  assert.equal(computeExpiryHeight(5000, 200), 5200);
});

test('computeExpiryHeight returns undefined for non-integer tip', () => {
  assert.equal(computeExpiryHeight(null as any, 60), undefined);
  assert.equal(computeExpiryHeight(NaN as any, 60), undefined);
  assert.equal(computeExpiryHeight(1.5 as any, 60), undefined);
});
