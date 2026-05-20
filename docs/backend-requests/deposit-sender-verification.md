# Deposit Sender Verification — verify-payment Backend Change

**Date:** 2026-05-20
**Status:** Backend change REQUIRED (dispatcher + SDK already wired)
**Severity:** HIGH — credit theft / misattribution

---

## Problem

The dispatcher credits a buyer's API meter when a deposit to the seller's
pay-address is reported (`POST /j41/deposit/report` → `reportDeposit`). The
on-chain check uses `GET /v1/tx/verify-payment`, which only confirms that
`txid` paid `expectedAmount` to `expectedAddress` (the seller). It does **not**
confirm who *sent* the funds.

As shipped, the dispatcher now also requires the report to be **signed by the
claiming `buyerVerusId`** (replay-protected). That stops anonymous and replayed
claims, but it does **not** stop a party who controls *some* VerusID from
claiming *someone else's* on-chain payment as their own credit — because the
signature proves control of the claiming identity, not authorship of the
transaction.

**Complete closure requires the platform to verify the funding tx's sender.**

## Requested change

Extend `GET /v1/tx/verify-payment` to accept an optional `expectedSender` query
param and return sender-verification fields:

**Request (new optional param):**
```
GET /v1/tx/verify-payment?txid=...&expectedAddress=...&expectedAmount=...&currency=...&expectedSender=<VerusID|address>
```

**Response (new fields):**
```jsonc
{
  "data": {
    "txid": "...",
    "verified": true,
    "confirmations": 6,
    "amount": 10,
    "address": "iSellerPay...",
    "currency": "VRSCTEST",

    // NEW — only when expectedSender is supplied:
    "senderVerified": true,        // funding inputs provably belong to expectedSender
    "senderVerusId": "buyer@",     // resolved sender identity (if known)
    "senderAddress": "Rxxxx..."    // resolved source address
  }
}
```

Determine the sender from the transaction's vins (prevout addresses); if all
funding inputs map to `expectedSender`'s identity/address, set
`senderVerified: true`. If they demonstrably do not, set `senderVerified: false`.
Omit the fields only if sender resolution is genuinely unavailable.

## Already implemented (these three repos)

- **SDK** (`@junction41/sovagent-sdk@2.2.0`):
  - `J41Client.verifyPayment({ ..., expectedSender? })` sends the param.
  - `VerifyPaymentResponse` types `senderVerified` / `senderVerusId` / `senderAddress`.
  - `buildDepositReportMessage()` + `verifyMessage()` for signed reports.
- **Dispatcher** (`reportDeposit`):
  - Requires + verifies the buyer signature (nonce + 5-min freshness window, replay cache).
  - Passes `expectedSender: buyerVerusId` to `verifyPayment`.
  - **Enforcement is live**: rejects with `SENDER_MISMATCH` if `senderVerified === false`,
    or if `senderVerified === true` and `senderVerusId` ≠ the claiming buyer.
  - When the fields are absent (current backend), it credits on signature-auth
    only and logs a warning.

## Rollout

Once the backend ships the change, no further dispatcher edits are needed — the
`senderVerified` enforcement activates automatically. Recommended: after deploy,
treat a missing `senderVerified` as a hard failure (flip the warning to a
rejection) so credit can never be granted without sender proof.
