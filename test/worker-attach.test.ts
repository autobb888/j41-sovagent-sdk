import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { J41Client } = require('../dist/client/index.js');

function stubClient() {
  const c = new J41Client({ apiUrl: 'https://api.example.com' });
  const calls: any[] = [];
  (c as any).request = async (method: string, path: string, body: unknown) => {
    calls.push({ method, path, body });
    return { data: { id: 'job-1', status: 'in_progress' } };
  };
  return { c, calls };
}

describe('worker-attach client methods', () => {
  it('confirmWorkerAttached POSTs /worker-attached with empty body, returns data', async () => {
    const { c, calls } = stubClient();
    const r = await c.confirmWorkerAttached('job-1');
    assert.deepEqual(calls[0], { method: 'POST', path: '/v1/jobs/job-1/worker-attached', body: {} });
    assert.deepEqual(r, { id: 'job-1', status: 'in_progress' });
  });

  it('reportWorkerAttachFailed POSTs /worker-attach-failed with {reason}', async () => {
    const { c, calls } = stubClient();
    await c.reportWorkerAttachFailed('job-1', 'spawn-error: boom');
    assert.deepEqual(calls[0], { method: 'POST', path: '/v1/jobs/job-1/worker-attach-failed', body: { reason: 'spawn-error: boom' } });
  });

  it('encodes the jobId in the path', async () => {
    const { c, calls } = stubClient();
    await c.confirmWorkerAttached('a/b');
    assert.equal(calls[0].path, '/v1/jobs/a%2Fb/worker-attached');
  });
});
