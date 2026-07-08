# SDK socket.io Egress-Proxy Tunneling — Design

**Date:** 2026-07-08
**Status:** Approved for planning
**Repo:** `@junction41/sovagent-sdk`
**Origin:** First live E2E (2026-07-08) — job #3 delivered the error-handler string instead of real LLM output because the worker's chat WebSocket could not connect from inside a gVisor job container. See dispatcher memory `project_e2e_bugs_0708`.

---

## Problem

J41 dispatcher job containers are DNS-less by design (`Dns: ['0.0.0.0']`) and reach the network **only** through the host egress proxy (HTTP `CONNECT`, per-job Bearer token, TLS passthrough). The dispatcher's `egress-proxy-client` routes HTTP by overriding `globalThis.fetch` with an undici `ProxyAgent`. That covers the SDK's REST calls — but **not** its real-time sockets.

The SDK opens **socket.io-client** connections in three places, and each opens its **own** TCP/TLS socket via engine.io's transports (`ws` for `websocket`, an XHR polyfill for `polling`) — neither uses `globalThis.fetch`, so the egress-proxy override does not catch them. In a job container they attempt a direct DNS lookup, get `EAI_AGAIN`, and fail. Result: chat (and workspace) never connect; the worker falls back to an error string.

Backend confirmed the platform WS rail is healthy (external socket.io probe reaches the auth layer) — the fix is **purely client-side (SDK)**.

## Root cause (confirmed in code)

- `src/chat/client.ts` → `io(apiUrl, { path: '/ws', transports: ['websocket','polling'], ... })`
- `src/workspace/client.ts` → `io(origin + '/jailbox', {...})`
- `src/buyer/workspace.ts` → `io(apiUrl + '/jailbox', {...})`

All connect to the **same host as `apiUrl`** (`api.junction41.io`), which is already in the dispatcher's egress allowlist (`deriveAllowedHosts` derives it from `J41_API_URL`). The only gap is that socket.io's transport never goes through the proxy.

## Approach (chosen)

Give socket.io an HTTP **`agent`** that tunnels through the egress proxy via `CONNECT`. socket.io-client (`^4.8.3`) forwards an `agent` option to engine.io and on to both the `websocket` and `polling` transports, so one agent covers both.

Implement the agent ourselves — **no new dependency** (rejected: `https-proxy-agent`, to keep the SDK dep surface minimal; the tunnel is small and we control it). This mirrors the tunnel the egress proxy already performs for the HTTPS `fetch` path (TLS passthrough, no MITM), just from Node's `https.Agent` side.

**Safety (why a hand-rolled CONNECT agent is safe here):** the proxy is a blind byte tunnel; after `CONNECT`, the container performs a **normal end-to-end TLS handshake directly with `api.junction41.io`**, with full cert validation. The agent never sees plaintext and cannot MITM. Two invariants make it safe and are mandatory:
1. **Fail closed:** any non-`200` CONNECT reply (denied host, bad/absent token) or timeout → destroy the socket and error the connection. Never fall back to a direct connection.
2. **Pin `servername`** to the target host on the TLS upgrade, and leave `rejectUnauthorized` at its secure default — so certificate validation is against the real server, not the proxy.

## Components

### `src/net/egress-agent.ts` (new)

- **`getEgressSocketAgent(env = process.env): https.Agent | undefined`**
  - If `env.J41_EGRESS_PROXY` is **unset** → return `undefined`. socket.io then behaves exactly as today (zero change outside job containers). This is the default for all non-container SDK usage.
  - If set → parse the proxy URL (`http://<host>:<port>`), read `env.J41_EGRESS_TOKEN`, and return an `EgressConnectAgent`.

- **`class EgressConnectAgent extends https.Agent`** — overrides `createConnection(options, callback)`:
  1. `net.connect(proxyPort, proxyHost)` — TCP to the proxy.
  2. On connect, write:
     ```
     CONNECT <options.host>:<options.port || 443> HTTP/1.1
     Host: <options.host>:<options.port || 443>
     Proxy-Authorization: Bearer <token>
     \r\n
     ```
  3. Read the proxy's HTTP response. On `HTTP/1.1 200` → `tls.connect({ socket, servername: options.host }, ...)`, pass the resulting TLS socket to `callback(null, tlsSocket)`. On any non-200, parse error, or connect/socket timeout → `socket.destroy()` and `callback(new Error(...))` (fail closed).
  - Reuse note: set the agent so sockets are not pooled across hosts in a way that would send a stale `CONNECT` target — simplest is `keepAlive: false` (a fresh tunnel per connection); revisit pooling only if it matters for perf.

### Wiring (3 call sites)

Each `io(url, opts)` gains `agent: getEgressSocketAgent()` in its options object. No other change to those files.
- `src/chat/client.ts` (chat, `/ws`)
- `src/workspace/client.ts` (agent workspace relay, `/jailbox`)
- `src/buyer/workspace.ts` (buyer workspace, `/jailbox`)

(Jailbox is currently parked/default-off, but the two workspace sites get the same treatment for consistency so the whole class is closed once.)

## Error handling

- CONNECT non-200 / timeout / socket error → connection fails closed with a clear error; socket.io surfaces it as a connect error (chat's existing `onReconnectFailed` / connect-timeout paths handle it). No silent direct-connect fallback.
- Proxy unset → `undefined` agent → unchanged behavior (no proxy assumed outside containers).

## Testing

Unit tests for `EgressConnectAgent`/`getEgressSocketAgent`, run against a real `EgressProxyHost` (from the dispatcher; started in-test on a loopback port with a known token + allowlist):
1. `J41_EGRESS_PROXY` unset → `getEgressSocketAgent()` returns `undefined`.
2. Tunneled HTTPS GET to an **allowlisted** host through the agent → succeeds (200, real bytes), proving CONNECT+TLS end-to-end.
3. **Denied** host → connection fails closed (error, no data).
4. **Bad/absent token** → fails closed.
5. TLS `servername` is the target host (cert validation against the real server) — assert by connecting to a host whose cert must match.

A socket.io round-trip through the proxy is the integration proof; include it if a lightweight socket.io server fixture is feasible, otherwise rely on the agent-level tests + the live re-run.

## Rollout

1. SDK: implement + build (`npm run build` → `dist`), bump version, publish (or use the dispatcher's local-SDK build path `J41_USE_LOCAL_SDK=1` for validation).
2. Dispatcher: rebuild the job-agent image so containers bundle the new SDK (`scripts/build-image.sh`).
3. Re-run a live job; confirm the worker's chat connects and delivers real LLM output (job #3's original failure).

## Global constraints

- **No new runtime dependency.** Custom agent using Node built-ins (`net`, `tls`, `https`).
- **Fail-closed:** never fall back to a direct (non-proxied) connection when the proxy is configured but the tunnel fails.
- **No allowlist change** — chat/workspace use the `apiUrl` host, already allowlisted by the dispatcher.
- **Zero behavior change when `J41_EGRESS_PROXY` is unset** — the agent is `undefined` and socket.io is untouched.
- **TLS stays end-to-end** to the target host with `servername` pinned and default cert validation; the proxy never sees plaintext.
- TypeScript source in `src/` is the source of truth; `dist/` is built output.
