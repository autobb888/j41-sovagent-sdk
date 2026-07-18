import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DisputeDetail } from '../src/client/index.js';
import type { JobHandler } from '../src/jobs/types.js';

describe('dispute deadline types', () => {
  it('DisputeDetail carries the deadline fields', () => {
    const d: DisputeDetail = {
      jobId: 'j', status: 'open', reason: 'r', filedBy: 'b', filedAt: 't',
      deadline_at: '2026-07-21T00:00:00Z', deadline_owner: 'seller', deadline_passed: false,
    };
    assert.equal(d.deadline_owner, 'seller');
  });
  it('onJobDisputed accepts a deadline arg', async () => {
    const h: JobHandler = { onJobDisputed: async (_job, _reason, deadline) => { assert.equal(typeof deadline, 'string'); } };
    await h.onJobDisputed!({ id: 'j' } as any, 'reason', '2026-07-21T00:00:00Z');
  });
});
