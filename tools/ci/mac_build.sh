#!/bin/bash
# Build the universal (Apple Silicon + Intel) macOS app: Switchboard.app, the .dmg people download, and
# Switchboard_<version>_universal.app.tar.gz (what the in-app updater fetches). Ad-hoc signed
# (tauri.macos.conf.json), not notarized. Prints APP= / DMG= / TAR= / VERSION= lines for $GITHUB_ENV.
#   tools/ci/mac_build.sh >> "$GITHUB_ENV"     (progress goes to stderr)
set -euo pipefail
cd "$(dirname "$0")/../.."
{
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  npm ci
  npm run tauri build -- --target universal-apple-darwin
} >&2
B=src-tauri/target/universal-apple-darwin/release/bundle
V=$(node -p "require('./package.json').version")
DMG=$(ls "$B"/dmg/*.dmg | head -1)
TAR="$B/macos/Switchboard_${V}_universal.app.tar.gz"
# COPYFILE_DISABLE: no AppleDouble ._ files in the archive.
COPYFILE_DISABLE=1 tar -czf "$TAR" -C "$B/macos" Switchboard.app
codesign -dv "$B/macos/Switchboard.app" >&2 || true
lipo -info "$B/macos/Switchboard.app/Contents/MacOS/switchboard" >&2
ls -l "$DMG" "$TAR" >&2
echo "APP=$PWD/$B/macos/Switchboard.app"
echo "DMG=$PWD/$DMG"
echo "TAR=$PWD/$TAR"
echo "VERSION=$V"
