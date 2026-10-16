#!/usr/bin/env bash
# Version and release-control helpers implementing VERSIONING.md.
# Explicit development core selection: bump patch|minor|major, set X.Y.Z-dev, --check.
# See VERSIONING.md for the VERSION authority and RELEASE.md for stable preparation.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

case "${1:-}" in
  ""|-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

exec node scripts/version.mjs "$@"