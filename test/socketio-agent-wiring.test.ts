import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const SITES = [
  'src/chat/client.ts',
  'src/workspace/client.ts',
  'src/buyer/workspace.ts',
];

for (const rel of SITES) {
  test(`${rel} passes agent: getEgressSocketAgent() to io()`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /getEgressSocketAgent/, `${rel} does not import/use getEgressSocketAgent`);
    // The agent option must appear inside an io(...) options object.
    assert.match(src, /agent:\s*getEgressSocketAgent\(\)/, `${rel} does not pass agent: getEgressSocketAgent()`);
  });
}
