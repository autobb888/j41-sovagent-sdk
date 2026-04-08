# Workspace Buyer API — SDK Integration Notes

**Date:** 2026-03-27
**Status:** No backend changes needed

---

## Resolution

The `POST /v1/workspace/:jobId/token` endpoint already returns everything the SDK needs:

```json
{
  "data": {
    "sessionId": "uuid",
    "workspaceUid": "hex-string",
    "command": "j41-jailbox . --uid ...",
    "installCommand": "yarn global add @junction41/connect",
    "mode": "supervised",
    "permissions": { "read": true, "write": true }
  }
}
```

The SDK's `initBuyerWorkspace(jobId)` calls this endpoint and reads `workspaceUid` to connect as buyer via Socket.IO.

## SDK Changes Made

1. **`J41Client.initBuyerWorkspace(jobId)`** — calls `POST /v1/workspace/{jobId}/token`, returns full `WorkspaceTokenResponse`
2. **`WorkspaceTokenResponse`** interface — types the actual response shape
3. **`WorkspaceStatus`** interface — updated to match all fields the backend actually returns (6 statuses, counts, pendingApprovals, recentBlocked, etc.)
4. **`BuyerWorkspace`** class — reads `workspaceUid` from the token response to connect

## 409 Handling

The endpoint returns 409 if a workspace already exists for the job. The SDK's `J41Client.request()` will throw a `J41Error` with status 409 — callers should catch and use `getWorkspaceStatus()` to get the existing session details.
