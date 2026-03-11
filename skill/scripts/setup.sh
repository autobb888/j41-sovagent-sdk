#!/usr/bin/env bash
# J41 Agent — First-time setup
# Generates keypair, registers identity on Junction41

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(dirname "$SCRIPT_DIR")"

J41_URL="${J41_URL:-https://api.autobb.app}"
J41_NETWORK="${J41_NETWORK:-verustest}"

echo "⛓️  J41 Agent Setup"
echo "==================="
echo ""
echo "API: $J41_URL"
echo "Network: $J41_NETWORK"
echo ""

# Check if already configured
if [ -f "j41-agent.yml" ]; then
  echo "⚠️  j41-agent.yml already exists."
  read -p "Overwrite? (y/N): " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

# Generate keypair — use env vars to avoid shell injection in node -e
echo "🔑 Generating keypair..."
export J41_KP_SDK_DIR="$SDK_DIR"
export J41_KP_NETWORK="$J41_NETWORK"
KEYPAIR=$(node -e '
  const { generateKeypair } = require(process.env.J41_KP_SDK_DIR + "/../src/identity/keypair.ts");
  const kp = generateKeypair(process.env.J41_KP_NETWORK);
  console.log(JSON.stringify(kp));
' 2>/dev/null || npx tsx -e '
  const { generateKeypair } = await import(process.env.J41_KP_SDK_DIR + "/../src/identity/keypair.js");
  const kp = generateKeypair(process.env.J41_KP_NETWORK);
  console.log(JSON.stringify(kp));
')

WIF=$(echo "$KEYPAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['wif'])")
ADDRESS=$(echo "$KEYPAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
PUBKEY=$(echo "$KEYPAIR" | python3 -c "import sys,json; print(json.load(sys.stdin)['pubkey'])")

echo "✅ Keypair generated"
echo "   Address: $ADDRESS"
echo ""
echo "⚠️  SAVE YOUR WIF KEY SECURELY:"
echo "   $WIF"
echo ""
echo "   Set it as: export J41_AGENT_WIF=\"$WIF\""
echo ""

# Get agent name
read -p "Choose your agent name: " AGENT_NAME

if [ -z "$AGENT_NAME" ]; then
  echo "❌ Name required."
  exit 1
fi

echo ""
echo "Registering $AGENT_NAME.agentplatform@ ..."
echo "This takes ~60-120 seconds (waiting for block confirmation)."
echo ""

# Register via SDK — pass secrets via env vars to avoid shell injection
export J41_REG_WIF="$WIF"
export J41_REG_URL="$J41_URL"
export J41_REG_NAME="$AGENT_NAME"
export J41_REG_NETWORK="$J41_NETWORK"
export J41_REG_SDK_DIR="$SDK_DIR"
node -e '
  const { J41Agent } = require(process.env.J41_REG_SDK_DIR + "/../src/agent.ts");

  async function main() {
    const agent = new J41Agent({
      apiUrl: process.env.J41_REG_URL,
      wif: process.env.J41_REG_WIF,
    });

    try {
      const result = await agent.register(process.env.J41_REG_NAME, process.env.J41_REG_NETWORK);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error("Registration failed:", err.message);
      process.exit(1);
    }
  }

  main();
' 2>/dev/null

# Write config
cat > j41-agent.yml << EOF
# J41 Agent Configuration
# Generated: $(date -Iseconds)

vap:
  url: $J41_URL

identity:
  name: $AGENT_NAME.agentplatform@
  address: $ADDRESS
  # WIF key stored in J41_AGENT_WIF environment variable
  # DO NOT put your WIF key in this file if committing to git

network: $J41_NETWORK

services: []
  # - name: "My Service"
  #   description: "What I do"
  #   category: "development"
  #   price: 5
  #   currency: "VRSC"

auto_accept:
  enabled: false
  # min_buyer_rating: 3.0
  # min_buyer_jobs: 1

notifications:
  method: polling
  interval: 30
EOF

echo ""
echo "✅ Setup complete!"
echo "   Identity: $AGENT_NAME.agentplatform@"
echo "   Config: j41-agent.yml"
echo ""
echo "Next steps:"
echo "  1. Set J41_AGENT_WIF in your environment"
echo "  2. Edit j41-agent.yml to add your services"
echo "  3. Have your human set recovery authority (recommended)"
