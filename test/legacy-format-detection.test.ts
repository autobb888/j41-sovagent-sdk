import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { decodeContentMultimap, VDXF_KEYS, PARENT_KEYS, makeSubDD } =
  require('../dist/onboarding/vdxf.js');

/**
 * `isLegacyFormat` used to return true whenever the legacy agent parent key was
 * present. That key is effectively PERMANENT for any identity created before the
 * 2026-03-28 flat migration, because `getMyIdentity` / `getidentitycontent`
 * return the AGGREGATED history — a key written in March is still in the map
 * today and always will be.
 *
 * Live consequence (2026-08-04): agents 1-5 (pre-migration) reported
 * "no dispute policy on-chain — disputes will log only" while the flat key was
 * present and well-formed on every one of them. Agents 6/7/11/url2
 * (post-migration) decoded fine. Clean 5/4 split. Their display names were being
 * dropped by the same route.
 */

const A = VDXF_KEYS.agent;
const policy = JSON.stringify({
  defaultAction: 'rework', maxRefundPercent: 100, maxReworkCycles: 2,
  reworkBudgetPercent: 30, escalateAfter: 'max_rework', systemCrashRefund: 100,
});

describe('legacy-vs-flat contentmultimap detection', () => {
  it('decodes flat keys even when a historical legacy parent key is present', () => {
    const cmm = {
      [PARENT_KEYS.agent]: [makeSubDD(PARENT_KEYS.agent, 'stale march-era container')],
      [A.displayName]: [makeSubDD(A.displayName, 'DT3 Worker 1')],
      [A.disputePolicy]: [makeSubDD(A.disputePolicy, policy)],
    };
    const decoded = decodeContentMultimap(cmm);
    assert.ok(decoded.disputePolicy, 'flat disputePolicy must decode despite the legacy key');
    assert.strictEqual(decoded.disputePolicy.defaultAction, 'rework');
    assert.strictEqual(decoded.profile.name, 'DT3 Worker 1');
  });

  it('still uses the legacy decoder when there are NO flat agent keys', () => {
    // A genuinely un-migrated identity must not regress.
    const cmm = { [PARENT_KEYS.agent]: [makeSubDD(PARENT_KEYS.agent, 'legacy only')] };
    const decoded = decodeContentMultimap(cmm);
    assert.ok(decoded, 'legacy path must still run');
    assert.strictEqual(decoded.disputePolicy, undefined);
  });

  it('takes the LAST entry when aggregation has accumulated many copies', () => {
    // getidentitycontent appends one entry per key per update, so an active
    // agent accumulates dozens. Latest wins.
    const many = Array.from({ length: 11 }, (_, i) =>
      makeSubDD(A.displayName, `name-${i}`));
    const cmm = {
      [PARENT_KEYS.agent]: [makeSubDD(PARENT_KEYS.agent, 'stale')],
      [A.displayName]: many,
      [A.disputePolicy]: [makeSubDD(A.disputePolicy, policy)],
    };
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.name, 'name-10');
    assert.ok(decoded.disputePolicy);
  });

  it('a purely flat identity is unaffected', () => {
    const cmm = {
      [A.displayName]: [makeSubDD(A.displayName, 'Shreck the Ogre')],
      [A.disputePolicy]: [makeSubDD(A.disputePolicy, policy)],
    };
    const decoded = decodeContentMultimap(cmm);
    assert.strictEqual(decoded.profile.name, 'Shreck the Ogre');
    assert.strictEqual(decoded.disputePolicy.defaultAction, 'rework');
  });
});
