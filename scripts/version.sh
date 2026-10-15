#!/usr/bin/env bash
# Version and release-control helpers implementing VERSIONING.md.
#
#   scripts/version.sh read                 next build's version and identity (JSON)
#   scripts/version.sh canonical            version string the next build carries
#   scripts/version.sh bump patch|minor|major
#                                           select the next development core
#                                           (no release, no tag, counter resets)
#   scripts/version.sh set X.Y.Z-dev        select a development core explicitly
#   scripts/version.sh --check              all platform references match VERSION
#
# Local builds (scripts/build_all.sh, scripts/build_android.sh) consume the
# selected core automatically with their own -dev.N counter; they never bump,
# commit or tag. Stable releases are explicit: scripts/release.sh (and the
# tagged CI pipeline); scripts/prepare-build.sh accepts --patch|--minor|--major.
#
# The selected development core and the local counter state (`.build-state/`)
# are worktree-local; commits only carry the version-reference files changed by
# bump (VERSION + synced manifests).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

case "${1:-}" in
  ""|-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

exec node scripts/version.mjs "$@"