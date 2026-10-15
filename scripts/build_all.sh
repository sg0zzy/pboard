#!/usr/bin/env bash
# Build all Pboard targets locally, implementing VERSIONING.md's local-build rules.
#
#   scripts/build_all.sh                 build Firefox, Chromium and Android (dev)
#   scripts/build_all.sh [target ...]    build only named targets:
#                                        firefox | chromium | android
#   scripts/build_all.sh --skip-android-build  Gradle-only Android rebuild
#                                        (reuses the previous frontend bundle)
#   scripts/build_all.sh --help
#
# Versioning behavior (contract §4):
#   - targets are development builds of the currently selected VERSION core
#     (`X.Y.Z-dev.N` for Android when a dev core is selected; Firefox/Chromium
#     zips carry the core version in their name as before);
#   - selecting a core is scripts/version.sh bump <kind> / set X.Y.Z-dev — never
#     done implicitly here; with a stable VERSION selected, only the Firefox and
#     Chromium targets build (Android dev builds require an explicit dev core);
#   - each Android build gets a unique build ID and is archived under
#     dist/dev/<version>/<build-id>/ with build-manifest.json; nothing is
#     overwritten, committed or tagged.
#
# Output: the last lines list one ARTIFACT per target. Exit code 0 only when
# every requested target built; failures name the target on stderr.
#
# Prerequisites: Node 24, npm ci at the repository root; for the Android target
# also ANDROID_HOME (SDK with platform android-36), JDK 21+ and
# apps/android/node_modules (npm ci there when cap is missing).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

targets=()
skip_android_build=false
for arg in "$@"; do
  case "$arg" in
    firefox|chromium|android) targets+=("$arg") ;;
    --skip-android-build) skip_android_build=true ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "build_all.sh: unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
if [ ${#targets[@]} -eq 0 ]; then
  targets=(firefox chromium android)
fi

if [ ! -d node_modules ]; then
  echo "build_all.sh: dependencies missing — run npm ci first" >&2
  exit 1
fi

version="$(node scripts/version.mjs preview)"
core="$(node -p "const v = process.argv[1]; v.split('-')[0]" "$version" 2>/dev/null || echo "$version" | sed 's/ .*//;s/-dev$//')"
core="${core%% *}"
echo "==> Building from ${version%% (*}"

fail() { echo "build_all.sh: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
artifacts=()
failed=()

for target in "${targets[@]}"; do
  case "$target" in
    firefox)
      step "Firefox: build, lint, package"
      # Build from the current sources first: packaging steps only verify/zip the
      # existing dist/ output, so a version bump would otherwise ship a stale one.
      if npm run build >/tmp/pboard-firefox.$$ 2>&1 && npm run package:firefox >>/tmp/pboard-firefox.$$ 2>&1; then
        zip_path="$(ls -t web-ext-artifacts/pboard-*.zip 2>/dev/null | grep -v chromium | head -n1 || true)"
        [ -n "$zip_path" ] || fail "Firefox packaging produced no pboard-*.zip"
        artifacts+=("ARTIFACT firefox: $zip_path (version $core, unsigned)")
        rm -f "/tmp/pboard-firefox.$$"
      else
        tail -n 20 /tmp/pboard-firefox.$$ >&2; rm -f /tmp/pboard-firefox.$$
        failed+=(firefox)
      fi
      ;;
    chromium)
      step "Chromium: build, package, verify"
      if npm run build:chromium >/tmp/pboard-chromium.$$ 2>&1 && npm run package:chromium >>/tmp/pboard-chromium.$$ 2>&1; then
        zip_path="$(ls -t web-ext-artifacts/pboard-chromium-*.zip 2>/dev/null | head -n1 || true)"
        [ -n "$zip_path" ] || fail "Chromium packaging produced no pboard-chromium-*.zip"
        artifacts+=("ARTIFACT chromium: $zip_path (version $core, unsigned)")
        rm -f "/tmp/pboard-chromium.$$"
      else
        tail -n 20 /tmp/pboard-chromium.$$ >&2; rm -f /tmp/pboard-chromium.$$
        failed+=(chromium)
      fi
      ;;
    android)
      if [[ "$version" != *"dev"* ]]; then
        step "Android: skipped — VERSION has no development core selected"
        echo "build_all.sh: select one first with scripts/version.sh bump <kind> (or set X.Y.Z-dev); pass the android target again afterwards" >&2
        failed+=(android)
        continue
      fi
      step "Android: frontend build, cap sync, dev APK"
      apk_args=()
      [ "$skip_android_build" = true ] && apk_args+=(--skip-frontend)
      if scripts/build_android.sh "${apk_args[@]}" >/tmp/pboard-build-android.$$ 2>&1; then
        apk="$(tail -n1 /tmp/pboard-build-android.$$ | sed 's/^APK: //')"
        [ "$(basename "$apk")" = "app-debug.apk" ] || fail "unexpected Android output: $apk"
        dev_version="$(grep -m1 '^build [0-9]' /tmp/pboard-build-android.$$ | awk '{print $2}')"
        artifacts+=("ARTIFACT android: $apk (dev ${dev_version:-<unknown>}, debug-signed; archived copy in dist/dev/${dev_version:-<unknown>}/)")
        rm -f "/tmp/pboard-build-android.$$"
      else
        tail -n 20 /tmp/pboard-build-android.$$ >&2; rm -f "/tmp/pboard-build-android.$$"
        failed+=(android)
      fi
      ;;
  esac
done

echo
echo "Build summary (core $core)"
for line in "${artifacts[@]}"; do echo "  $line"; done
if [ ${#failed[@]} -gt 0 ]; then
  echo "  FAILED: ${failed[*]}" >&2
  exit 1
fi