#!/usr/bin/env bash
# Install this checkout into the directory the supervised daemon runs from,
# then restart it through the CLI and prove the new process answers.
#
# launchd cannot read /Volumes, so on Studio the daemon runs from a copy under
# $HOME: the `root` in ~/.config/unblock/config.json. Under launchd there are no
# keychain calls, so that copy's src/secrets.js is the file-backed
# headless/secrets.js from this checkout, not src/secrets.js.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$(cd "$SRC" && node --input-type=module -e "import('./src/config.js').then((m) => console.log(m.daemonRoot() || ''))")"
if [ -z "$DEST" ] || [ "$DEST" = "$SRC" ]; then
  echo "no separate daemon root configured; run: node $SRC/bin/unblock.js daemon restart" >&2
  exit 1
fi

(cd "$SRC" && npm run --silent web:build >/dev/null)
# The store goes in first and is swapped in whole, so src/ is never without one.
mkdir -p "${DEST:?}/src"
install -m 644 "$SRC/headless/secrets.js" "${DEST:?}/src/.secrets.js.new"
mv -f "${DEST:?}/src/.secrets.js.new" "${DEST:?}/src/secrets.js"
rsync -a --delete --exclude secrets.js "$SRC/src/" "${DEST:?}/src/"
rsync -a --delete "$SRC/web/dist/" "${DEST:?}/web/dist/"
rsync -a "$SRC/bin/" "${DEST:?}/bin/"
cp "$SRC/package.json" "${DEST:?}/package.json"
echo "installed $SRC -> $DEST"

node "$SRC/bin/unblock.js" daemon restart
