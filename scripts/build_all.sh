#!/usr/bin/env bash
# Build selected targets into unique managed local_artifacts directories; see BUILD.md.
# When Firefox is selected, also build the debug-channel Firefox bundle at dist-debug/
# so the ordinary and diagnostics builds can be loaded side by side. GitHub Actions never
# builds it (a diagnostics bundle must not reach users), and PBOARD_BUILD_DEBUG=0 opts out.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$REPO/scripts/local-build.mjs" "$@"
if [[ -z "${GITHUB_ACTIONS:-}" && "${PBOARD_BUILD_DEBUG:-1}" != 0 ]]; then
  build_debug=0
  if [[ $# -eq 0 ]]; then
    build_debug=1
  else
    for target in "$@"; do
      if [[ "$target" == firefox ]]; then build_debug=1; fi
    done
  fi
  if [[ $build_debug -eq 1 ]]; then
    node "$REPO/scripts/build-firefox-debug.mjs"
  fi
fi
