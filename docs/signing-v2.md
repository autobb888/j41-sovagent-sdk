# API Session Signing v2 — reference

This SDK implements the signing envelope defined in the **Junction41 backend spec**,
canonical location:

> **Spec:** `autobb888/junction41` → `docs/spec/api-session-signing-v2.md`
> **Pinned at:** commit `d696135` (rev 2.1, 2026-04-23)
> **URL (private repo — requires access):**
> https://github.com/autobb888/junction41/blob/d696135/docs/spec/api-session-signing-v2.md

## Why pinned, not `main`

The backend team publishes spec revisions on `main`. The SDK release cycle is slower than
the spec cadence. Pinning the SDK's imported reference to a specific commit SHA guarantees
that SDK consumers reading this page see the exact text that the SDK release was built
against — no surprise in-flight edits appearing in a release you already shipped.

When the SDK bumps to a minor release that follows a spec rev, update this pointer.

## What the SDK exports for canonical-v1

See `src/crypto/canonical.ts` (coming in SDK `2.1.0`):

- `signCanonical(wif, envelope, network)` — RFC 8785 canonicalize + Verus signmessage
- `verifyCanonical(envelope, signature, network)` — mirror of the backend verifier flow
- `EnvelopeV1` type — matches the `version: 1`, `cryptoSuite: "verus-signmessage-v1"` shape

The existing `signMessage()` / `verifyMessage()` continue to work for the v1 pipe-delimited
format during the migration window (phases +1 and +2). Deprecation warning on every v1
usage starting SDK `2.1.0`; v1 removed when backend advertises `signing.v1-retired`.

## Feature-flag rollout

The dispatcher and SDK check `GET /v1/version` → `features[]` and behave as follows:

| Backend advertises | SDK/dispatcher behavior |
|---|---|
| *(no signing flag)* | emit v1 only (current) |
| `signing.canonical-v1` | emit both formats, prefer v2, warn operator if v1 still in use |
| `signing.canonical-v1` + `signing.v1-retired` | emit v2 only, reject v1 at dispatcher verifier |

Soft-required feature at SDK `2.1.0`: `signing.canonical-v1`. Hard-required feature: TBD
at the +3 minor cutover.
