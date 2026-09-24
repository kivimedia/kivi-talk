#!/usr/bin/env bash
# Linux only, needs sudo: another OS account must not be able to use a call, even holding the
# one-time link (which it could read from a browser's argv in /proc). Runs a real bridge as the
# current user, then tries the link as `nobody`, then as the owner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; chmod 755 "$WORK"
export TTC_NO_BROWSER=1 TTC_DATA_DIR="$WORK/data" TTC_URL_FILE="$WORK/url"
coproc BRIDGE { node "$ROOT/server/bridge.mjs"; }
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"call_start","arguments":{}}}' >&"${BRIDGE[1]}"
for _ in $(seq 1 50); do [ -s "$WORK/url" ] && break; sleep 0.1; done
URL="$(cat "$WORK/url")"
as_other="$(sudo -u nobody curl -s -o /dev/null -w '%{http_code}' "$URL")"
as_owner="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
echo "other account: $as_other (want 403)  owner: $as_owner (want 302)"
kill "$BRIDGE_PID" 2>/dev/null || true
rm -rf "$WORK"
[ "$as_other" = 403 ] && [ "$as_owner" = 302 ]
