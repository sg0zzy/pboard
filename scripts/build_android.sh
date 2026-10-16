#!/usr/bin/env bash
# Build a test-only Android APK; --install / --run use adb explicitly. See BUILD.md.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/build-apk.mjs" "$@"
