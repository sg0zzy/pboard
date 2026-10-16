#!/usr/bin/env bash
# Compatibility entry point: builds do not select versions. See RELEASE.md for preparation.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$REPO/scripts/build_all.sh" "$@"
