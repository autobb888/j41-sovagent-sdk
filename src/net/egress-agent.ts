import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { Duplex } from 'node:stream';

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
    options: http.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const targetHost = (options.host as string) || '';
    const targetPort = (options.port as number) || 443;
    connectThroughProxy({ ...this.egress, targetHost, targetPort })
      .then((raw) => {
        const tlsSocket = tls.connect({ socket: raw, servername: targetHost });
        tlsSocket.once('secureConnect', () => callback?.(null, tlsSocket));
        tlsSocket.once('error', (e) => { raw.destroy(); callback?.(e, null as unknown as Duplex); });
      })
      .catch((err) => callback?.(err, null as unknown as Duplex));
    return undefined;
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
