#!/usr/bin/env bash
# Run every test suite in this repository that is safe to run locally.
#
#   scripts/test-all.sh                 offline sweep: typecheck, root Vitest,
#                                       Android typecheck + Vitest, relay cargo
#                                       tests, buffer probe, recovery inventory
#   scripts/test-all.sh --full          also run the recovery harness including
#                                       its local Chromium fixtures. Expect this
#                                       to fail at the first native fixture: it
#                                       currently requires a Google credential
#                                       its fixtures do not supply. Run the same
#                                       command without --full for a green gate.
#   scripts/test-all.sh --only <name>   run one suite: root|android|relay|buffer|recovery|types
#   scripts/test-all.sh --list          show suites and what each one runs
#   scripts/test-all.sh --keep-going    continue after failures, report all
#   scripts/test-all.sh --help
#
# Never run here, by design:
#   * `npm run test:collaboration` / `automatic-smoke.mjs` — they default to a
#     public WSS endpoint, so they are not offline commands (docs/testing/README.md).
#   * `secure-browser-smoke.mjs`, `identity-smoke.mjs`, `*-ui-smoke.mjs` — live
#     relay/Google/geckodriver probes, covered by the recovery harness only where
#     it runs entirely local fixtures.
#
# Exit status: 0 only when every selected suite passed. Failures are summarised
# at the end and their logs are kept under a temporary directory.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ONLY=""
MODE=default
KEEP_GOING=0
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pboard-tests.XXXXXX")"
RESULTS=()
FAILED=()

usage() {
  # Print the header comment block only, stopping at the first non-comment line.
  sed -n '2,${/^[^#]/q;p;}' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --full) MODE=full; shift ;;
    --only) [ $# -ge 2 ] || { echo "--only needs a suite name" >&2; exit 2; }
            case "$2" in
              types|root|android|relay|buffer|recovery) ONLY="$2" ;;
              *) echo "Unknown suite: $2 (see --list)" >&2; exit 2 ;;
            esac
            shift 2 ;;
    --keep-going) KEEP_GOING=1; shift ;;
    --list)
      cat <<'LIST'
suites:
  types     root `tsc --noEmit`, Android `tsc --noEmit`
  root      root Vitest (tests/**/*.test.{ts,tsx,mjs}, includes multiBrowser)
  android   Android Vitest (apps/android/tests/**/*.check.{ts,tsx})
  relay     cargo test --locked for services/pboard-signaling
  buffer    cargo build of the relay binary + services/pboard-signaling/buffer-probe.mjs
  recovery  scripts/recovery/run.mjs (inventory by default; full harness with --full)
LIST
      exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node 24+ required (found $(node -v)); run: nvm use" >&2; exit 1; }

want() { [ -z "$ONLY" ] && return 0; [ "$ONLY" = "$1" ]; }

# run <suite> <description> <command...>
run() {
  local suite="$1" description="$2"; shift 2
  local log="$LOG_DIR/$suite.log"
  printf '\n==> %s — %s\n' "$suite" "$description"
  local started; started="$(date +%s)"
  if "$@" >"$log" 2>&1; then
    local elapsed=$(( $(date +%s) - started ))
    # Prefer the suite's own result lines over whatever happened to be last:
    # cargo and vitest both print several blocks, and the final one can be an
    # empty target.
    local digest
    digest="$(grep -E '^ *(Tests|Test Files|test result: )' "$log" | grep -v ' 0 passed' | tail -n 3)"
    [ -n "$digest" ] || digest="$(tail -n 3 "$log")"
    printf '%s\n' "$digest" | sed 's/^/    /'
    RESULTS+=("PASS  $suite (${elapsed}s)")
    return 0
  fi
  local elapsed=$(( $(date +%s) - started ))
  echo "    FAILED — full log: $log"
  tail -n 25 "$log" | sed 's/^/    /'
  RESULTS+=("FAIL  $suite (${elapsed}s)")
  FAILED+=("$suite")
  [ "$KEEP_GOING" -eq 1 ] && return 0
  finish
}

finish() {
  printf '\n==== summary ====\n'
  for line in "${RESULTS[@]}"; do echo "  $line"; done
  if [ "${#FAILED[@]}" -gt 0 ]; then
    printf '\nFailed: %s\nLogs: %s\n' "${FAILED[*]}" "$LOG_DIR"
    exit 1
  fi
  echo "All selected suites passed."
  exit 0
}

# ---------------------------------------------------------------------------
# Suites
# ---------------------------------------------------------------------------

if want types; then
  run types "root and Android TypeScript" bash -c '
    set -e
    node_modules/.bin/tsc --noEmit
    ( cd apps/android && node_modules/.bin/tsc --noEmit )
  '
fi

if want root; then
  run root "root Vitest (unit, recovery, multi-browser)" node node_modules/vitest/vitest.mjs run
fi

if want android; then
  run android "Android Vitest" bash -c 'cd apps/android && node_modules/.bin/vitest run'
fi

if want relay; then
  if command -v cargo >/dev/null 2>&1; then
    run relay "relay cargo tests" cargo test --locked --manifest-path services/pboard-signaling/Cargo.toml
  else
    echo "!! skipping relay: cargo not found on PATH"
    RESULTS+=("SKIP  relay (cargo missing)")
  fi
fi

if want buffer; then
  if command -v cargo >/dev/null 2>&1; then
    run buffer "durable buffer probe against a local relay binary" bash -c '
      set -e
      cargo build --manifest-path services/pboard-signaling/Cargo.toml --bin pboard-signaling
      node services/pboard-signaling/buffer-probe.mjs
    '
  else
    echo "!! skipping buffer: cargo not found on PATH"
    RESULTS+=("SKIP  buffer (cargo missing)")
  fi
fi

if want recovery; then
  # The harness is offline either way; --full adds local Chromium fixtures and
  # therefore needs a browser plus a fixture relay build.
  if [ "$MODE" = full ]; then
    run recovery "recovery harness with local browser fixtures" node scripts/recovery/run.mjs --browser
  else
    run recovery "recovery scenario inventory" node scripts/recovery/run.mjs --inventory
  fi
fi

finish
