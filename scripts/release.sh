#!/usr/bin/env bash
# Stable preparation, annotated tagging and separately explicit publication push.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
default_version() {
  local selected
  selected="$(node "$REPO/scripts/version.mjs" canonical)" || return
  printf '%s\n' "${selected%-dev}"
}
case "${1:---help}" in
  -h|--help)
    cat <<'HELP'
usage: scripts/release.sh prepare [X.Y.Z] [--dry-run|--apply]
       scripts/release.sh tag [X.Y.Z] [--dry-run|--apply]
       scripts/release.sh publish [X.Y.Z] [--dry-run|--apply]
       scripts/release.sh [X.Y.Z] --dry-run|--apply  (legacy metadata-only form)

An omitted version uses this checkout's VERSION core (X.Y.Z or X.Y.Z-dev).
An explicit version overrides VERSION. No version is automatically bumped.
prepare validates, syncs metadata, commits only version files if needed, and tags.
tag validates already committed metadata and creates an annotated local tag.
publish revalidates history and atomically pushes current main and that tag.
All new commands default to dry-run; --apply performs the stated operation.
Release history/signing readiness remains mandatory. Requires Node, Git and gh.
HELP
    exit 0 ;;
  prepare|tag|publish)
    command="$1"
    shift
    has_version=0
    for argument in "$@"; do
      case "$argument" in --*) ;; *) has_version=1 ;; esac
    done
    if [[ "$has_version" == 0 ]]; then
      selected="$(default_version)"
      set -- "$selected" "$@"
    fi
    exec node "$REPO/scripts/release-cli.mjs" stable "$command" "$@"
    ;;
  --dry-run|--apply)
    selected="$(default_version)"
    exec node "$REPO/scripts/prepare-release.mjs" "$selected" "$@"
    ;;
  *) exec node "$REPO/scripts/prepare-release.mjs" "$@" ;;
esac
