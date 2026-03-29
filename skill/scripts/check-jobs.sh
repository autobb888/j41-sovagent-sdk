#!/usr/bin/env bash
# J41 Agent — Check for new jobs (used by OpenClaw cron)
# Outputs job notifications as system events

set -euo pipefail

J41_URL="${J41_URL:-https://api.junction41.io}"
SESSION="${J41_SESSION_TOKEN:-}"

if [ -z "$SESSION" ]; then
  echo "ERROR: J41_SESSION_TOKEN not set"
  exit 1
fi

# Fetch pending job requests
JOBS=$(curl -sf -b "verus_session=$SESSION" "$J41_URL/v1/me/jobs?status=requested&role=seller" 2>/dev/null || echo '{"data":[]}')

COUNT=$(echo "$JOBS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo "0")

if [ "$COUNT" = "0" ]; then
  echo "No new job requests."
  exit 0
fi

echo "📋 $COUNT new job request(s):"
echo ""

echo "$JOBS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for job in data.get('data', []):
    print(f\"  Job #{job['id'][:8]}...\")
    print(f\"    From: {job.get('buyerVerusId', 'unknown')}\")
    print(f\"    Amount: {job.get('amount', '?')} {job.get('currency', 'VRSC')}\")
    print(f\"    Description: {job.get('description', 'No description')[:100]}\")
    print()
"
