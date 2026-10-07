#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != '--no-build' ]; }; then
  echo "Usage: $0 <agent-rails checkout> [--no-build]" >&2
  exit 2
fi

checkout=$(CDPATH= cd -- "$1" && pwd) || exit 2
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

if [ ! -d "$checkout/app/admin_static" ]; then
  echo "Missing agent-rails directory: $checkout/app/admin_static" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  npm run build:scope-bundle
fi
if [ ! -f web/dist-scope/index.html ]; then
  echo "Missing scope bundle: web/dist-scope/index.html" >&2
  exit 2
fi

parent=$checkout/app/admin_static
new=$parent/.scope-new.$$
old=$parent/.scope-old.$$
trap 'rm -rf "$new"' 0
trap 'exit 1' HUP INT TERM
mkdir "$new"
cp -R web/dist-scope/. "$new/"
commit=$(git rev-parse --short HEAD)
printf '{"source":"unblock","commit":"%s","built":"npm run build:scope-bundle"}\n' "$commit" > "$new/BUNDLE.json"

if [ -e "$parent/scope" ]; then
  mv "$parent/scope" "$old"
fi
if ! mv "$new" "$parent/scope"; then
  if [ -e "$old" ]; then
    mv "$old" "$parent/scope"
  fi
  exit 1
fi
if [ -e "$old" ]; then
  rm -rf "$old"
fi
printf 'Scope bundle: %s files\n' "$(find "$parent/scope" -type f | wc -l | tr -d ' ')"
cat "$parent/scope/BUNDLE.json"
