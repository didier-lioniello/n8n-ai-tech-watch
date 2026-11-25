#!/usr/bin/env bash
# Import the workflow into a local n8n instance and execute it once.
# Requires the `n8n` CLI (npm i -g n8n, or set N8N_BIN).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
N8N_BIN="${N8N_BIN:-n8n}"

if ! command -v "$N8N_BIN" >/dev/null 2>&1; then
  echo "n8n CLI not found. Install it with: npm i -g n8n" >&2
  exit 1
fi

export N8N_BLOCK_ENV_ACCESS_IN_NODE="${N8N_BLOCK_ENV_ACCESS_IN_NODE:-false}"
export N8N_RESTRICT_FILE_ACCESS_TO="${N8N_RESTRICT_FILE_ACCESS_TO:-$HOME/.n8n-files;/tmp}"
export DIGEST_PATH="${DIGEST_PATH:-/tmp/ai-tech-watch-digest.md}"
mkdir -p "$(dirname "$DIGEST_PATH")" "$HOME/.n8n-files"

echo "Importing workflow..."
"$N8N_BIN" import:workflow --input="$ROOT/workflow/ai-tech-watch.json"

mapfile -t IDS < <("$N8N_BIN" list:workflow --onlyId 2>/dev/null || true)
if [[ ${#IDS[@]} -eq 0 ]]; then
  echo "Could not read a workflow id from n8n list:workflow." >&2
  exit 1
fi
ID="${IDS[-1]}"

echo "Executing workflow ${ID}..."
"$N8N_BIN" execute --id="$ID"
echo "If the run succeeded, the digest is at: $DIGEST_PATH"
