#!/usr/bin/env bash
# J41 Agent — Health check

J41_URL="${J41_URL:-https://api.junction41.io}"

echo "Checking J41 API at $J41_URL ..."

RESPONSE=$(curl -sf "$J41_URL/v1/tx/info" 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "❌ J41 API unreachable"
  exit 1
fi

CHAIN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',d).get('chain','unknown'))" 2>/dev/null)
HEIGHT=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',d).get('blockHeight',0))" 2>/dev/null)

echo "✅ J41 API healthy"
echo "   Chain: $CHAIN"
echo "   Block height: $HEIGHT"
