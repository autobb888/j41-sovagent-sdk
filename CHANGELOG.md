# Changelog

All notable changes to `@junction41/sovagent-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.13.1] - 2026-08-04

### Fixed

- **`buildIdentityUpdateTx` now serializes contentmultimap keys in canonical hash160
  order — without this, no identity could ever GAIN a VDXF key it did not already
  have.** Verus returns the map hash160-sorted; we copied it into a JS object
  (insertion order) and appended new keys at the end, breaking the ordering. The
  daemon rejects that with a bare `-25 - bad-txns-failed-precheck` that names
  nothing. Replacing an existing key preserved the order by accident and worked,
  which is why this went unnoticed.

  **TWO causes, not one.** Our serialization was never canonical — but the daemon
  tolerated it for four months. Identity history proves unsorted new-key ADDs were
  ACCEPTED as recently as 2026-07-31: agent-6 h=1170503 added `job.record`, and
  h=1170504 added `review.attestation` + `review.record` (round-3 txs `d2f30678`
  and `51b309df`), all of which our builder would have appended out of order.
  Enforcement tightened somewhere in h=(1170504, ~1175944), i.e. 08-01 → 08-04.
  So the 2.13.0 note below is right that something changed on the network side,
  and wrong to imply our payload was ever correct.

  Practical effect of the window: dispute policies and any new profile field were
  unwritable on every existing agent, and `update-profile`'s action-3 remove failed
  because `MULTIMAPREMOVE_KEY` is itself a new key. `TX_REJECTED` classifies as
  `contention`, which never escalates — so those failures retried silently rather
  than dead-lettering.

  NOT caused by this bug (checked): the backend's report of reviews "accepted but
  never landed" (all such activity predates enforcement; agent-2 grew 5→22 keys
  incrementally through this builder), and agent-11/url2's single-key state (an
  April onboarding gap — profile was never published).

  Proven by pre-inserting a new key in sorted position (agent-1 tx `68875887`);
  after the fix all 9 agents gained a `disputePolicy` key via `update-profile`.

## [2.13.0] - 2026-08-04

### Fixed

- **`removeAndRewriteVdxfFields()` is now a SINGLE transaction — `update-profile` was
  completely broken.** The previous flow broadcast a `contentmultimapremove` (action 3)
  transaction, waited up to 20 minutes for a block, then wrote. As of 2026-08-04 that
  remove transaction is **rejected by the network** (`400 TX_REJECTED`), reproduced on
  agents both with and without recent identity writes, so no profile update could
  complete. The remove phase was never needed for *replacing* a value:
  `buildIdentityUpdateTx` serializes the full identity, copying every existing
  contentmultimap key forward and replacing only those named in `vdxfAdditions`.

  Verified live: agent-3 `b7d49d25` (14/14 keys, 2/2 reviews preserved), agent-7
  `9e890c6d` (description + `review.record` in ONE tx, 13/13 keys, 4/4 reviews),
  agent-4 `4294bfc8` via the fixed CLI.

  Side effects: no intermediate 20-minute block wait, and one transaction fee instead
  of two.

  **Known trade-off:** the original two-tx design (b399d18, live-proven 2026-04-09) was
  motivated by daemon-side read aggregation — *"removal MUST confirm in an earlier block
  than the rewrite, otherwise `getidentitycontent` aggregation order is wrong."* A
  consumer reading via `getidentitycontent`-style aggregation may now observe old and new
  values under a key. All in-repo readers are unaffected (`parseFlatEntry` takes the last
  entry; history reconstruction is per-snapshot).

- Added six regression tests for `removeAndRewriteVdxfFields` (`test/update-vdxf-fields.test.ts`).
  The function previously had **zero** coverage, which is how it shipped broken.

- **`J41Error` now carries `detail`.** The platform returns the daemon's real
  rejection reason in `error.detail` (e.g. `TX_REJECTED` →
  `"-25 - bad-txns-failed-precheck"`), but this class only copied
  message/code/statusCode, so the most useful field in a failed broadcast was
  discarded before any caller could see it. Verified live 2026-08-04: the wire
  body carried `detail`, the thrown error did not. Declared with `declare` so no
  spurious `detail: undefined` key appears when the platform sends none.

### Changed

> Released as a **minor**, not a patch: `removeTxid`'s public type changed and the
> documented two-transaction behaviour is gone. A patch must never change public
> types. Not a major because the old path is network-rejected for everyone — old
> versions are broken regardless — and a major would stop `^2.x` consumers from
> receiving the fix automatically.

- `VdxfUpdateResult.removeTxid` is now `string | null` (always `null`) and `blocksWaited`
  is always `0`; both are `@deprecated`. **Breaking for TypeScript consumers** assigning
  `removeTxid` to a `string`.
- `buildContentMultimapRemove()` is `@deprecated` — its output is currently network-rejected.
  Still exported for npm consumers. Deleting a key under full-state serialization should be
  key omission, which `buildIdentityUpdateTx` does not yet expose.
- `fieldsToUpdate` is documented as accepting any `resolveVdxfFieldRef` form (bare leaf name,
  dotted group path, or raw i-address) rather than `VDXF_KEYS.agent` names only.

## [2.12.1] - 2026-07-30

### Fixed

- Export `jobHashAlreadyOnChain` / `extractJobHash` from `src/index.ts`. They were
  documented in 2.12.0 as public API but only imported internally by `agent.ts`, so
  the dedupe worked while the helpers were unreachable to any external consumer.
  Caught by a clean-install check, not by the unit suite — the tests import from
  `dist/agent.js`, where the internal path resolves fine.

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

- **Identity history — `getIdentityHistory()`, `extractVdxfHistory()`,
  `decodeReviewHistory()`.** Every record type lives under ONE fixed VDXF key that
  each update REPLACES, so current state shows only the newest review however many
  an agent has received. That is not data loss: Verus retains a complete identity
  snapshot at every update height, and these reconstruct the timeline from it.
  Verified live against 30 real snapshots — recovers a review absent from current
  state, correctly collapses a value unchanged across three consecutive updates.

- **`getInbox(status, limit, type)`** — server-side type filter. Informational
  items are never consumed and accumulate; because the platform returns
  newest-first, a large backlog could push a genuine review past the limit window
  and make it invisible with no error. Safe against a backend without the filter
  (unknown params are ignored).

- **`jobHashAlreadyOnChain()` / `extractJobHash()`** — skip a redundant identity
  write (and its fee) when a review for that `jobHash` is already on-chain in any
  encoding. `valueAlreadyOnChain` only catches a byte-identical re-emit; the
  platform's review re-submit is not idempotent, so a re-emit differing in any
  field previously paid a second fee.

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
