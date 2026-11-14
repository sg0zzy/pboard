# Firefox debugging

## Enabling the bridge in a loaded extension

The channel is enabled by exactly one of two policies
(`src/debug/browser.ts`):

1. **Explicit per-profile setting** — works in any build, including a
   release-ish load:

   ```js
   // any extension page console, or web-ext/WebDriver eval:
   await browser.storage.local.set({ pboardDebugBridge: { enabled: true } });
   // options: url (default http://127.0.0.1:8790), token, clientId (stable id)
   ```

   then reload the extension. `{ enabled: false }` forces it off even in a DEV
   build.

2. **Build flag** — a `DEV` build or a build with
   `__PBOARD_DIAGNOSTICS__=true` / `VITE_PBOARD_DIAGNOSTICS=1` enables the
   channel by default, pointing at the loopback bridge. Production builds
   without the storage setting create no transport at all; `emit` stays a
   boolean test and dials carry no debug ids.

   `scripts/build_all.sh` produces such a build as the second Firefox bundle
   (`dist-debug/`, `npm run build:firefox-debug` for it alone); it points at the
   default loopback URL and grants `http://127.0.0.1/*` in its generated
   manifest. Load it in a separate profile from the ordinary `dist/` bundle —
   Firefox keeps one temporary add-on per extension ID.

Both contexts (background and sidebar) configure independently and get
distinct `context` fields; ids come from `src/debug/ids.ts` (`clientId` stable
per profile via storage, `sessionId` per boot). With `VITE` builds there is
no difference in the events themselves — only whether anything listens.

Verify with `npm run debug:status` (clients should list the profile;
connections should list the board's dials) or the dashboard at `/ui`.

## Console handle

When active, `pboardDebug()` in the context console reports drops/backpressure
(`debugDropReport()`) and the transport state — the first thing to check when
events look missing: overflow drops are counted, never silent.

## WebDriver E2E — `npm run debug:test:e2e`

`tools/pboard-debug/firefox-e2e.mjs` runs the acceptance suite A–E against
**two real headless Firefox profiles** loading a temporary extension that
composes the real runtime (probe entry `firefox-e2e-probe.ts`, same
composition as the background) against the **real Rust relay**, with the real
bridge in-process. Everything asserted is read back over HTTP exactly as an
MCP client would.

Requirements: `/usr/bin/firefox`, geckodriver (`PBOARD_GECKODRIVER` pointing
at a real geckodriver binary — an npx stub will not do), a built
`services/pboard-signaling/target/debug/pboard-signaling`, vite (repo dep).
The Drive side is a loopback in-memory stub (same fixture contract as
`secure-browser-smoke.mjs`) — no real Google contact, no real board data.

```bash
PBOARD_GECKODRIVER=/path/to/geckodriver node tools/pboard-debug/firefox-e2e.mjs --scenario all
# scenarios: A | B | C | D | E | all   (A stops after auth observation)
# PBOARD_E2E_DUMP=1 dumps the full per-client event inventory on stderr
```

### What each scenario proves

| Check | Assertion |
|---|---|
| A1 | `lifecycle.runtime.initialized` from both profiles arrived |
| A2 | `websocket.connection.requested` + `.opened` for the board dial |
| A3 | `auth.authentication.completed` per profile (the grant-signaling transport emits the same schema pair as the log transports) |
| A4 | the relay's own tracing lines reached the bridge as `relay.*` events (observer over the process's stdout — where `tracing` writes; both streams are observed) |
| B1–B2 | one card's causal-journal entry: `sync.operation.created` at the sender (journalStorage), `operation.applied` at the receiver (`ChangeJournal.accept`, observed origin) while the marker actually replicated |
| B3 | `websocket.message.sent` frames on the sender socket (signaling transport frame events) |
| B4 | capture start → stop → export wrote a real capture file |
| D1 | `GET /inspect/firefox-a` returned a live board snapshot (`kind: board-state`, context, board with cardCount) |
| C1–C3 | stop → all connections closed at the bridge; `/connections/checks` reports no duplicate/orphan findings; restart registers exactly one live socket per client |
| E1 | relay `SIGKILL`: non-clean closes (cause `network`) + `reconnect.scheduled` for every browser, observed at the bridge |
| E2 | relay restarted on the same port; after the authority device republishes its grant (`boardCollaboration.security(board, true)` — the `healRelay` advertise step; a restarted relay starts with an empty grant cache), both profiles rejoin and the relay's `connection.accepted` lines arrive as `relay.*` events |

A green run prints `14/14 checks passed`. Failure diagnostics on stderr:
per-profile collaboration state, security excerpt (ids only), live settings,
recent bridge warn/error events, and the relay log tail (also written to
`test-results/debug-e2e-relay.log`). The fixture posture is the legacy board
grant (`operationSync: false`, Drive identity credentials absent on purpose):
the Drive-authority operation room verifies real Google-issued JWTs and is not
fixture-testable; the bridge instruments both paths identically
([instrumentation.md](instrumentation.md)).

## Reloading and MV3 lifecycle

Reloading the extension ends one `sessionId` and starts another; the bridge
keeps both and the registry attributes connections per session — which is
exactly how a leaked socket from a killed worker shows up as an orphan
finding (`pboard_debug_check_connections` / `debug:status checks`). MV3 worker
suspension between events is normal: the transport's `keepalive` POST lets the
final batch finish; a dropped final batch counts as a bus drop.

## Manual relay observation during debugging

```bash
RUST_LOG=pboard_signaling=info services/pboard-signaling/target/debug/pboard-signaling ... \
  | node --input-type=module -e "…observeRelayLogs(stdin lines)…"
```

or simply let the E2E/harness wire it for you. See
[server-observation.md](server-observation.md) for the journald-tail recipe
and the parser contract.
