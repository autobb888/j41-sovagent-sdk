# Changelog

All notable changes to `@junction41/sovagent-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- **`J41Client.getAuthChallenge()`** — its `/auth/challenge` endpoint was removed server-side; use `getConsentChallenge()` instead.

### Tests

- First auth regression test (`test/consent-login.test.ts`): asserts that `authenticateWithWIF` hits only `/auth/consent/*` endpoints, that the verify POST body includes `challengeId`, `verusId`, and a real ECDSA signature over the `challengeHash`, and that the returned session token is the `verus_session` cookie value rather than the body `sessionToken` field.
