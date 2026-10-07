#!/usr/bin/env bash
# Stage a complete headless install, prove its CLI imports, then replace the
# supervised copy. A failed build or import leaves the old install untouched.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$(cd "$SRC" && node --input-type=module -e "import('./src/config.js').then((m) => console.log(m.daemonRoot() || ''))")"
if [ -z "$DEST" ] || [ "$DEST" = "$SRC" ]; then
  echo "no separate daemon root configured; run: node $SRC/bin/unblock.js daemon restart" >&2
  exit 1
fi

PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"
STAGE="$(mktemp -d "$PARENT/.unblock-stage.XXXXXX")"
OLD=""
cleanup() {
  if [ -n "$OLD" ] && [ -d "$OLD" ] && [ ! -e "$DEST" ]; then mv "$OLD" "$DEST"; fi
  if [ -d "$STAGE" ]; then rm -rf "${STAGE:?}"; fi
}
trap cleanup EXIT
mkdir -p "$STAGE/src" "$STAGE/web"
rsync -a "$SRC/src/" "$STAGE/src/"
install -m 644 "$SRC/headless/secrets.js" "$STAGE/src/secrets.js"
rsync -a "$SRC/plugin/" "$STAGE/plugin/"
rsync -a "$SRC/bin/" "$STAGE/bin/"
cp "$SRC/package.json" "$STAGE/package.json"
(cd "$SRC" && npm run --silent web:build -- --outDir "$STAGE/web/dist" >/dev/null)
node "$STAGE/bin/unblock.js" scope --help >/dev/null
if [ -e "$DEST" ]; then
  OLD="$(mktemp -d "$PARENT/.unblock-old.XXXXXX")"
  rmdir "$OLD"
  mv "$DEST" "$OLD"
fi
mv "$STAGE" "$DEST"
if [ -n "$OLD" ]; then rm -rf "${OLD:?}"; OLD=""; fi
echo "installed $SRC -> $DEST"
node "$SRC/bin/unblock.js" daemon restart
