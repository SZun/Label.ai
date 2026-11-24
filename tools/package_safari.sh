#!/usr/bin/env bash
# Create a fresh, reviewable macOS and iOS Xcode project. Signing is handled in Xcode.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
webext="${1:-$root/apps/extension/.output/safari-mv3}"
destination="${2:-$root/dist/safari-xcode}"
[[ -f "$webext/manifest.json" ]] || { echo "Build the Safari target first (missing manifest at $webext)." >&2; exit 2; }
[[ ! -e "$destination" ]] || { echo "Select a new output directory; $destination already exists." >&2; exit 2; }
command -v xcrun >/dev/null || { echo "The Apple packager requires macOS and Xcode." >&2; exit 2; }
tool=safari-web-extension-packager
if ! xcrun --find "$tool" >/dev/null 2>&1; then tool=safari-web-extension-converter; fi
mkdir -p "$(dirname "$destination")"
xcrun "$tool" "$webext" --project-location "$destination" --app-name "Label AI" \
  --bundle-identifier "${LABEL_APP_IDENTIFIER:-org.labelai.webextension}" --swift --copy-resources --no-open --no-prompt
