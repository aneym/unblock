#!/usr/bin/env bash
# Restart the daemon and do not lie about it.
#
# Written after the third silent failure of `kill $pid; node src/daemon.js &`:
# the old process had not released the port yet, the new one died on
# EADDRINUSE, and the OLD daemon kept serving — without the new environment.
# Everything looked fine and behaved wrong.
#
# So: kill, WAIT for the port to actually free, start, then prove the new
# process is the one answering before returning success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${UNBLOCK_PORT:-4488}"
STATE="${UNBLOCK_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/unblock}"

for pid in $(lsof -ti :"$PORT" 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

for _ in $(seq 1 40); do
  lsof -ti :"$PORT" >/dev/null 2>&1 || break
  sleep 0.25
done
if lsof -ti :"$PORT" >/dev/null 2>&1; then
  for pid in $(lsof -ti :"$PORT"); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi
if lsof -ti :"$PORT" >/dev/null 2>&1; then
  echo "port $PORT is still held; refusing to start a daemon that would die silently" >&2
  exit 1
fi

nohup node "$ROOT/src/daemon.js" >"${UNBLOCK_LOG:-/tmp/unblock-daemon.log}" 2>&1 &
started=$!

for _ in $(seq 1 40); do
  sleep 0.25
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    live=$(python3 -c "import json;print(json.load(open('$STATE/daemon.json'))['pid'])" 2>/dev/null || echo '')
    if [ "$live" = "$started" ]; then
      echo "daemon $started on :$PORT · public_origin=${UNBLOCK_PUBLIC_ORIGIN:-none}"
      exit 0
    fi
    echo "another daemon (pid $live) answered, not the one just started" >&2
    exit 1
  fi
done

echo "daemon did not come up; see ${UNBLOCK_LOG:-/tmp/unblock-daemon.log}" >&2
tail -5 "${UNBLOCK_LOG:-/tmp/unblock-daemon.log}" >&2 || true
exit 1
