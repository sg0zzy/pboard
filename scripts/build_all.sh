#!/usr/bin/env bash
# Build selected targets into unique managed local_artifacts directories; see BUILD.md.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/local-build.mjs" "$@"
