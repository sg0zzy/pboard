#!/usr/bin/env bash
# Select a development core and synchronize VERSION mirrors. Never commits or tags.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:---help}" in
  -h|--help)
    cat <<'HELP'
usage: scripts/version.sh show
       scripts/version.sh bump patch|minor|major [--dry-run]
       scripts/version.sh set X.Y.Z-dev [--dry-run]
       scripts/version.sh --check

Bumps select a development core, reset subordinate fields, and sync all mirrors.
Stable versions are selected explicitly with scripts/release.sh prepare X.Y.Z.
HELP
    exit 0 ;;
esac
exec node "$REPO/scripts/version.mjs" "$@"
