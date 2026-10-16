#!/usr/bin/env bash
# Beta preview and workflow allocation; official tags are reserved in the common lifecycle.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:---help}" in
  -h|--help)
    cat <<'HELP'
usage: scripts/beta-version.sh next [X.Y.Z]
       scripts/beta-version.sh allocate [REF [X.Y.Z]] [--dry-run|--apply]
       scripts/beta-version.sh retry vX.Y.Z-dev.N [--dry-run|--apply]

next reads complete remote history; its result is not a reservation.
allocate defaults to a dry-run. --apply dispatches the trusted main workflow,
which reserves the tag, builds and publishes under the shared release lock.
retry selects the exact existing tag; changed source requires a greater version.
No command edits VERSION or creates local beta tags. Requires Node, Git and gh.
HELP
    exit 0 ;;
esac
exec node "$REPO/scripts/release-cli.mjs" beta "$@"
