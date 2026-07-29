# Changelog

All notable changes to `@junction41/sovagent-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.12.0] - 2026-07-29

### Added

- **`J41Agent.acceptInboxBatch(items)` — one identity transaction per agent, not
  one per inbox item.** Accepting items one at a time wrote N transactions to the
  same VerusID back-to-back: the first spends the identity `prevOutput` and sits
  in the mempool while the platform API keeps serving the last *confirmed*
  `prevOutput`, so every transaction after it was built spending an already-spent
  output and rejected as a double-spend. Observed live on 3 of 3 agents — an
  attestation landed, the review that followed milliseconds later was rejected
  five times and dead-lettered, and its on-chain reputation data never arrived.

  Failure handling is per item, never all-or-nothing: `rejected` (item's own
  fault), `deferred` (transient), `ackFailed` (written but unacked), and only
  genuinely batch-scoped faults throw. One item per VDXF key per batch, because
  `buildIdentityUpdateTx` REPLACES a key's array rather than appending — merging
  two same-key items would silently drop one.

  Two non-obvious properties, both found by review:
  - A value can pass the allowlist AND the size check and still be
    unserializable (`contentmultimapValueByteSize` JSON.stringify-fallbacks over
    any object). Build failures are bisected offline to blame the item — after a
    control build confirms the environment is healthy, so a wallet dipping below
    the fee cannot mass-reject healthy items.
  - Re-accepting an already-accepted item returns `400 ALREADY_PROCESSED`, which
    is terminal SUCCESS, not a retryable failure — it is what a lost ack response
    looks like on retry.

- **`src/inbox/vdxf-gate.ts` — single source of truth for the per-type accept
  allowlists.** The three `accept*` methods each carried an inline copy; `52f8d07`
  had to narrow the review one after an audit found it admitting the attestation
  key. Batching adds a fourth caller, so the allowlists now live in one place and
  every path gates an item against ITS OWN type before merging. Error strings are
  byte-compatible; the existing accept tests are the regression proof.

- **`InboxBatchResult.expiryHeight`** so callers can tell a pending write that is
  provably dead from one that is merely slow.

### Changed

- `acceptReview`, `acceptAttestationTuple`, `acceptJobRecord` now delegate their
  allowlist logic to the shared gate. No behavioural change.

## [2.11.0] - 2026-07-28

### Added

- **Worker-attach ACK client methods** (`src/client/index.ts`).
  `confirmWorkerAttached(jobId)` POSTs to
  `/v1/jobs/:jobId/worker-attached`, and `reportWorkerAttachFailed(jobId, reason)`
  POSTs to `/v1/jobs/:jobId/worker-attach-failed` with `{ reason }`. Both return
  the updated `Job`. These are the seller-side half of the worker-attach
  handshake — the dispatcher calls them around `connectChat` so the platform can
  stamp `jobs.worker_attached_at` and gate dispute-refund eligibility on an
  *observed* attach rather than an advertised capability.

  **Dispatcher 2.6.0 requires this release.** Dispatcher 2.6.0 calls both
  methods; on SDK 2.10.x they are undefined, so `worker_attached_at` is never
  stamped and stays `NULL` for every job.

## [Unreleased]

### Added

- **`CreditWatcher` — sovcompute prepaid auto-top-up** (`src/buyer/credit-watcher.ts`).
  Buyer-side watcher (hirer / brainbox) that refills its prepaid compute credit
  from its **own** wallet *before* hitting a `402`, without surrendering custody.
  Two detection paths funnel into one debounced, capped, idempotent top-up:
  header-driven (`observeRemaining()` fed from the `X-J41-Credit-Remaining`
  response header; `afterProxiedResponse()` wraps `callProxied`'s result) and
  webhook-driven (`onCreditLow()` for the `proxy.credit_low` event). The on-chain
  send and the deposit-report signature are injected (broker-signed, no raw WIF),
  with a hard `dailyCapVrsc` spend ceiling. (Already merged — `3c2e130`.)

### Changed

- **Jailbox / workspace surface is now PARKED (opt-in, default off).** The "agent
  works inside the buyer's environment" sandbox is parked in favour of
  deliver-and-review (the agent delivers a verifiable artifact the buyer reviews
  in their own trust domain, never an agent admitted into the buyer's
  environment). All code is retained and still compiles/tests; the runtime entry
  points are gated behind a new opt-in flag.

  - New `J41ClientConfig.enableJailbox` and `J41AgentConfig.enableJailbox`
    options, **default `false`**.
  - New `J41Client.isJailboxEnabled()` accessor (single source of truth).
  - When not enabled, these throw
    `Jailbox is parked — use artifact delivery. Pass { enableJailbox: true } to re-enable.`:
    `J41Client.getWorkspaceStatus()`, `J41Client.initBuyerWorkspace()`,
    `J41Agent.workspace`, and `BuyerSession.connectWorkspace()`. All are marked
    `@deprecated`. When enabled, the original behaviour is restored unchanged.

  See `JAILBOX_PARKED.md` and the VDXF v2 schema design §3b "`jailbox.*` PARKED".

## [2.9.0] - 2026-06-21

### Changed

- **Agent + client login now use the VerusID `/auth/consent/*` flow.** `J41Client.authenticateWithWIF()` signs the consent `challengeHash`, POSTs to `/auth/consent/verify`, and extracts the `verus_session` cookie from `set-cookie`. `J41Agent._loginImpl` and `loginWithConsent()` follow the same path. The broker/remote-signer path is preserved. The legacy `/auth/challenge` + `/auth/login` endpoints were removed server-side.

### Deprecated

- **`J41Client.getAuthChallenge()`** — its `/auth/challenge` endpoint was removed server-side; use `getConsentChallenge()` instead. It now throws immediately (was previously a warn + 404).

### Security

- **Signing-oracle guard:** all three login paths now reject a `challengeHash` that is not a 64-char hex SHA-256 digest (`assertConsentChallengeHash`) before signing — a compromised/MITM'd API can no longer hand back an arbitrary string to be signed with the agent's key.

### Tests

- First auth regression test (`test/consent-login.test.ts`): asserts that `authenticateWithWIF` hits only `/auth/consent/*` endpoints, that the verify POST body includes `challengeId`, `verusId`, and a real ECDSA signature over the `challengeHash`, and that the returned session token is the `verus_session` cookie value rather than the body `sessionToken` field.
