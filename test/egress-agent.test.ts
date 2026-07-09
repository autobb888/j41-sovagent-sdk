import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
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

test('EgressConnectAgent pins servername to the target and never disables cert validation', async () => {
  const echo = await startEcho();
  const proxy = await startStubProxy(`127.0.0.1:${echo.port}`, 'tok');
  const orig = tls.connect as any;
  let seen: any = null;
  (tls as any).connect = (opts: any) => {
    seen = opts;
    const s: any = new EventEmitter();
    s.destroy = () => {};
    setImmediate(() => s.emit('secureConnect'));
    return s;
  };
  try {
    const agent = new EgressConnectAgent({ proxyHost: '127.0.0.1', proxyPort: proxy.port, token: 'tok' });
    await new Promise<void>((resolve, reject) => {
      (agent as any).createConnection({ host: '127.0.0.1', port: echo.port }, (err: Error | null) => err ? reject(err) : resolve());
    });
    assert.strictEqual(seen.servername, '127.0.0.1', 'servername must be pinned to the target host');
    assert.notStrictEqual(seen.rejectUnauthorized, false, 'must never disable cert validation');
  } finally {
    (tls as any).connect = orig;
    // The stub tls.connect never wraps/owns the real tunneled socket the way real
    // TLS does, so destroy it explicitly to avoid a leaked handle keeping the loop alive.
    seen?.socket?.destroy?.();
    echo.close(); proxy.close();
  }
});
