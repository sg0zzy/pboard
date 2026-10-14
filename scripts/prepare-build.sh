#!/usr/bin/env bash
# Local build preparation for Pboard.
#
#   scripts/prepare-build.sh [--patch|--minor|--major|--no-bump] [--help]
#
# Reads VERSION, optionally increments the version (default: patch), then:
#   1. synchronizes all version references (manifests, npm, Android gradle)
#   2. runs the existing validation (typecheck, tests, Firefox lint)
#   3. builds Firefox, Chromium, and the Android debug APK
#   4. prints artifact paths
#
# Never commits, pushes, tags, or publishes. Re-running after a failed
# build: use --no-bump so the version is not incremented twice.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BUMP="patch"
for arg in "$@"; do
  case "$arg" in
    --patch)   BUMP="patch" ;;
    --minor)   BUMP="minor" ;;
    --major)   BUMP="major" ;;
    --no-bump) BUMP="none" ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/prepare-build.sh [--patch|--minor|--major|--no-bump]

  --patch   increment patch (default)
  --minor   increment minor, reset patch to 0
  --major   increment major, reset minor and patch to 0
  --no-bump synchronize and rebuild without changing the version
            (use after a failed build to retry the same version)

Never commits or pushes. After artifacts pass local testing, commit and
push manually, then run scripts/release.sh.
EOF
      exit 0 ;;
    *)
      echo "prepare-build.sh: unknown option: $arg (see --help)" >&2
      exit 2 ;;
  esac
done

# --- Repository sanity ------------------------------------------------------
if [ ! -f VERSION ]; then
  echo "error: $REPO/VERSION not found — run this from the Pboard repository root" >&2
  exit 1
fi
VERSION="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: VERSION must be MAJOR.MINOR.PATCH (e.g. 0.10.1); found: '$VERSION'" >&2
  exit 1
fi

# --- Version bump guard -----------------------------------------------------
# Refuse to bump when the tree already carries uncommitted version changes,
# otherwise a previously prepared (never-committed) bump would bump twice.
if [ "$BUMP" != "none" ]; then
  if ! git diff --quiet -- VERSION manifest.json manifest.chromium.json \
       package.json package-lock.json apps/android/package.json \
       apps/android/android/app/build.gradle 2>/dev/null \
     || ! git diff --cached --quiet -- VERSION manifest.json manifest.chromium.json \
       package.json package-lock.json apps/android/package.json \
       apps/android/android/app/build.gradle 2>/dev/null; then
    echo "error: uncommitted version changes present. Commit them, or rebuild" >&2
    echo "       the same version with --no-bump." >&2
    git --no-pager diff --stat -- VERSION manifest.json manifest.chromium.json \
      package.json package-lock.json apps/android/package.json \
      apps/android/android/app/build.gradle >&2
    exit 1
  fi
fi

# --- Prerequisites ----------------------------------------------------------
missing=""
command -v node >/dev/null 2>&1 || missing="$missing node"
command -v npm >/dev/null 2>&1  || missing="$missing npm"
[ -x "$REPO/apps/android/android/gradlew" ] || missing="$missing gradlew"
if [ -n "$missing" ]; then
  echo "error: missing build prerequisites:$missing" >&2
  exit 1
fi

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

# --- 1. Synchronize versions ------------------------------------------------
step "Sync versions (VERSION -> manifests, npm, Android)"
if [ "$BUMP" = "none" ]; then
  node scripts/sync-version.mjs || fail "version synchronization failed"
else
  node scripts/sync-version.mjs --next "$BUMP" || fail "version bump/sync failed"
fi
VERSION="$(tr -d '[:space:]' < VERSION)"

# --- 2. Root (Firefox + Chromium) validation and builds ---------------------
step "Install root dependencies"
if [ ! -f node_modules/vite/bin/vite.js ]; then
  npm ci || fail "npm ci (root) failed"
fi

step "Typecheck (root)"
npm run typecheck || fail "typecheck failed"

step "Unit tests (root)"
npm test || fail "root unit tests failed"

step "Build Firefox"
npm run build || fail "Firefox build failed"

step "web-ext lint (Firefox output)"
npm run lint:firefox || fail "web-ext lint failed"

step "Package Firefox (web-ext, byte-verified)"
npm run package:firefox || fail "Firefox packaging failed"

step "Build Chromium"
npm run build:chromium || fail "Chromium build failed"

step "Package Chromium and verify"
npm run package:chromium || fail "Chromium packaging failed"

# --- 3. Android workspace ---------------------------------------------------
step "Install Android workspace dependencies"
if [ ! -x apps/android/node_modules/.bin/cap ]; then
  (cd apps/android && npm ci) || fail "npm ci (apps/android) failed"
fi

step "Android typecheck and tests"
(cd apps/android && npm run typecheck) || fail "Android typecheck failed"
(cd apps/android && npm test) || fail "Android tests failed"

step "Android frontend build + Capacitor sync + debug APK"
(cd apps/android && npm run android:debug) || fail "Android debug build failed"

# --- 4. Artifacts -----------------------------------------------------------
ANDROID_APK="apps/android/android/app/build/outputs/apk/debug/app-debug.apk"
ANDROID_APK_COPY="web-ext-artifacts/Pboard-${VERSION}-debug.apk"
mkdir -p web-ext-artifacts
cp "$ANDROID_APK" "$ANDROID_APK_COPY" || fail "could not stage Android APK"

step "Build summary (version $VERSION)"
printf '  Firefox  : web-ext-artifacts/pboard-%s.zip (unsigned, matches dist/)\n' "$VERSION"
printf '  Chromium : web-ext-artifacts/pboard-chromium-%s.zip (unsigned)\n' "$VERSION"
printf '  Android  : %s (debug-signed, copy at %s)\n' "$ANDROID_APK" "$ANDROID_APK_COPY"
printf '  Android  : versionName %s, versionCode %s\n' "$VERSION" \
  "$(node -p "require('fs').readFileSync('apps/android/android/app/build.gradle','utf8').match(/versionCode\\s+(\\d+)/)[1]")"
printf '\nNext: test these artifacts, then commit/push and run scripts/release.sh\n'