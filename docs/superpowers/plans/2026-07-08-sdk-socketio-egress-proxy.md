# SDK socket.io Egress-Proxy Tunneling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the SDK's socket.io connections (chat + both workspace surfaces) through the dispatcher's host egress proxy via an HTTP CONNECT agent, so real-time sockets work inside DNS-less gVisor job containers.

**Architecture:** A new, dependency-free `getEgressSocketAgent()` returns an `https.Agent` (`EgressConnectAgent`) that tunnels each connection through `J41_EGRESS_PROXY` (HTTP CONNECT + `Proxy-Authorization: Bearer <J41_EGRESS_TOKEN>`, then end-to-end TLS to the real host). It's passed as the `agent` option to all three `io(...)` calls. When `J41_EGRESS_PROXY` is unset it returns `undefined` — socket.io is untouched.

**Tech Stack:** TypeScript (`src/` → `tsc` → `dist/`), Node built-ins (`net`, `tls`, `https`), socket.io-client `^4.8.3`, test runner `npx tsx --test test/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-07-08-sdk-socketio-egress-proxy-design.md`.

## Global Constraints

- **No new runtime dependency** — Node built-ins only (`net`, `tls`, `https`).
- **Fail closed** — any non-`200` CONNECT reply, parse failure, or timeout → error the connection; never fall back to a direct (non-proxied) connection.
- **Pin TLS `servername`** to the target host and keep `rejectUnauthorized` at its secure default (never disable it in shipped code) — cert validation is against the real server, not the proxy.
- **Zero behavior change when `J41_EGRESS_PROXY` is unset** — `getEgressSocketAgent()` returns `undefined`; the `io()` calls receive `agent: undefined`, identical to today.
- **No allowlist change** — chat/workspace connect to the `apiUrl` host, already allowlisted by the dispatcher's `deriveAllowedHosts`.
- TypeScript `src/` is the source of truth; `dist/` is built output (`npm run build`). Every task must keep `npx tsc --noEmit` clean.

---

### Task 1: `EgressConnectAgent` + `getEgressSocketAgent()`

The dependency-free CONNECT-tunnel agent and its factory, with unit tests against an in-test stub CONNECT proxy (no cross-repo coupling).

**Files:**
- Create: `src/net/egress-agent.ts`
- Test: `test/egress-agent.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getEgressSocketAgent(env?: NodeJS.ProcessEnv): https.Agent | undefined`
  - `class EgressConnectAgent extends https.Agent` (constructed with `{ proxyHost, proxyPort, token }`)
  - `connectThroughProxy(o: { proxyHost, proxyPort, token, targetHost, targetPort, timeoutMs? }): Promise<net.Socket>` — resolves the raw (pre-TLS) tunneled socket on `200`, rejects otherwise.

- [ ] **Step 1: Write the failing test**

Create `test/egress-agent.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import { getEgressSocketAgent, connectThroughProxy, EgressConnectAgent } from '../src/net/egress-agent.js';

// A stub HTTP CONNECT proxy: accepts CONNECT to `allow` with the right Bearer
// token and tunnels to the target; otherwise replies 403.
function startStubProxy(allow: string, token: string): Promise<{ port: number; close: () => void }> {
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket) => {
    const okAuth = req.headers['proxy-authorization'] === `Bearer ${token}`;
    if (!okAuth || req.url !== allow) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }
    const [host, port] = req.url!.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.end());
  });
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => {
    resolve({ port: (proxy.address() as net.AddressInfo).port, close: () => proxy.close() });
  }));
}

// A plain TCP echo server as the tunnel target (CONNECT-layer tests need no TLS).
function startEcho(): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((s) => s.pipe(s));
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() });
  }));
}

test('getEgressSocketAgent returns undefined when J41_EGRESS_PROXY is unset', () => {
  assert.strictEqual(getEgressSocketAgent({}), undefined);
});

test('getEgressSocketAgent returns an EgressConnectAgent when configured', () => {
  const a = getEgressSocketAgent({ J41_EGRESS_PROXY: 'http://127.0.0.1:9847', J41_EGRESS_TOKEN: 't' });
  assert.ok(a instanceof EgressConnectAgent);
});

test('connectThroughProxy tunnels to an allowlisted target on 200', async () => {
  const echo = await startEcho();
  const proxy = await startStubProxy(`127.0.0.1:${echo.port}`, 'tok');
  try {
    const sock = await connectThroughProxy({
      proxyHost: '127.0.0.1', proxyPort: proxy.port, token: 'tok',
      targetHost: '127.0.0.1', targetPort: echo.port,
    });
    const round = await new Promise<string>((resolve) => {
      sock.once('data', (d) => resolve(d.toString()));
      sock.write('ping');
    });
    assert.strictEqual(round, 'ping');
    sock.destroy();
  } finally { echo.close(); proxy.close(); }
});

test('connectThroughProxy FAILS CLOSED on a denied host (403)', async () => {
  const proxy = await startStubProxy('127.0.0.1:1', 'tok'); // allow a different host:port
  try {
    await assert.rejects(connectThroughProxy({
      proxyHost: '127.0.0.1', proxyPort: proxy.port, token: 'tok',
      targetHost: '127.0.0.1', targetPort: 65000,
    }), /refused/i);
  } finally { proxy.close(); }
});

test('connectThroughProxy FAILS CLOSED on a bad token', async () => {
  const echo = await startEcho();
  const proxy = await startStubProxy(`127.0.0.1:${echo.port}`, 'right');
  try {
    await assert.rejects(connectThroughProxy({
      proxyHost: '127.0.0.1', proxyPort: proxy.port, token: 'WRONG',
      targetHost: '127.0.0.1', targetPort: echo.port,
    }), /refused/i);
  } finally { echo.close(); proxy.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/egress-agent.test.ts`
Expected: FAIL — cannot find module `../src/net/egress-agent.js` (source not created yet). Note: imports use the `.js` specifier even though the source is `.ts` (repo convention).

- [ ] **Step 3: Implement `src/net/egress-agent.ts`**

```ts
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

interface EgressOpts { proxyHost: string; proxyPort: number; token: string; }

/**
 * Open an HTTP CONNECT tunnel through the egress proxy to targetHost:targetPort.
 * Resolves the raw (pre-TLS) socket on `200`; rejects (fail-closed) on any
 * non-200 reply, parse failure, or timeout. The proxy is a blind byte tunnel —
 * TLS is layered on top by the caller, end-to-end to the real target.
 */
export function connectThroughProxy(o: {
  proxyHost: string; proxyPort: number; token: string;
  targetHost: string; targetPort: number; timeoutMs?: number;
}): Promise<net.Socket> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(o.proxyPort, o.proxyHost);
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; socket.destroy(); reject(e); } };
    const timer = setTimeout(() => fail(new Error('egress CONNECT timeout')), timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => {
      const hp = `${o.targetHost}:${o.targetPort}`;
      socket.write(
        `CONNECT ${hp} HTTP/1.1\r\n` +
        `Host: ${hp}\r\n` +
        `Proxy-Authorization: Bearer ${o.token}\r\n` +
        `\r\n`,
      );
    });
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) { if (buf.length > 8192) fail(new Error('egress CONNECT header too large')); return; }
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/);
      if (!m || m[1] !== '200') { fail(new Error(`egress CONNECT refused: ${statusLine}`)); return; }
      clearTimeout(timer);
      settled = true;
      socket.removeListener('error', fail);
      resolve(socket);
    };
    socket.on('data', onData);
  });
}

/**
 * https.Agent that routes every connection through the egress proxy via CONNECT,
 * then performs end-to-end TLS to the real target (servername pinned).
 */
export class EgressConnectAgent extends https.Agent {
  private egress: EgressOpts;
  constructor(egress: EgressOpts) {
    super({ keepAlive: false });
    this.egress = egress;
  }
  // Node calls this to create the underlying socket for each request.
  createConnection(
    options: { host?: string; port?: number },
    callback: (err: Error | null, socket?: net.Socket) => void,
  ): void {
    const targetHost = options.host || '';
    const targetPort = options.port || 443;
    connectThroughProxy({ ...this.egress, targetHost, targetPort })
      .then((raw) => {
        const tlsSocket = tls.connect({ socket: raw, servername: targetHost });
        tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
        tlsSocket.once('error', (e) => { raw.destroy(); callback(e); });
      })
      .catch((err) => callback(err));
  }
}

/**
 * Returns an https.Agent that tunnels socket.io through the host egress proxy
 * when the dispatcher has configured one (J41_EGRESS_PROXY + J41_EGRESS_TOKEN),
 * or undefined otherwise (socket.io behaves exactly as today).
 */
export function getEgressSocketAgent(env: NodeJS.ProcessEnv = process.env): https.Agent | undefined {
  const uri = env.J41_EGRESS_PROXY;
  if (!uri) return undefined;
  let u: URL;
  try { u = new URL(uri); } catch { return undefined; }
  return new EgressConnectAgent({
    proxyHost: u.hostname,
    proxyPort: Number(u.port) || 80,
    token: env.J41_EGRESS_TOKEN || '',
  });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsc --noEmit && npx tsx --test test/egress-agent.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/net/egress-agent.ts test/egress-agent.test.ts
git commit -m "feat(net): dependency-free egress CONNECT agent for socket.io tunneling"
```

---

### Task 2: Wire the agent into all three socket.io sites

**Files:**
- Modify: `src/chat/client.ts` (~line 152, `io(this.config.apiUrl, {...})`)
- Modify: `src/workspace/client.ts` (~line 244, `io(origin + '/jailbox', {...})`)
- Modify: `src/buyer/workspace.ts` (~line 217, `io(apiUrl + '/jailbox', {...})`)
- Test: `test/socketio-agent-wiring.test.ts` (new — source-level assertion)

**Interfaces:**
- Consumes: `getEgressSocketAgent` from `src/net/egress-agent.ts` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/socketio-agent-wiring.test.ts` (the `io()` calls live inside async connect methods that require a live server, so a source-level assertion is the pragmatic pin; the true integration proof is the live re-run in Rollout):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/socketio-agent-wiring.test.ts`
Expected: FAIL for all three — the agent isn't wired yet.

- [ ] **Step 3: Add the import + `agent` option at each site**

At the top of each of the three files, add (matching the existing relative-import style; adjust the `../` depth per file — `chat/` and `workspace/` and `buyer/` are all one level under `src/`, so `../net/egress-agent.js`):

```ts
import { getEgressSocketAgent } from '../net/egress-agent.js';
```

Then add `agent: getEgressSocketAgent(),` into each `io(url, { ... })` options object:

`src/chat/client.ts` (~152):
```ts
      this.socket = io(this.config.apiUrl, {
        path: '/ws',
        agent: getEgressSocketAgent(),
        auth: { token: chatToken },
        // ...existing options unchanged...
```

`src/workspace/client.ts` (~244):
```ts
      this.socket = io(origin + '/jailbox', {
        agent: getEgressSocketAgent(),
        // ...existing options unchanged...
```

`src/buyer/workspace.ts` (~217):
```ts
      this.socket = io(apiUrl + '/jailbox', {
        agent: getEgressSocketAgent(),
        // ...existing options unchanged...
```

Note on types: socket.io-client's options type may not list `agent` explicitly; it's a valid engine.io option forwarded to the transports. If `tsc` rejects the property, cast the options object with `as any` at that call (only the options literal — do not weaken types elsewhere), mirroring the existing `maxPayload ... as any` cast already used in `chat/client.ts`.

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npx tsc --noEmit && npx tsx --test test/socketio-agent-wiring.test.ts && npx tsx --test test/*.test.ts`
Expected: PASS (3 wiring tests + the full existing suite green).

- [ ] **Step 5: Commit**

```bash
git add src/chat/client.ts src/workspace/client.ts src/buyer/workspace.ts test/socketio-agent-wiring.test.ts
git commit -m "feat(socketio): tunnel chat + workspace sockets through the egress proxy agent"
```

---

### Task 3: Build `dist/` and bump the SDK version

So the dispatcher's job-agent image can consume the fix.

**Files:**
- Modify: `package.json` (version)
- Build output: `dist/**` (generated)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: a built, version-bumped SDK.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `tsc` completes with no errors; `dist/net/egress-agent.js` exists and `dist/chat/client.js` contains `getEgressSocketAgent`.

Verify:
```bash
test -f dist/net/egress-agent.js && grep -q getEgressSocketAgent dist/chat/client.js dist/workspace/client.js dist/buyer/workspace.js && echo OK
```
Expected: `OK`.

- [ ] **Step 2: Bump the patch version**

Read the current version and bump the patch component in `package.json` (e.g. `2.5.1` → `2.5.2`). Use the exact next patch of whatever is currently there.

```bash
node -e "const p=require('./package.json'); const [a,b,c]=p.version.split('.'); p.version=[a,b,Number(c)+1].join('.'); require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n'); console.log('version →', p.version)"
```

- [ ] **Step 3: Commit**

```bash
git add package.json dist
git commit -m "build: socket.io egress tunneling — rebuild dist + bump version"
```

---

## Rollout (post-merge; controller/ops — not a TDD task)

1. **Consume the SDK in the dispatcher's job-agent image.** Use the local-SDK build path so the image bundles this branch without an npm publish: from the dispatcher repo, `J41_USE_LOCAL_SDK=1 J41_SDK_DIR=../j41-sovagent-sdk ./scripts/build-image.sh` (packs the sibling SDK into the image). (Or `npm publish` the SDK and bump the pin in `package.docker.json`.)
2. **Confirm the container env carries the proxy vars** (already wired by the dispatcher): `J41_EGRESS_PROXY` + `J41_EGRESS_TOKEN` are set on job containers today.
3. **Live re-run** — fire a job whose worker chats; confirm the worker connects (no `EAI_AGAIN`) and delivers **real LLM output** (job #3's original failure). This is the socket.io-through-proxy integration proof that unit tests can't fully cover.
4. If `websocket` still struggles in some environment, engine.io falls back to `polling` — both use the same `agent`, so both tunnel; confirm from the worker log which transport connected.

---

## Self-Review

**Spec coverage:**
- `getEgressSocketAgent` + `EgressConnectAgent` + `connectThroughProxy` → Task 1. ✓
- Fail-closed (non-200 / bad token / timeout) → Task 1 tests + implementation. ✓
- `servername` pinning + end-to-end TLS → Task 1 `createConnection`. ✓
- `undefined` when `J41_EGRESS_PROXY` unset → Task 1 factory + test. ✓
- Wire all 3 socket.io sites → Task 2. ✓
- No allowlist change → not needed (documented in Global Constraints). ✓
- No new dependency → Node built-ins only (Global Constraints; Task 1 imports only `net`/`tls`/`https`). ✓
- Build `dist` + version bump for dispatcher consumption → Task 3. ✓
- Live re-run integration proof → Rollout. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; tests have real assertions.

**Type consistency:** `getEgressSocketAgent(env?)`, `EgressConnectAgent({proxyHost,proxyPort,token})`, `connectThroughProxy({proxyHost,proxyPort,token,targetHost,targetPort,timeoutMs?})`, `agent: getEgressSocketAgent()` — used identically across Tasks 1–2. Import path `../net/egress-agent.js` (compiled specifier) consistent at all three sites.
