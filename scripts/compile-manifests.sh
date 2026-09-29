#!/usr/bin/env bash
# Build every extension variant and its manifest:
#   firefox  -> dist/          (from manifest.json)
#   chromium -> dist/chromium/ (from manifest.chromium.json)
# Node version is taken from .nvmrc via nvm when nvm is installed.
#
# Usage: scripts/compile-manifests.sh [firefox|chromium|all]   (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VARIANT="${1:-all}"
case "$VARIANT" in
  firefox|chromium|all) ;;
  *) echo "usage: ${0##*/} [firefox|chromium|all]" >&2; exit 2 ;;
esac

# --- Node version from .nvmrc ----------------------------------------------
PINNED=""
if [ -f .nvmrc ]; then
  PINNED="$(tr -d '[:space:]' < .nvmrc)"
fi

if [ -n "$PINNED" ] && [ -f "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use
  nvm use --silent
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed and nvm could not provide it" >&2
  exit 1
fi

if [ -n "$PINNED" ]; then
  want_major="${PINNED%%.*}"; want_major="${want_major#v}"
  have_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$want_major" != "$have_major" ]; then
    echo "error: .nvmrc pins Node $PINNED but $(node -v) is running; use nvm or set NVM_DIR" >&2
    exit 1
  fi
fi

# --- Dependencies -----------------------------------------------------------
if [ ! -f node_modules/vite/bin/vite.js ]; then
  npm ci
fi

# --- Compile ---------------------------------------------------------------
case "$VARIANT" in
  firefox)  npm run build ;;
  chromium) npm run build:chromium ;;
  all)      npm run build:all ;;
esac

node scripts/verify-build.mjs "$VARIANT"
echo "compiled: $VARIANT on $(node -v)"
