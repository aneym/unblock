#!/bin/sh
# Install the herdr:// URL scheme handler on macOS.
#
# Builds a tiny AppleScript applet ("Herdr Link.app"), registers it for the
# herdr:// scheme with LaunchServices, and installs the shell handler it calls
# to ~/.local/bin/herdr-deeplink. Idempotent; rerun after changing the handler.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${HOME}/Applications/Herdr Link.app"
BIN="${HOME}/.local/bin/herdr-deeplink"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

mkdir -p "${HOME}/.local/bin" "${HOME}/Applications"
cp "$ROOT/bin/herdr-deeplink.sh" "$BIN"
chmod 755 "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/handler.applescript" <<'APPLESCRIPT'
on open location theURL
	do shell script "$HOME/.local/bin/herdr-deeplink " & quoted form of theURL & " >/dev/null 2>&1 &"
end open location

on run
	-- Launched directly (not via a URL): nothing to do.
end run
APPLESCRIPT

rm -rf "$APP"
osacompile -o "$APP" "$TMP/handler.applescript"

PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.aneyman.herdr-link" "$PLIST"
plutil -replace CFBundleURLTypes -json '[{"CFBundleURLName":"Herdr deep link","CFBundleURLSchemes":["herdr"]}]' "$PLIST"

"$LSREGISTER" -f "$APP"
echo "installed: $APP (scheme herdr:// -> $BIN)"
