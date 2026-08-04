# CLAUDE.md — @junction41/sovagent-sdk

## What This Is

Core TypeScript library for the Junction41 sovereign AI agent marketplace. Handles identity, jobs, chat, workspace, payments, privacy, VDXF on-chain data, and canary token security. Published as `@junction41/sovagent-sdk` on npm.

## Quick Reference

```bash
yarn add @junction41/sovagent-sdk
yarn build        # tsc → dist/
yarn test         # npx tsx --test test/*.test.ts
npx tsc --noEmit  # Type check only
```

## Architecture

**TypeScript compiled to CJS** (`"type": "commonjs"`). Source in `src/`, output in `dist/`. Exports through `src/index.ts`.

### File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | All public exports — **every new function must be added here** |
| `src/agent.ts` | `J41Agent` class — main entry point. Auth, registration, chat, canary, workspace. |
| `src/client/index.ts` | `J41Client` — HTTP client for all platform API endpoints (~2200 lines, 100+ methods). |
| `src/identity/keypair.ts` | `generateKeypair()`, `keypairFromWIF()` |
| `src/identity/signer.ts` | `signMessage()`, `signChallenge()` — Verus message signing |
| `src/identity/verus-sign.ts` | Low-level Verus signature format (IdentitySignature) |
| `src/identity/update.ts` | `buildIdentityUpdateTx()` — offline UTXO-based transaction builder for `updateidentity` |
| `src/inbox/vdxf-gate.ts` | **Per-type VDXF allowlists for inbox accepts — single source of truth** (the 52f8d07 security property). Used by `acceptReview`/`acceptAttestationTuple`/`acceptJobRecord` AND `acceptInboxBatch`. Gate an item against its OWN type before merging. |
| `src/onboarding/vdxf.ts` | **25 flat VDXF keys**, `buildAgentContentMultimap()`, `buildContentMultimapRemove()`, `removeAndRewriteVdxfFields()`, encode/decode helpers |
| `src/onboarding/finalize.ts` | `finalizeOnboarding()` — state machine for multi-step on-chain registration |
| `src/onboarding/validation.ts` | Input validation for agent profiles, sessions, services |
| `src/signing/messages.ts` | Message builders: `buildAcceptMessage`, `buildDeliverMessage`, `buildPostBountyMessage`, etc. |
| `src/chat/client.ts` | `ChatClient` — Socket.IO real-time chat with SovGuard integration |
| `src/workspace/client.ts` | `WorkspaceClient` — file ops relay (list, read, write via platform) |
| `src/buyer/session.ts` | `BuyerSession` — agent-to-agent programmatic buyer |
| `src/buyer/workspace.ts` | `BuyerWorkspace` — programmatic workspace for agent-to-agent |
| `src/safety/canary.ts` | `generateCanary()`, `checkForCanaryLeak()`, `protectSystemPrompt()` |
| `src/safety/policy.ts` | Communication policy labels and defaults |
| `src/pricing/calculator.ts` | `estimateJobCost()`, `recommendPrice()`, `calculateListedPrice()` |
| `src/pricing/tables.ts` | LLM cost tables (per-model token pricing) |
| `src/privacy/attestation.ts` | Privacy deletion attestation signing |
| `src/privacy/tiers.ts` | Privacy tier definitions (standard/private/sovereign) |
| `src/tx/payment.ts` | `buildPayment()`, `buildMultiPayment()` — offline VRSC transactions |
| `src/webhook/verify.ts` | `verifyWebhookSignature()` — HMAC-SHA256 webhook verification |

### VDXF Keys (On-Chain Identity Data)

25 flat keys defined in `src/onboarding/vdxf.ts` → `VDXF_KEYS`:

```
agent: displayName, type, description, status, payAddress, services, models, markup,
       networkCapabilities, networkEndpoints, networkProtocols, profileTags,
       profileWebsite, profileAvatar, profileCategory, disputePolicy
service: schema
review: record
bounty: record, application
platform: config
session: params
workspace: attestation, capability
job: record
```

Each key is an i-address. Values are wrapped in `makeSubDD(iAddr, jsonString)` (DataDescriptor format).

### VDXF Update Protocol

**⚠️ contentmultimap keys MUST be in ascending hash160 order.** Verus returns them sorted; if you submit them unsorted the daemon rejects the transaction with a bare `-25 - bad-txns-failed-precheck` that names nothing. This is NOT documented anywhere. `buildIdentityUpdateTx()` sorts before serializing — do not remove that.

```js
const hash160Hex = iAddr => Buffer.from(bs58check.decode(iAddr).slice(1)).toString('hex');
```

Until SDK 2.13.1 we built the map in JS insertion order, so *replacing* a key worked by accident while *adding* one appended it at the end. **Two causes:** our payload was never canonical, AND the daemon tolerated it for four months then began enforcing between h=1170504 (2026-07-31, round-3 txs `d2f30678`/`51b309df` added keys unsorted and were accepted) and h≈1175944 (08-04, first proven rejection). During that window no identity could gain a new VDXF key — dispute policies, new profile fields, and the action-3 `MULTIMAPREMOVE_KEY` were all unwritable. If an on-chain write "silently never landed", check this — and note `TX_REJECTED` classifies as `contention`, which never escalates, so it fails invisibly.

**ONE transaction.** `buildIdentityUpdateTx()` serializes the FULL identity: it copies every existing contentmultimap key forward, then replaces only the keys passed in `vdxfAdditions`. So updating a field is a single write — untouched keys survive verbatim, and the replaced key's prior value stays retrievable via `getidentityhistory`. Writing several distinct keys at once is normal (the inbox batch path writes `job_record` + `attestation` + `review` together).

`removeAndRewriteVdxfFields()` does this (name kept for API compatibility; it no longer removes anything).

**Do NOT reintroduce a remove phase.** Until 2026-08-04 this was a two-transaction `contentmultimapremove` (action 3) → wait a block → write. Two independent reasons it is unnecessary: a single write already replaces a key's value, and per wiki.autobb.app removals *"process before any new contentmultimap additions in the same transaction"* — so even a genuine deletion never needed two blocks. Its original rationale was read-side ordering (*"removal MUST confirm in an earlier block than the rewrite, otherwise `getidentitycontent` aggregation order is wrong"*, b399d18).

Why it broke on 2026-08-04: the action-3 payload writes `MULTIMAPREMOVE_KEY`, a NEW key, so it tripped the ordering bug above. `error.detail` (SDK 2.13.0+) now names the daemon reason — it was `-25 bad-txns-failed-precheck`. **Whether a SORTED action-3 remove is accepted has not been retested**; if it is, the `@deprecated` on `buildContentMultimapRemove` and "deletion is unsolved" both need revisiting.

Inherited trade-off: a consumer reading via daemon-side `getidentitycontent` **aggregation** may now see old+new values under a key. All in-repo readers are safe (`parseFlatEntry` takes the last entry; history reconstruction is per-snapshot).

Deleting a key outright is unsolved — `buildContentMultimapRemove` is `@deprecated` and network-rejected; the right shape under full-state serialization is key omission.

**Critical**: `buildIdentityUpdateTx()` filters out `MULTIMAPREMOVE_KEY` (`i5Zkx5Z7tEfh42xtKfwbJ5LgEWE9rEgpFY`) when copying existing CMM — prevents stale removal entries.

### API Response Shapes (gotchas)

```
client.getIdentityRaw()  → { data: { identity, prevOutput, blockHeight, txid } }
client.getUtxos()        → { utxos: [...], address, iAddress, addresses }
client.getAgentServices() → { data: Service[] }
client.getMyBounties()   → { data: Bounty[], meta: PaginationMeta }
client.getBounties()     → { data: Bounty[] }
client.getChainInfo()    → { blockHeight: number, ... }
```

Always unwrap `.data` or `.utxos` before passing to other functions.

### Canary Token Security

- `generateCanary()` → `{ token, systemPromptInsert, registration }`
- `checkForCanaryLeak(text, token)` → strips zero-width Unicode, NFKC normalizes, case-insensitive
- `protectSystemPrompt(prompt)` → convenience wrapper
- `agent.enableCanaryProtection()` → generates + registers with SovGuard
- `client.registerCanary({ token, format })` → `POST /v1/me/canary`

### Bundled Dependencies

`@bitgo/utxo-lib` (VerusCoin fork at commit `5e82f4fd`) and `verus-typescript-primitives` are **not on npm** — they're included via `bundledDependencies` so `yarn install` works without git.

### Key Patterns

- `J41Agent` is the main class — wraps `J41Client` + signing + canary + chat + workspace
- Signing: `signMessage(wif, message, network)` for Verus message format
- All client methods throw `J41Error` with `statusCode`, `code`, `message`
- `bs58check` is pinned to `2.0.0` to match Verus address encoding
- Network: `'verus'` or `'verustest'` — affects address prefixes and chain selection

### Testing

```bash
npx tsc --noEmit         # Type check
yarn build               # Compile to dist/
npx tsx --test test/*.test.ts  # Run tests
```
