#!/bin/bash
# CA Desk DSC helper — installs for the current Mac user (no administrator rights needed).
set -e
EXT='ajnklhalmnpmiafebnoebjmjbmbgldoa'
NAME='in.cadesk.dsc'
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/CADeskDSC"
mkdir -p "$DEST"
cp -f "$SRC"/cadesk-dsc-host-darwin-* "$DEST/"
cp -f "$SRC/README.txt" "$DEST/" 2>/dev/null || true
[ -f "$DEST/libs.txt" ] || cp "$SRC/libs.txt" "$DEST/libs.txt"
chmod +x "$DEST"/cadesk-dsc-host-darwin-*
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
if [ "$(uname -m)" = "arm64" ]; then A=arm64; else A=amd64; fi
EXE="$DEST/cadesk-dsc-host-darwin-$A"
[ -x "$EXE" ] || { echo "Missing $EXE"; exit 1; }
for D in "Google/Chrome" "Google/Chrome Beta" "Microsoft Edge" "BraveSoftware/Brave-Browser" "Chromium"; do
  P="$HOME/Library/Application Support/$D"
  [ -d "$P" ] || continue
  mkdir -p "$P/NativeMessagingHosts"
  cat > "$P/NativeMessagingHosts/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "CA Desk DSC helper",
  "path": "$EXE",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT/"]
}
JSON
done
echo
echo "DSC helper installed."
echo "Now: Chrome -> chrome://extensions -> reload CA Desk Helper (version 1.6 or later), then in CA Desk open DSC register and click 'Read from token'."
