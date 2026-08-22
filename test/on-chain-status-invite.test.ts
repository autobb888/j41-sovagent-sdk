import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('setOnChainStatus TypeScript union includes invite', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/agent.ts'), 'utf8');
  const fn = src.indexOf('async setOnChainStatus');
  assert.ok(fn > 0);
  const slice = src.slice(fn, fn + 200);
  assert.match(slice, /'invite'/);
  const priv = src.indexOf('_updateOnChainStatus');
  assert.match(src.slice(priv, priv + 220), /'invite'/);
});
