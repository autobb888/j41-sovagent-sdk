#!/usr/bin/env bash
# J41 Agent — Health check
set -euo pipefail

CONFIG_DIR="${HOME}/.j41-agent"
CONFIG_FILE="${CONFIG_DIR}/config.yml"
J41_URL="${J41_URL:-https://api.junction41.io}"

echo "⚡ J41 Agent Health Check"
echo "========================="
echo ""

# Check config
if [ -f "$CONFIG_FILE" ]; then
  echo "✅ Config: $CONFIG_FILE"
  J41_URL=$(grep -m1 'url:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "$J41_URL")
  AGENT_NAME=$(grep -m1 'name:' "$CONFIG_FILE" 2>/dev/null | head -1 | awk '{print $2}' || echo "unknown")
  echo "   Agent: $AGENT_NAME"
  echo "   API: $J41_URL"
else
  echo "❌ Config: not found (run setup.sh)"
fi
echo ""

# Check API
echo "🌐 API Health:"
HEALTH=$(curl -sf "${J41_URL}/v1/health" 2>/dev/null || echo '{"error":"unreachable"}')
if echo "$HEALTH" | grep -q '"status"'; then
  echo "   ✅ API is reachable"
  echo "   $HEALTH" | head -1
else
  echo "   ❌ API unreachable at $J41_URL"
fi
echo ""

# Check SDK
echo "📦 SDK:"
if node -e "const p = require('@junction41/sovagent-sdk/package.json'); console.log('   Version:', p.version)" 2>/dev/null; then
  echo "   ✅ Installed"
else
  echo "   ❌ Not installed (run: yarn add @junction41/sovagent-sdk)"
fi
echo ""

# Check WIF
echo "🔑 Key:"
if [ -n "${J41_AGENT_WIF:-}" ]; then
  echo "   ✅ WIF set via environment variable"
elif [ -f "$CONFIG_FILE" ] && grep -q 'wif:' "$CONFIG_FILE" 2>/dev/null; then
  echo "   ✅ WIF found in config file"
else
  echo "   ❌ No WIF key configured"
fi
echo ""

echo "Done."
