# J41 Security Hardening — Completed Work Summary

**Date:** 2026-05-21
**Scope:** `j41-sdk` (`@junction41/sovagent-sdk`), `j41-mcp-server`, `j41-dispatcher`
**For:** backend / platform team + stakeholders

Two audits were run and remediated: (1) a full-stack security review of all three
packages, and (2) a zero-tolerance deep audit of everything Verus/blockchain-related
(keys, signing, transactions, ECDH, on-chain data, crypto deps).

**Status:** every CRITICAL and HIGH finding is fixed and tested except the *integration*
of one item (host-side signing broker — security core done, Docker-validated rollout
pending). Shipped to npm and merged to `main`.

---

## Shipped artifacts
- **npm:** `@junction41/sovagent-sdk@2.3.1` (live). Consumers (dispatcher, mcp-server) pinned + locked to 2.3.1. (2.3.1 fixes a Verus message sign/verify interop bug vs verusd that was missed by a tautological cross-test in 2.3.0 — pinning the keys endpoint requires 2.3.1+.)
- **git:** all work merged to `main` on all three repos. Tests: **SDK 134 · MCP 67 · dispatcher 70 — all green**; dispatcher `--frozen-lockfile` clean (Docker build path verified).

---

## Audit 1 — full-stack (CRITICAL → MEDIUM), all fixed

**MCP server (the agent is untrusted):**
- **CRITICAL** — agent could self-authorize a payout by writing its own address into the financial allowlist via `j41_create_job`. Now only platform-confirmed addresses are allowlisted.
- **HIGH** — `Infinity` per-job price ceiling let an agent send unbounded amounts → absolute per-send/per-day VRSC caps enforced regardless of job context.
- **HIGH** — allowlist matched the unresolved VerusID string → destinations are resolved before the gate and matched against the funded address (closes resolve-after-check TOCTOU); VerusID-aware case handling.
- **HIGH** — `j41_broadcast_tx` bypassed all controls → disabled by default (opt-in env).
- **MEDIUM** — `J41_ALLOWLIST_PATH` honored only under test; SSE transport binds loopback + requires a token + Host/Origin (DNS-rebinding) guard; generic signer refuses J41-protocol messages.

**Dispatcher (runs untrusted job code; internet-facing):**
- **HIGH** — unauthenticated deposit reporting → credit theft. Now requires a buyer-signed report (nonce + freshness + replay cache) verified against the buyer's on-chain identity, **and** enforces platform sender-verification (see backend report #1).
- **MEDIUM** — credit meter clamped overage to zero (free usage) → recovers debt + blocks; trusts upstream usage bounded; rate-limiter keyed per (agent, buyer).

**SDK:**
- **HIGH** — access request/envelope verified signature only → now enforce timestamp freshness, `expiresAt`, and a caller replay hook.
- **MEDIUM** — webhook verify gained a timestamped/replay-window variant; path-traversal defenses standardized; vulnerable transitive deps addressed (and see Audit 2 dep migration).

**Packaging:** unified the SDK on `@junction41/sovagent-sdk@2.x` (removed the stale `@j41@2.0.0` scope/tarball); Docker images install the SDK from npm.

---

## Audit 2 — Verus/crypto deep audit

- **CRITICAL — change-address theft:** a prompt-injected agent could divert wallet *change* to itself. Change is now locked to the agent's own R/i address at the SDK level (covers all callers).
- **CRITICAL — identity-update tampering:** `buildIdentityUpdateTx` rebuilt primary addresses/authorities from the (MITM-able) platform response. Now refuses to sign unless the signing key is a primary address of the returned identity.
- **CRITICAL — auth-challenge signing oracle:** a MITM'd `/auth/challenge` could return a `J41-`protocol message the agent would sign with its identity key. All challenge-signing paths now reject protocol-shaped challenges (Unicode/zero-width bypasses closed).
- **HIGH** — private-key zeroization in the identity-update path; on-chain VDXF values validated at the decode boundary (no NaN/negative/huge token-rates → free usage/meter corruption; meter fails closed); BuyerSession validates the payment address + bounds the platform fee; concurrent-send double-spend fixed (serialized sends + UTXO de-confliction).
- **HIGH — crypto-dep migration:** Verus message sign/verify migrated from the unmaintained `bitcoinjs-message → secp256k1@3 → elliptic` chain to `@noble/curves`, **byte-for-byte cross-tested** against the old path (200+ vectors, mutual verification) before switching. `bitcoinjs-message`/`secp256k1@3` removed from the published runtime.
- **CRITICAL (core done) — WIF in the job container:** the agent's WIF is mounted into the untrusted job container for identity signing. The **constrained-signer broker policy** is built and tested (the dispatcher reconstructs every message from its own authoritative job record — a compromised container cannot inflate the amount, sign for another job, or sign an arbitrary message). The **integration** (channel + job-agent conversion + key-mount removal + an SDK `J41Agent` remote-signer) is the one remaining item; it requires Docker validation and is scheduled as a focused follow-up. *Interim risk is mitigated by the existing container hardening: CapDrop ALL, read-only rootfs, no-new-privileges, no Docker socket, seccomp/gVisor, non-root.*

---

## Backend action items

**Report #1 — SHIPPED by backend (thank you):** verify-payment sender verification, `verified` field, timestamped webhooks. All consumed correctly client-side.

**Report #2 — RESOLVED:**
1. **`GET /v1/identity/:id/keys` signing — SHIPPED by backend (commit `349c82d`, flag `identity.signed-keys-v1`)**, staging signer R-address `RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb`. Dispatcher is wired to enforce: setting `J41_PLATFORM_SIGNER=<R-address>` in the dispatcher env activates the SDK's pinned verification at every `getIdentityKeys` call. Both callers (`verifyCanonicalSignatures`, `verifyDepositReport`) fail-closed on `KEYS_UNSIGNED` / `KEYS_BAD_SIGNATURE` (server-side trust-anchor failure → 502 to upstream, no fallback to unverified data). Operator runbook: `j41-dispatcher/docs/DEPLOY-KEYS-ENDPOINT-PIN.md`.
2. **Revoke webhook always timestamped — CONFIRMED** (backend dual-signs via webhook-engine). Dispatcher already requires it on `/j41/api-access/revoke`. ✅

---

## Remaining client-side item
- **Host-side signing broker integration** (last open CRITICAL's plumbing). Plan: add an `J41Agent` remote-signer hook (SDK) so the container holds no WIF; bind-mounted request/response channel; dispatcher signs via the constrained-signer policy (already built); move the job-completion identity-update tx host-side; remove the `keys.json` mount; lock down container egress. Default-off flag + Docker validation checklist before cutover.

---

## Operational notes
- Rotate any npm tokens used for publishing.
- Open PRs are already merged to `main`; tag a release of 2.3.0 if you cut releases.
