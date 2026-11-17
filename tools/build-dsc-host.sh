#!/bin/sh
# Rebuild the DSC helper downloads (needs Go 1.24+). Output: ca-desk-dsc-helper-windows.zip and ca-desk-dsc-helper-mac.zip in the repo root.
set -e
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
mkdir -p "$OUT/win" "$OUT/mac"
(cd dsc-host && for t in windows/amd64 windows/386 darwin/arm64 darwin/amd64; do
  os=${t%/*}; arch=${t#*/}; ext=""; [ "$os" = windows ] && ext=".exe"; d=win; [ "$os" = darwin ] && d=mac
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT/$d/cadesk-dsc-host-$os-$arch$ext" .
done)
cp dsc-host/packaging/windows/* dsc-host/packaging/libs.txt dsc-host/packaging/README.txt "$OUT/win/"
cp dsc-host/packaging/mac/* dsc-host/packaging/libs.txt dsc-host/packaging/README.txt "$OUT/mac/"
rm -f ca-desk-dsc-helper-windows.zip ca-desk-dsc-helper-mac.zip
(cd "$OUT/win" && zip -qr "$OLDPWD/ca-desk-dsc-helper-windows.zip" .)
(cd "$OUT/mac" && zip -qr "$OLDPWD/ca-desk-dsc-helper-mac.zip" .)
ls -la ca-desk-dsc-helper-*.zip
