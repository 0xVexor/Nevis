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
# pkgbuild may omit keys, or omit non-Mach-O fixture bundles entirely. Pin the validated app explicitly.
/usr/bin/python3 - "$staging/components.plist" <<'PYTHON'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as source:
    components = plistlib.load(source)
target = next((item for item in components if item.get('RootRelativeBundlePath') == 'Applications/Nevis.app'), None)
if target is None:
    target = {'RootRelativeBundlePath': 'Applications/Nevis.app', 'BundleHasStrictIdentifier': True}
    components.append(target)
for component in components:
    component['BundleIsRelocatable'] = False
target['BundleOverwriteAction'] = 'upgrade'
with open(path, 'wb') as destination:
    plistlib.dump(components, destination)
PYTHON
/usr/bin/pkgbuild --root "$staging/root" --component-plist "$staging/components.plist" \
  --scripts "$repo/.github/macos-installer" --identifier com.vexor.noviq.installer \
  --version "$version" --install-location / "$output"
