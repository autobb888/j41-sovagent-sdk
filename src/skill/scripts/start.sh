#!/usr/bin/env bash
# J41 Agent — Start polling for jobs
set -euo pipefail

CONFIG_DIR="${HOME}/.j41-agent"
CONFIG_FILE="${CONFIG_DIR}/config.yml"
LOG_FILE="${CONFIG_DIR}/agent.log"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "No config found. Run setup.sh first."
  exit 1
fi

echo "J41 Agent — Starting job listener"
echo "  Config: $CONFIG_FILE"
echo "  Logs: $LOG_FILE"
echo "  Press Ctrl+C to stop"
echo ""

# Start the polling agent — pass config path via env var to avoid shell injection
export J41_CONFIG_FILE="$CONFIG_FILE"
exec node -e '
const fs = require("fs");

const configPath = process.env.J41_CONFIG_FILE;
if (!configPath) { console.error("J41_CONFIG_FILE not set"); process.exit(1); }

const config = fs.readFileSync(configPath, "utf8");
// Simple YAML parsing for key fields
const wif = config.match(/wif:\s*(.+)/)?.[1]?.trim();
const url = config.match(/url:\s*(.+)/)?.[1]?.trim() || "https://api.junction41.io";
const name = config.match(/name:\s*(.+)/)?.[1]?.trim();
const interval = parseInt(config.match(/poll_interval:\s*(\d+)/)?.[1] || "30") * 1000;

if (!wif) { console.error("No WIF key in config"); process.exit(1); }

const { J41Agent } = require("@junction41/sovagent-sdk");
const agent = new J41Agent({ apiUrl: url, wif: wif, identityName: name });

console.log("Agent:", name || "unnamed");
console.log("API:", url);
console.log("Poll interval:", interval/1000, "seconds");
console.log("");

async function poll() {
  try {
    const res = await agent.client.getMyJobs({ status: "requested", role: "seller" });
    const jobs = res.data || [];
    if (jobs.length > 0) {
      for (const job of jobs) {
        console.log("[" + new Date().toISOString() + "] New job:", job.id, "-", job.description?.slice(0, 80));
      }
    }
  } catch (err) {
    console.error("[" + new Date().toISOString() + "] Poll error:", err.message);
  }
}

poll();
setInterval(poll, interval);
console.log("Listening for jobs...");
' 2>&1 | tee -a "$LOG_FILE"
