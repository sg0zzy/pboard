#!/usr/bin/env bash
# Tag + release-preparation script for Pboard.
#
#   scripts/release.sh
#
# Validates the Git state (clean tree, branch main, synced with origin,
# versions match VERSION), generates release notes from commit history,
# shows them, and — after explicit confirmation — creates the annotated
# tag v<VERSION> and pushes only that tag. The tag push triggers the
# existing GitHub Actions AMO release workflow.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

fail() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

# --- 1-2. Read and validate VERSION ----------------------------------------
[ -f VERSION ] || fail "VERSION not found"
VERSION="$(tr -d '[:space:]' < VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "VERSION must be MAJOR.MINOR.PATCH (e.g. 0.10.1); found: '$VERSION'"
TAG="v$VERSION"

# --- 3. Version references must match VERSION ------------------------------
step "Checking version references"
node scripts/sync-version.mjs --check || fail "run scripts/sync-version.mjs, commit, then retry"

# --- 4. Clean working tree (tracked files) ----------------------------------
# Untracked files (e.g. local build artifacts under web-ext-artifacts/) are
# fine; tracked files must be committed.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "working tree has staged or unstaged changes to tracked files; commit first:
$(git status --short --untracked-files=no | head -20)"
fi

# --- 5. Current branch must be main ----------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "current branch is '$BRANCH', expected 'main'"

# --- 6. Fetch latest origin/main and tags ----------------------------------
step "Fetching origin"
git fetch origin main --tags --prune-tags --prune || fail "git fetch failed; check the network and remote"

# --- 7. HEAD matches origin/main -------------------------------------------
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  if git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
    AHEAD="$(git rev-list --count origin/main..HEAD)"
    fail "local main is $AHEAD commit(s) ahead of origin/main; push main yourself first (this script never pushes main)"
  fi
  if git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
    fail "local main is behind origin/main; git pull --ff-only first"
  fi
  fail "local main ($LOCAL_HEAD) has diverged from origin/main ($REMOTE_HEAD); reconcile manually"
fi

# --- 8. Tag must not exist locally or remotely ------------------------------
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "tag $TAG already exists locally; remove it with 'git tag -d $TAG' only if it was never pushed"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "tag $TAG already exists on origin; never reuse or move a pushed tag"
fi

# --- 9-10. Previous release tag by ancestry ---------------------------------
PREV_TAG="$(git tag --list --merged HEAD 'v*.*.*' | sort -V | tail -1)"
FIRST_RELEASE=0
if [ -z "$PREV_TAG" ]; then
  FIRST_RELEASE=1
  RANGE_HEAD="$(git rev-list --max-parents=0 HEAD | tail -1)"
  RANGE="$RANGE_HEAD..HEAD"
  echo "No previous release tag found; first release — including all history" >&2
else
  RANGE="$PREV_TAG..HEAD"
fi

# --- 11-13. Release notes from commit subjects ------------------------------
step "Generating release notes ($RANGE)"
# All reachable non-merge commits plus merge commit subjects; lines are
# deduplicated by subject so repeated merges of the same work don't produce
# duplicate bullet points.
notes_for_range() {
  # Regular commits (all reachable, excluding merges) + merge commit
  # subjects; a merge's subject is dropped when the same subject already
  # appears (e.g. "Merge pull request #N" merges are kept, duplicate
  # subjects from repeated merges of the same work are removed).
  {
    git log --no-merges --format='%h %s' "$1"
    git log --merges --format='%h %s' "$1"
  } | awk '!seen_line[$0=substr($0,9)]++'
}
NOTES_BODY="$(notes_for_range "$RANGE")"
if [ "$FIRST_RELEASE" = 0 ] && git merge-base --is-ancestor HEAD "$PREV_TAG"; then
  fail "HEAD is an ancestor of $PREV_TAG; nothing to release"
fi

if [ -z "$NOTES_BODY" ]; then
  echo "warning: no commits found in $RANGE" >&2
  read -r -p "Create $TAG anyway? [y/N] " answer
  case "$answer" in [yY]|[yY][eE][sS]) ;; *) echo "aborted."; exit 1 ;; esac
fi

RELEASE_NOTES="Pboard $TAG

Changes:
$( [ -n "$NOTES_BODY" ] && printf -- '- %s\n' "$NOTES_BODY" || printf -- '- (no new commits; metadata/version bump only)\n' )

Unchanged: Android is built locally for testing; this release publishes the Firefox extension to AMO."
NOTES_FILE="web-ext-artifacts/release-notes-${TAG}.md"
mkdir -p web-ext-artifacts
printf '%s\n' "$RELEASE_NOTES" > "$NOTES_FILE"

# --- 14-15. Show and confirm ------------------------------------------------
step "Proposed release"
cat "$NOTES_FILE"
echo
read -r -p "Create annotated tag $TAG on $(git rev-parse --short HEAD) and push it to origin? [y/N] " answer
case "$answer" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "aborted. Notes kept at $NOTES_FILE"; exit 1 ;;
esac

# --- 16. Annotated tag ------------------------------------------------------
# The tag message carries the full notes; the AMO workflow reads them from
# the tag for the GitHub Release body.
git tag -a "$TAG" --file "$NOTES_FILE" || fail "git tag failed"

# --- 17. Push only the tag --------------------------------------------------
step "Pushing $TAG to origin (this triggers the AMO release workflow)"
if ! git push origin "refs/tags/$TAG"; then
  echo "warning: tag push failed. The tag exists locally — retry with" >&2
  echo "         git push origin refs/tags/$TAG  (check CI status after it lands)" >&2
  exit 1
fi

echo
echo "Tag $TAG pushed. GitHub Actions (Firefox AMO release) will:"
echo "  1. validate tag/manifest version and Gecko ID"
echo "  2. build, lint, package, and archive reviewer sources"
echo "  3. submit to the existing AMO listing"
echo "  4. attach the unsigned build + sources to the GitHub Release"
echo
echo "Track: https://github.com/sg0zzy/pboard/actions"
echo "AMO:   https://addons.mozilla.org/en-US/developers/addon/pboard/versions/"