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

**Two separate transactions in separate blocks** (Verus daemon requirement):

1. `buildContentMultimapRemove(identityName, iAddresses)` → action 3 removal under `MULTIMAPREMOVE_KEY`
2. Wait for block confirmation via `getChainInfo().blockHeight` polling
3. Re-fetch identity + UTXOs (consumed by remove tx)
4. `buildIdentityUpdateTx()` with new values as `vdxfAdditions`

`removeAndRewriteVdxfFields()` orchestrates this entire flow.

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
