import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConsentChallengeHash } from '../src/auth/challenge-hash.js';

test('accepts a 64-char hex digest', () => {
  assert.doesNotThrow(() => assertConsentChallengeHash('a'.repeat(64)));
  assert.doesNotThrow(() => assertConsentChallengeHash('0123456789abcdef'.repeat(4)));
});
test('rejects non-hex, wrong length, and non-strings (signing-oracle guard)', () => {
  assert.throws(() => assertConsentChallengeHash('xyz'));
  assert.throws(() => assertConsentChallengeHash('a'.repeat(63)));
  assert.throws(() => assertConsentChallengeHash('a'.repeat(65)));
  assert.throws(() => assertConsentChallengeHash('J41-LOGIN|do something evil'));
  assert.throws(() => assertConsentChallengeHash('legithash\nrm -rf /'));
  // @ts-expect-error non-string
  assert.throws(() => assertConsentChallengeHash(null));
});
