#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HERMES_HOME=${HERMES_HOME:-"$HOME/.hermes"}
PLUGIN_LINK="$HERMES_HOME/plugins/unblock"
SKILL_LINK="$HERMES_HOME/skills/unblock"

mkdir -p "$HERMES_HOME/plugins" "$HERMES_HOME/skills"

link_canonical() {
  target=$1
  link=$2
  if [ -e "$link" ] || [ -L "$link" ]; then
    current=$(readlink "$link" 2>/dev/null || true)
    if [ "$current" != "$target" ]; then
      echo "refusing to replace existing $link" >&2
      exit 1
    fi
    return
  fi
  ln -s "$target" "$link"
}

link_canonical "$ROOT" "$PLUGIN_LINK"
link_canonical "$ROOT/skills/unblock" "$SKILL_LINK"

HERMES_HOME="$HERMES_HOME" hermes plugins enable unblock --no-allow-tool-override
HERMES_HOME="$HERMES_HOME" hermes plugins doctor "$ROOT"

printf '%s\n' \
  "Unblock is linked from $ROOT" \
  "Plugin: $PLUGIN_LINK" \
  "Skill:  $SKILL_LINK" \
  "Start a fresh Hermes session (or restart the active surface) to load it."