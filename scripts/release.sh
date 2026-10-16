#!/usr/bin/env bash
# Stable preparation, annotated tagging and separately explicit publication push.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:---help}" in
  -h|--help)
    cat <<'HELP'
usage: scripts/release.sh prepare X.Y.Z [--dry-run|--apply]
       scripts/release.sh tag X.Y.Z [--dry-run|--apply]
       scripts/release.sh publish X.Y.Z [--dry-run|--apply]
       scripts/release.sh X.Y.Z --dry-run|--apply  (legacy metadata-only form)

prepare validates, syncs metadata, commits only version files if needed, and tags.
tag validates already committed metadata and creates an annotated local tag.
publish revalidates history and atomically pushes current main and that tag.
All new commands default to dry-run; --apply performs the stated operation.
Release history/signing readiness remains mandatory. Requires Node, Git and gh.
HELP
    exit 0 ;;
  prepare|tag|publish) exec node "$REPO/scripts/release-cli.mjs" stable "$@" ;;
  *) exec node "$REPO/scripts/prepare-release.mjs" "$@" ;;
esac
