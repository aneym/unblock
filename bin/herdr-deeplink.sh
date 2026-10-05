#!/bin/sh
# herdr:// URL scheme handler.
#
# Installed to ~/.local/bin/herdr-deeplink by bin/herdr-deeplink-install.sh and
# invoked by "Herdr Link.app" (an osacompile applet registered for the herdr://
# scheme) whenever a browser link is clicked.
#
# Accepted forms:
#   herdr://focus?pane=w4D:p8&tab=w4D:t8&workspace=w4D
#   herdr://focus/w4D:p8
#
# Focus order: agent/pane first, then tab, then workspace. The first one that
# succeeds wins; later ones are fallbacks for a pane that has since closed.
# Ends by activating the Herdr terminal app so the jump is visible.

LOG="${HOME}/.cache/herdr-deeplink.log"
mkdir -p "${HOME}/.cache"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

URL="$1"
[ -n "$URL" ] || { log "no url given"; exit 1; }

# Percent-decode the only characters that appear in herdr ids.
decode() { printf '%s' "$1" | sed -e 's/%3[Aa]/:/g' -e 's/%2[Ff]/\//g'; }

REST="${URL#herdr://}"
ACTION="${REST%%[/?]*}"

param() { printf '%s' "$REST" | sed -n "s/.*[?&]$1=\([^&]*\).*/\1/p"; }

PANE="$(decode "$(param pane)")"
TAB="$(decode "$(param tab)")"
WORKSPACE="$(decode "$(param workspace)")"

# Path form: herdr://focus/w4D:p8
if [ -z "$PANE" ]; then
  case "$REST" in
    */*) PANE="$(decode "${REST#*/}")"; PANE="${PANE%%\?*}" ;;
  esac
fi

case "$ACTION" in
  focus) ;;
  *) log "unknown action in $URL"; exit 1 ;;
esac

HERDR="${HOME}/.local/bin/herdr"
# Local herdr server first; when this machine has none (the macbook attaches to
# the studio's server), relay the focus command over ssh instead.
run() {
  if [ -x "$HERDR" ] && env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH "$HERDR" "$@" >> "$LOG" 2>&1; then
    return 0
  fi
  ssh -o ConnectTimeout=5 -o BatchMode=yes studio-ts "~/.local/bin/herdr $*" >> "$LOG" 2>&1
}

DONE=1
if [ -n "$PANE" ] && run agent focus "$PANE"; then
  log "focused pane $PANE"
  DONE=0
elif [ -n "$TAB" ] && run tab focus "$TAB"; then
  log "pane gone; focused tab $TAB"
  DONE=0
elif [ -n "$WORKSPACE" ] && run workspace focus "$WORKSPACE"; then
  log "tab gone; focused workspace $WORKSPACE"
  DONE=0
else
  log "nothing focusable in $URL"
fi

# Bring the herdr terminal forward either way, so the click always lands you
# in Herdr even when the target is gone. Activate the RUNNING instance by pid
# via System Events: `open` sends a macOS reopen event, which makes Ghostty
# spawn a brand-new window. Cold-start by bundle id only when nothing runs
# (studio: Herdr Studio.app; macbook: HerdrTerm.app, the herdr-identity
# Ghostty copy — never plain Ghostty, that is Alex's normal terminal).
PID="$(pgrep -f 'Herdr Studio\.app/Contents/MacOS|HerdrTerm\.app/Contents/MacOS' | head -1)"
if [ -n "$PID" ]; then
  # Needs the one-time Automation consent ("Herdr Link" controlling System
  # Events). If it is denied, do NOT fall back to `open` on a running app —
  # that reopen spawns a new window, which is worse than staying put.
  osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $PID) to true" >> "$LOG" 2>&1 \
    || log "activation skipped: grant Herdr Link the System Events automation permission"
else
  open -b com.aneyman.herdr-studio 2>> "$LOG" || open -b com.aneyman.herdr-ghostty 2>> "$LOG"
fi
exit $DONE
