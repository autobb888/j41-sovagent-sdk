# Encrypted Delivery — Interop Harness (box 2)

Proves the Valu wallet's `AppEncryptionRequest` gives us a usable Sapling key
exchange. Run this on the **dispatcher box** — the one with **no Verus daemon**.
That is the point: the agent's encrypt must work without one.

Box 2 plays **both** the buyer's client (holds the ephemeral ivk, decrypts) and
the agent (encrypts the deliverable). Both halves are daemon-less, so one
machine can drive the whole loop while the `bb` backend stays structurally
blind — it relays an opaque blob it cannot read.

## Setup

**`npm install` fresh on this box.** This checkout's `node_modules` is stale
relative to the pinned `verus-typescript-primitives` — do not reuse a copy
carried over from another machine.

```bash
export PATH=/home/bigbox/.local/node/bin:$PATH   # if node/npx are not already on PATH
cd j41-sovagent-sdk
npm install
```

Clone the crypto library **beside the SDK repo checkout** (i.e. as a sibling
of `j41-sovagent-sdk/`, not inside `spike/`) — `dist/` is committed there, so
there's no build step:

```bash
cd ..                          # up to the directory that contains j41-sovagent-sdk
git clone https://github.com/iamahmedshahh/zsupportextension spike-veruscryptolib
cd j41-sovagent-sdk
```

`sapling.mjs` resolves the library at `../../../spike-veruscryptolib/dist/index.es.js`
**relative to the script's own location**, not your current working
directory — so the commands below work from anywhere: the repo root, inside
`spike/encrypted-delivery/`, or any other cwd. What matters is where
`spike-veruscryptolib` is cloned: it must sit beside `j41-sovagent-sdk/` (i.e.
`spike/encrypted-delivery/../../..` from the script). Or skip all of that and
set `ZSUPPORT_LIB` to an absolute path pointing at `dist/index.es.js`.

## Before you scan

**The wallet needs a Z Seed set up for VRSCTEST (Settings → Profile).**
Without one it refuses the request outright — this is a wallet-settings step,
not a question of whether testnet supports shielded sync. Sapling key
*derivation* is pure crypto and needs no chain sync at all. Do this **before**
running `request` — the minted request has a server-defined expiry window
(10 minutes as of this writing — verify with the operator, it may change),
and doing first-time Z-Seed setup in the wallet after you've already scanned
can burn enough of it that a genuinely successful exchange lands after the
window closes and reads as `REQUEST_EXPIRED`. It is the #1 cause of "the
wallet does nothing."

## Auth: bearer token required

`POST /v1/encryption/keyreq` and `GET /v1/encryption/keyreq/:id` both require
an operator bearer token:

```bash
export ENCRYPTION_SPIKE_TOKEN=<token-from-the-bb-operator>
```

The CLI reads this from the environment and fails with a clear message if it
is unset — it will not silently attempt an unauthenticated call. **The
wallet's callback is intentionally NOT gated** (it has no operator token to
present) — that is by design, not an oversight.

If the server itself returns `503 ENCRYPTION_DISABLED`, that means the
*operator* hasn't set `ENCRYPTION_SPIKE_TOKEN` on the backend — a different,
server-side problem from the client-side check above. See the cheatsheet
below.

## Run

The commands below can be run from anywhere (see "Setup" — the library path
resolves relative to the script's own location, not your cwd):

```bash
npx tsx spike/encrypted-delivery/roundtrip.test.mjs        # offline crypto proof — do this first
npx tsx spike/encrypted-delivery/unwrap.test.mjs           # offline wallet-response-shape proof — do this too
node spike/encrypted-delivery/cli.mjs keygen               # ephemeral key; the ivk never leaves this box
node spike/encrypted-delivery/cli.mjs request <verusid>    # mint the QR on bb → writes spike/encrypted-delivery/qr.png
#   ... scan qr.png with Valu, sign as <verusid>, approve ...
node spike/encrypted-delivery/cli.mjs fetch                # collect the blob, decrypt, reveal the buyer key
node spike/encrypted-delivery/cli.mjs roundtrip            # encrypt as agent → decrypt as buyer → PASS
```

`<verusid>` on `request` is `expectedSigner` — the identity **you** will sign
with in the wallet (an i-address, or a friendly name like `gg.agentplatform@`;
the server resolves either). This is not optional and there is no default:
the QR is public and carries the ephemeral z-address, which is a *public*
key, so without binding the request to a specific signer anyone who sees the
QR could sign with their own identity and POST a substituted delivery address
before the real buyer does. The server enforces this server-side and rejects
a callback whose signer doesn't match with `403 SIGNER_MISMATCH`.

The `fetch` step performs the same check independently, client-side, by
comparing the wallet's reported signer against the resolved i-address the
mint call returns for `expectedSigner`. Both are i-addresses, so this is a
true like-for-like compare — not the raw string you typed, which the backend
may still show as a friendly name. **This depends on the backend echoing a
resolved `expectedSigner` in the mint response**; against a backend that
doesn't yet do this, `request` falls back to comparing your raw input, which
can spuriously fail on an otherwise-correct scan if you typed a friendly
name. `request`'s own console output tells you which case you're in
("resolved signer: …" vs. a fallback warning) — check that before assuming a
later `fetch` FAIL is a real mismatch.

`request` persists both your raw input and the resolved signer in
`.state.json` (mode `0600` — it also holds the buyer's derived viewing key,
so it is written non-world-readable), and a bare `node cli.mjs request`
re-mints against the previously used identity. Pass `<verusid>` again to
switch identities.

Point at a different backend with `API=http://…` (default
`https://api.junction41.io`).

## Troubleshooting — error-code cheatsheet

Two different paths land here. Most codes come straight back as the HTTP
response to `request`/`fetch` — the CLI prints the matching note
automatically whenever the backend returns one of these directly. The
wallet-callback codes are different: the *wallet*, not the CLI, is the one
that POSTs the callback and receives that status directly, so the CLI can't
see it in real time. `fetch` polls for it instead — the backend records the
callback's outcome as `lastError` on the request row, and `fetch` reports it
loudly ("the wallet DID answer, and was REJECTED") instead of printing the
same "not answered yet" message it would for a QR nobody has scanned. That
distinction is marked in the table below.

| Code | HTTP | Reaches CLI via | Meaning |
| --- | --- | --- | --- |
| `SIGNER_MISMATCH` | 403 | `lastError` (poll) | **The most likely first-scan failure, and NOT an attack.** The user picked a different identity in the wallet's selector than the one passed as `expectedSigner` to `request`. Re-mint with the identity actually chosen in Valu. |
| `PLAINTEXT_KEY_RESPONSE` | 422 | `lastError` (poll) | The wallet answered **unencrypted**. Correct rejection — an unencrypted answer would have leaked the ivk — but the exchange cannot complete. This is a conversation with the wallet team, not a bug to patch here. |
| `DISALLOWED_DETAIL_TYPE` | 422 | `lastError` (poll) | The wallet attached a detail type not on the server's allow-list. The ordinal is in the server log — ask the operator to check. |
| `INVALID_SIGNATURE` | 401 | `lastError` (poll) | The wallet's envelope signature didn't verify — wrong/stale signing key, corrupted response, or a replayed old challenge. Re-mint and scan fresh. |
| `INVALID_RESPONSE` | 400 | `lastError` (poll) | The response didn't parse at all. Rule of thumb: **400 = parse, 422 = policy.** |
| `INVALID_REQUEST` | 400 | direct (mint) | Our own POST body failed validation, most likely `encryptToAddressHex` isn't valid hex. A CLI-side bug, not a wallet/operator problem. |
| `UNKNOWN_SIGNER` | 400 | direct (mint) | `expectedSigner` couldn't be resolved to an identity on-chain. Friendly names need the trailing `@` — double-check spelling. |
| `UNKNOWN_REQUEST` | 404 | direct (fetch) | This `challengeId` isn't one the backend knows about — a stale `.state.json` from a different backend/environment, or the row already expired and was swept. Re-mint. |
| `REQUEST_EXPIRED` | 410 | direct (fetch) | The request window closed before the wallet answered. Re-mint and scan promptly. |
| `ENCRYPTION_DISABLED` | 503 | direct | The operator hasn't set `ENCRYPTION_SPIKE_TOKEN` on the *backend* — or set one shorter than 32 characters, which the backend treats as unset (fail-closed). Not fixable from the CLI — hand it back to the operator. |
| `UNAUTHORIZED` | 401 | direct | Your `ENCRYPTION_SPIKE_TOKEN` is missing or doesn't match what the operator set. |
| `CHAIN_SYNCING` | 503 | direct (mint) | The backend's daemon is behind chain tip. **Not a token/config problem** — wait and retry. On this deployment a memory watchdog periodically pauses the testnet daemon and the testnet node has a daily shutoff window; both self-heal. |
| `RPC_UNAVAILABLE` | 503 | direct (mint) | The backend can't reach its daemon at all. **Also not a token/config problem** — wait and retry; ask the operator if it persists. |
| *(wallet does nothing, no QR, no POST)* | — | — | Usually the daemon lagging chain tip: the wallet rejects a signed request when the signature-height blocktime differs from `createdAt` by more than 3600s. The server never even sees a POST — this is not a client bug. |

`ENCRYPTION_DISABLED`/`CHAIN_SYNCING`/`RPC_UNAVAILABLE` all surface as a bare
503. If the JSON body's `error` code is missing or unrecognized, the CLI
prints all three as candidates rather than guessing — a 503 here is *not*
reliably a token problem.

## What a green run proves

1. Valu renders and answers an `AppEncryptionRequest`.
2. The keys it returns are standard Sapling keys our library can use.
3. An agent can encrypt to the buyer **with no daemon**.
4. `bb` is **structurally unable** to decrypt — it never holds the ephemeral
   ivk, and `fetch` independently re-verifies (client-side, not just trusting
   the server) that the blob carries no inline viewing/spending key.
5. The request is bound to a specific signer — anyone else answering the same
   public QR is rejected server-side with `403 SIGNER_MISMATCH`.

## What this is not

A product. There is no per-job opt-in, no buyer UI, and no delivery wiring.
The crypto lives in `spike/` and **not** `src/` on purpose: the SDK is a
published npm package and `veruszsupportlib` is not a declared dependency, so
importing this from `src/` would break every downstream install. Promote it
only after interop is proven *and* the library is vendored with a pinned
hash.

## Deploy note

The backend routes need `sudo docker compose up -d --build api` (which
applies migrations 046 and 047 — the keyreq table and the `expected_signer`
column). **The user runs deploys** — the harness auto-approver blocks compose
as a production action. Hand over the command; do not attempt it.
