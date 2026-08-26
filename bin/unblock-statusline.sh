#!/usr/bin/env bash
# Prints a statusline segment when something is waiting on you, and nothing at
# all when the queue is clear — a segment that is always visible stops being
# read. Add it to an existing statusline script:
#
#   seg=$(~/.../unblock/bin/unblock-statusline.sh) && [ -n "$seg" ] && out="$out │ $seg"
#
# Never starts the daemon. If it is not running, there is nothing to report.
set -euo pipefail

state_dir="${UNBLOCK_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/unblock}"
daemon_file="$state_dir/daemon.json"
[ -f "$daemon_file" ] || exit 0

port="${UNBLOCK_PORT:-$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$daemon_file")}"
[ -n "$port" ] || exit 0

json=$(curl -sS --max-time 1 "http://127.0.0.1:$port/api/asks?profile=%2A" 2>/dev/null) || exit 0
[ -n "$json" ] || exit 0

counts=$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    asks = json.load(sys.stdin).get("asks", [])
except Exception:
    sys.exit(0)
opened = [a for a in asks if a.get("status") == "open"]
print(len(opened), sum(1 for a in opened if a.get("gating")))
' 2>/dev/null) || exit 0
[ -n "$counts" ] || exit 0

set -- $counts
open=$1
gating=$2
[ "$open" -gt 0 ] || exit 0

if [ "${NO_COLOR:-}" = "" ] && [ "$gating" -gt 0 ]; then
  printf '\033[38;5;202m!%s blocked\033[0m' "$gating"
elif [ "$gating" -gt 0 ]; then
  printf '!%s blocked' "$gating"
elif [ "$open" -eq 1 ]; then
  printf '1 ask'
else
  printf '%s asks' "$open"
fi
