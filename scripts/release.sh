#!/usr/bin/env bash
# Prepare reviewable stable metadata; never commits, tags, pushes or publishes.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/prepare-release.mjs" "$@"
