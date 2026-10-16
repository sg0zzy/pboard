#!/usr/bin/env bash
# Manual local-artifact retention; implementation details are in BUILD.md.
#
#   scripts/clean-artifacts.sh --dry-run        preview what would be deleted
#   scripts/clean-artifacts.sh --run            run retention (default: keep 10)
#   scripts/clean-artifacts.sh --run --keep 3   override the retention count
#   scripts/clean-artifacts.sh --help
#
# Only validated completed builds under local_artifacts/ are considered; builds with
# a .keep file, incomplete/unrecognized directories and running builds are never
# touched. Dry-run never deletes.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
case " ${*} " in *" --help "*|*" -h "*) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;; esac
exec node scripts/artifact-retention.mjs "$@"
