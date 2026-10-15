#!/usr/bin/env bash
# Build the Android debug APK (development build) and print the APK path.
#
#   scripts/build_android.sh            dev build (frontend + cap sync + gradle)
#   scripts/build_android.sh --install  ... then adb install -r
#   scripts/build_android.sh --run      ... then install and launch the app
#   scripts/build_android.sh --skip-frontend  Gradle-only rebuild of the previous bundle
#   scripts/build_android.sh --stable-apk     build the stable versionName/versionCode
#                                             (release-prep builds only)
#
# Versioning (VERSIONING.md §4): requires a selected development core
# (scripts/version.sh bump <kind> or set X.Y.Z-dev) unless --stable-apk is
# passed. Each build gets a unique build ID and is archived under
# dist/dev/<version>/<build-id>/ with build-manifest.json and a source patch
# snapshot; the gradle version fields are stamped only for the build and
# restored afterwards, so no tracked version file changes. The last line of
# output is the exact path of the freshly assembled APK.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

node scripts/build-apk.mjs "$@"

APK="$REPO/apps/android/android/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "build_android.sh: APK not found after a successful build: $APK" >&2
  exit 1
fi
# Final output line: the exact APK path.
echo "APK: $APK"