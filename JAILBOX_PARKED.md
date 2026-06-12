# Jailbox / Workspace — PARKED

**Status:** parked (dormant, opt-in), not deleted. 2026-06-12.

## What

The jailbox/workspace surface — the "agent works **inside** the buyer's
environment" sandbox, where the seller's agent connects to a live relay over
`/v1/jailbox/*` + the `/jailbox` Socket.IO namespace and reads/writes files in
the buyer's project directory — is **parked**. All of the code remains in the
repo and continues to compile and pass tests; it is simply **off by default**.

## Why

Admitting an unknown agent into the buyer's trust boundary is the one capability
that pulls against the rest of the trust stack — the safest access is no access.
The platform's default execution model is now **deliver-and-review**: the agent
delivers a **verifiable artifact** (repo PR / bundle / content hash /
scoped-access grant) that the buyer reviews in their own trust domain (SovGuard
scans buyer-side), rather than an agent ever being admitted into the buyer's
machine.

See the architectural decision in the VDXF v2 schema design,
§3b "`jailbox.*` PARKED"
(`junction41/docs/superpowers/specs/2026-06-12-vdxf-v2-schema-design.md`).
The on-chain `jailbox.*` keys are reserved but not published at launch; the only
residue is a thin, opt-in **scoped-access grant**
(`delivery.target=scoped-access`) for the rare "data can't move" job.

## How it's parked (opt-in via `enableJailbox`)

The surface is gated behind a single opt-in flag, **default `false`**:

- `new J41Client({ apiUrl, enableJailbox: true })`
- `new J41Agent({ apiUrl, ..., enableJailbox: true })` (threads the flag into
  its internal `J41Client`)

When the flag is **not** set, every jailbox/workspace entry point throws:

```
Error: Jailbox is parked — use artifact delivery. Pass { enableJailbox: true } to re-enable.
```

Gated entry points (all marked `@deprecated`):

| Surface | File |
|---|---|
| `J41Client.getWorkspaceStatus()` | `src/client/index.ts` |
| `J41Client.initBuyerWorkspace()` | `src/client/index.ts` |
| `J41Agent.workspace` (agent-side relay accessor) | `src/agent.ts` |
| `BuyerSession.connectWorkspace()` (buyer-side relay) | `src/buyer/session.ts` |

The single source of truth is `J41Client`'s `enableJailbox` flag, exposed via
`J41Client.isJailboxEnabled()`; the agent- and buyer-side relay entry points
consult it before connecting. When `true`, the original behaviour is restored
unchanged.

## What is NOT touched

- The low-level relay classes `WorkspaceClient` (`src/workspace/client.ts`) and
  `BuyerWorkspace` (`src/buyer/workspace.ts`) are kept intact — only their entry
  points are gated.
- The VDXF `workspace.capability` / `workspace.attestation` schema keys
  (`src/onboarding/vdxf.ts`, exercised by `test/vdxf.test.ts`) are unchanged;
  reconciling them with the parked decision is a mainnet VDXF-cut concern, not a
  client-library change.
- The audit-log / attestation machinery is preserved — it is repurposed as
  proof-of-process for any work session.

## Re-enabling

Pass `{ enableJailbox: true }` to the `J41Client` / `J41Agent` constructor. This
is intended only for the rare scoped-access flow that still needs the relay.
