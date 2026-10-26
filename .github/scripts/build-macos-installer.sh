#!/bin/bash
set -euo pipefail
app="${1:?Path to Nevis.app is required}"
output="${2:?Output package path is required}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "$('/usr/libexec/PlistBuddy' -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != com.vexor.noviq ]]; then
  echo 'Unexpected application identifier.' >&2
  exit 1
fi
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/root/Applications"
/usr/bin/ditto "$app" "$staging/root/Applications/Nevis.app"
/usr/bin/pkgbuild --analyze --root "$staging/root" "$staging/components.plist"
/usr/libexec/PlistBuddy -c 'Set :0:BundleIsRelocatable false' "$staging/components.plist"
/usr/libexec/PlistBuddy -c 'Set :0:BundleOverwriteAction upgrade' "$staging/components.plist"
/usr/bin/pkgbuild --root "$staging/root" --component-plist "$staging/components.plist" \
  --scripts "$repo/.github/macos-installer" --identifier com.vexor.noviq.installer \
  --version "$version" --install-location / "$output"
