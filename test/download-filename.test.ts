// j41-sovagent-sdk/test/download-filename.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
process.env.J41_ALLOW_INSECURE = '1';
const require = createRequire(import.meta.url);
const { J41Agent } = require('../dist/agent.js');

describe('downloadFileTo filename', () => {
  it('writes basename only and never leaves outputDir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dl-'));
    const files = path.join(dir, 'files');
    fs.mkdirSync(files);
    const agent = new J41Agent({ apiUrl: 'http://127.0.0.1' });
    agent.downloadFile = async () => ({
      data: Buffer.from('x'),
      filename: '../../sign/req/abcd1234.json',
      mimeType: 'application/json',
      checksum: '',
    });
    const out = await agent.downloadFileTo('job', 'fid', files);
    assert.equal(path.dirname(fs.realpathSync(out)), fs.realpathSync(files));
    assert.ok(!fs.existsSync(path.join(dir, 'sign', 'req', 'abcd1234.json')));
    assert.equal(path.basename(out), 'abcd1234.json');
  });
});
