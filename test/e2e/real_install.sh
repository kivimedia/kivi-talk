#!/usr/bin/env bash
# The real install path, in a throwaway Claude config so nothing of the machine's own setup is
# touched: add this repo as a marketplace, install talk-to-claude@kivimedia with both plugin
# options set the way the install prompt sets them, and prove they reach the MCP server (the
# ${user_config.*} path in .mcp.json; Claude Code does not export CLAUDE_PLUGIN_OPTION_* to MCP
# servers). A fake key is used: nothing here calls OpenAI.
# Needs a logged-in `claude` (CLAUDE_CODE_OAUTH_TOKEN or a wrapper that provides it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$WORK/cfg"
mkdir -p "$CLAUDE_CONFIG_DIR" "$WORK/proj"
cat > "$CLAUDE_CONFIG_DIR/.claude.json" <<EOF
{"hasCompletedOnboarding": true, "theme": "dark", "projects": {"$WORK/proj": {"hasTrustDialogAccepted": true}}}
EOF
FAKE_KEY="sk-test-$(head -c 30 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)ABCD"
claude plugin marketplace add "$ROOT" 2>&1 | tail -1
claude plugin install talk-to-claude@kivimedia --config keep_transcripts=true --config "openai_api_key=$FAKE_KEY" 2>&1 | tail -1
cd "$WORK/proj"
# stream-json carries the raw tool results; plain -p output is only Claude's final summary.
OUT="$(TTC_NO_BROWSER=1 TTC_URL_FILE="$WORK/url" timeout 180 claude -p --output-format stream-json --verbose \
  "First call call_start, then call_status, then call call_end." 2>&1 || true)"
echo "$OUT" | grep -oE 'keepTranscripts[^,]*|keySource[^,]*' | sort -u
if echo "$OUT" | grep -q "${FAKE_KEY}"; then echo "FAIL: the key appeared in Claude's output"; rm -rf "$WORK"; exit 1; fi
rm -rf "$WORK"
echo "$OUT" | grep -qE 'keepTranscripts[^,]*true' && echo "$OUT" | grep -qE 'keySource[^,]*plugin setting'
