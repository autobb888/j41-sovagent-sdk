# J41 Platform — Backend Change Report

**Date:** 2026-05-20
**From:** Security hardening of j41-sdk / j41-mcp-server / j41-dispatcher
**Audience:** verus-platform backend team

This report lists the **backend (verus-platform API) changes** required or recommended to complete the security hardening already shipped in the SDK / dispatcher. Each item notes what the client side already does, so the backend work is well-scoped. Items are ordered by priority.

---

## 1. `verify-payment`: add sender verification — REQUIRED (HIGH)

**Why:** Closes a credit-theft / misattribution hole. The dispatcher credits a buyer's API meter when a deposit to the seller's pay-address is reported. `GET /v1/tx/verify-payment` currently confirms only that the tx paid the expected amount to the seller — not *who sent it*. So a third party can claim someone else's on-chain payment as their own credit. The dispatcher now also requires the report to be **signed by the claiming buyer**, but that proves control of the claiming identity, not authorship of the transaction. Only the backend can verify the funding tx's sender from the chain.

**Change:** Extend `GET /v1/tx/verify-payment`:

- **New optional request param:** `expectedSender=<VerusID|address>`
- **New response fields (when `expectedSender` is supplied):**
  ```jsonc
  {
    "senderVerified": true,      // funding inputs provably belong to expectedSender
    "senderVerusId": "buyer@",   // resolved sender identity (if known)
    "senderAddress": "Rxxxx..."  // resolved source address
  }
  ```
  Derive the sender from the tx vins (prevout addresses). Set `senderVerified: true` only if all funding inputs map to `expectedSender`; `false` if they demonstrably don't; omit the fields only if sender resolution is genuinely unavailable.

**Already done (client side):** SDK `verifyPayment({ ..., expectedSender })` sends the param and types the response. The dispatcher passes `expectedSender: buyerVerusId` and **already enforces** it — rejects with `SENDER_MISMATCH` when `senderVerified === false` or the returned `senderVerusId` ≠ the claiming buyer. Until the backend ships this, the dispatcher credits on signature-auth only and logs a warning. **No further dispatcher change needed** once the fields appear.

Full detail: `j41-sdk/docs/backend-requests/deposit-sender-verification.md`.

---

## 2. `verify-payment` response field mismatch — VERIFY / FIX (HIGH — possible silent breakage)

**Why:** The dispatcher's `reportDeposit` reads **`verification.valid`** and `verification.reason`:
```js
if (!verification.valid) {
  return { credited: false, message: `... ${verification.reason || 'invalid'}` };
}
```
…but the SDK's `VerifyPaymentResponse` type declares **`verified`** (no `valid`, no `reason`).

If the endpoint actually returns `verified` (matching the SDK type), then `verification.valid` is always `undefined` → deposits **never credit**. If it returns `valid`, deposits work but the SDK type is wrong.

**Action:** Confirm the exact response shape of `GET /v1/tx/verify-payment` and tell us the canonical field name(s). We will align the SDK type and the dispatcher to match. Please standardize on one of:
```jsonc
{ "verified": true, "reason": "...", "confirmations": 6, "amount": 10, "address": "...", "currency": "..." }
```
(Recommend `verified` + `reason`; we'll update the dispatcher's `.valid` accordingly.)

---

## 3. Signed, timestamped webhooks — RECOMMENDED (MEDIUM — replay protection)

**Why:** Platform → dispatcher webhooks (`/j41/api-access/revoke`, and any future ones) and platform → client webhooks are verified with a plain HMAC over the body, with no timestamp — a captured webhook can be replayed indefinitely.

**Change:** When sending webhooks, sign `"<timestamp>.<rawBody>"` instead of just `<rawBody>`, and include the timestamp:
- Header: `X-Webhook-Timestamp: <unix-seconds>`
- Signature: `X-Webhook-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<rawBody>")`

**Already done (client side):** SDK exports `verifyWebhookSignatureWithTimestamp(payload, signature, secret, timestamp, { toleranceSeconds })` (default 300s window). Once the platform sends the timestamp header + timestamp-bound signature, the dispatcher's webhook routes can switch to it with a one-line change. The existing `verifyWebhookSignature` remains for backward compatibility during rollout.

---

## 4. Buyer-client coordination: signed deposit reports — ACTION REQUIRED (not backend, but you own the buyer SDK usage)

**Why:** The dispatcher's `POST /j41/deposit/report` now **requires** a buyer signature (anti credit-theft). Unsigned reports get `401`. Any buyer client that reports deposits must adopt the new signed format before this dispatcher build is deployed.

**How:** SDK provides `buildDepositReportMessage({ buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp })` → sign with `signMessage(wif, msg, network)` → POST `{ ...fields, signature }`. Fields: `nonce` (random hex), `timestamp` (unix seconds, ±5 min window). The dispatcher verifies the signature against the buyer's on-chain primary address via `GET /v1/identity/:id/keys` (already exists) and rejects replays.

---

## Summary of required vs optional

| # | Change | Endpoint | Priority | Client ready? |
|---|--------|----------|----------|---------------|
| 1 | Sender verification | `GET /v1/tx/verify-payment` (`expectedSender` + sender fields) | **Required (HIGH)** | ✅ enforced on arrival |
| 2 | Confirm `verified` vs `valid` field | `GET /v1/tx/verify-payment` | **Verify (HIGH)** | needs your answer |
| 3 | Timestamped webhook signatures | all outbound webhooks | Recommended (MEDIUM) | ✅ verifier ready |
| 4 | Buyer clients send signed deposit reports | (client → dispatcher) | Required before deploy | ✅ helper shipped |

Items 1 and 3 require no further dispatcher/SDK code once shipped — the client side already consumes them. Item 2 needs a one-line alignment after you confirm the field name.
