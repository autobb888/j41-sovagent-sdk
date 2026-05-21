# J41 Platform — Backend Change Report #2

**Date:** 2026-05-21
**From:** Verus/crypto deep audit of j41-sdk / j41-mcp-server / j41-dispatcher
**Audience:** verus-platform backend team

Follow-up to report #1 (sender verification, `verified` field, timestamped webhooks — all shipped, thank you). This round of hardening is almost entirely client-side and is proceeding without you. **Two items need the backend**, one substantive and one a confirmation.

---

## 1. Sign the identity-keys response — REQUIRED (the verification trust anchor)

**Severity:** HIGH (identity takeover / signature-forgery enabler)

**Endpoint:** `GET /v1/identity/:idOrName/keys`

**Problem.** This endpoint is the *single source of truth* for "which addresses are authorized to sign for identity X." Every signature check in the system resolves the signer's primary addresses through it:
- dispatcher access-key minting (`verifyAccessRequest` / `verifyCanonicalSignatures`),
- deposit-report authentication (`verifyDepositReport`),
- any identity-signature verification.

It is fetched over TLS but is otherwise unauthenticated at the application layer. **If an attacker can MITM or compromise this response**, they substitute their own `primaryAddresses` (with `minimumSignatures: 1`) and then *any signature they make verifies as any victim identity* — letting them mint API keys as the victim, claim deposit credit as the victim, and impersonate the victim wherever Verus signatures are trusted. TLS alone is not sufficient defense-in-depth for a value this load-bearing.

**Requested change (pick one):**
- **(Preferred) Sign the response body** with a fixed, well-known platform key, e.g.:
  ```jsonc
  {
    "data": { "iaddress": "...", "primaryAddresses": ["R..."], "minimumSignatures": 1, "blockHeight": 123456 },
    "platformSignature": "sha256-or-verus-sig over canonical(data)"
  }
  ```
  Publish the platform public key out-of-band (docs / a pinned constant we ship). Clients verify `platformSignature` before trusting `primaryAddresses`. Include `blockHeight`/`expiresAt` so the response can't be a stale replay.
- **(Alternative) Return chain-verified data + proof** so clients can independently confirm `primaryAddresses` against the Verus chain (e.g. the `getidentity` txid/blockheight they can cross-check), or expose a notarized read.

**Client side — IMPLEMENTED (enforces once you ship it).** The SDK now verifies the keys response when an operator pins the platform signer. Build the response to **exactly** this contract so it interoperates:

- Field name: **`platformSignature`** on the `data` object.
- Signed payload: **RFC 8785 / JCS `canonicalize` of the `data` object with `platformSignature` removed** — `canonicalize({ iaddress, name, primaryAddresses, minimumSignatures, cachedAt?, blockHeight? })`.
- Scheme: a **Verus message signature** (`verifymessage` format, base64 — same as `signMessage`) by the platform signing key.
- Client config: the platform signing key's **R-address** in `J41_PLATFORM_SIGNER`.

With the pin set, the SDK requires `platformSignature`, recomputes `canonicalize(data-without-sig)`, and verifies against the pinned R-address — rejecting unsigned / wrong-key / tampered (`primaryAddresses` swapped) responses with `KEYS_UNSIGNED` / `KEYS_BAD_SIGNATURE` (unit-tested). Please include a `blockHeight`/`expiresAt` inside the signed `data` so a stale response can't be replayed. (TLS/cert pinning is left as an optional deployment-layer mitigation — better at the infra level than brittle in-SDK.)

---

## 2. Confirm the revoke webhook always carries the timestamped signature — CONFIRM

**Severity:** MEDIUM (replay)

In report #1 you added dual-signing (`X-Webhook-Signature` legacy + `X-Webhook-Timestamp` + `X-Webhook-Signature-Timestamped`). We are now going to make the dispatcher **require** the timestamped signature on the sensitive `/j41/api-access/revoke` path (and drop the replayable legacy fallback *there*), so a captured legacy-signed revoke can't be replayed to knock a buyer's access offline.

**Please confirm:** every emission of the api-access-revoke webhook includes `X-Webhook-Timestamp` + `X-Webhook-Signature-Timestamped` (no code path that sends only the legacy header). If any path is legacy-only, point us at it before we enable the requirement. We'll keep the legacy fallback on the lower-risk per-agent event webhook until you signal the legacy header is fully retired.

---

## Summary

| # | Change | Endpoint | Priority | Blocks us? |
|---|--------|----------|----------|-----------|
| 1 | Sign identity-keys response with a pinned key | `GET /v1/identity/:id/keys` | **HIGH** | No — client partial (TLS pin) ships now; full fix needs you |
| 2 | Confirm revoke webhook always timestamped | revoke webhook | Confirm | No — we default-require once confirmed |

Neither blocks the client-side hardening in flight (host-side signing broker, crypto-lib migration, etc.). Item 1 is the one architectural ask: until the keys response is integrity-protected, identity-signature verification rests on TLS alone.
