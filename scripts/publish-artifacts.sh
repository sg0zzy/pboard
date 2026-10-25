#!/usr/bin/env bash
# Copy the newest local build artifact of each platform to the shared drop.
#
#   scripts/publish-artifacts.sh              -> /srv/artifacts/pboard
#   scripts/publish-artifacts.sh /tmp/drop    -> another destination
#   scripts/publish-artifacts.sh --help
#
# For every platform (android, firefox, chromium) the newest matching file
# anywhere under local_artifacts/ wins, newest completion time first and
# including the legacy nested layout. Existing files at the destination are
# overwritten. A platform that has never been built fails the run after the
# other platforms were copied, so a partial drop is never silent.
set -euo pipefail

usage() {
  sed -n '2,11p' "$0" | cut -c 3-
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  -*) echo "error: unknown option $1 (see --help)" >&2; exit 2 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src="$root/local_artifacts"
dest="${1:-/srv/artifacts/pboard}"

rm -- "${dest}/"*


[ -d "$src" ] || { echo "error: no local_artifacts/ under $root (run npm run build:all first)" >&2; exit 1; }
mkdir -p -- "$dest"

status=0
for target in android firefox chromium; do
  newest=$(find "$src" -type f \( -name "Pboard-*-$target-*.zip" -o -name "Pboard-*-$target-*.apk" \) \
    -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)
  if [ -z "$newest" ]; then
    echo "missing: no $target artifact under $src" >&2
    status=1
    continue
  fi
  cp -f --preserve=mode,timestamps -- "$newest" "$dest/"
  echo "copied: ${newest#"$root"/} -> $dest/$(basename -- "$newest")"
done
exit "$status"
