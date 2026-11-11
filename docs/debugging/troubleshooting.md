# Troubleshooting

Symptom → most likely cause → the one check that settles it.

## No events at all

1. **Bridge not running / wrong port** — `npm run debug:status`. Connection
   refused means no bridge; note `PBOARD_DEBUG_URL` must match its actual
   bound port (the bridge prints it at start; port 0 picks a free one).
2. **Extension not enabled** — in an extension console:
   `await browser.storage.local.get("pboardDebugBridge")`. Production builds
   enable nothing without `{ enabled: true }` (and a reload after setting it).
3. **Wrong URL from the client** — the transport refuses non-loopback URLs
   unless explicitly allowed; a client pointing at a bad URL drops with the
   transport cooldown message in `pboardDebug()` console output. Check
   `drops`/`transport` counts via the `pboardDebug()` handle.
4. **Token mismatch** — bridge logs `401 missing or invalid debug token`; the
   client needs the same `token` setting (sent as `?token=`).

## Events arrive but stop after a while

- Transport failure streak trips a 30 s cooldown (by design, one log line).
  `debug:status` shows `droppedByOverflow` / client `rejectedCount` growth.
- MV3 worker suspension between events is normal; the final batch uses
  `keepalive`, but a killed worker can lose the last sub-batch — counted as a
  transport drop, visible in `pboardDebug().drops`.

## Gaps inside a client's sequence

`sequenceNumber` is strictly increasing per producer: a gap is dropped
telemetry, not reordered work. Causes, in order of likelihood: queue
backpressure (oldest info/debug evicted first — warn/error are kept),
oversized event rejection, invalid event rejection (`rejectedCount` per
client on `/clients`). All are counted, none silent.

## `/connections` shows open sockets nobody has

Live sockets are real sockets (the ledger never invents one); a browser tab
still open has its dial. A socket whose client never reports again (profile
force-killed) shows as an orphan finding in `/connections/checks` —
`pboard_debug_check_connections` names it; it does not mean the app leaked,
it means the bridge can't see a close that never arrived.

## "trace not found" / missingStages

- Server stages correlate by room hash prefix: the relay's lines carry its own
  session ids, so a per-operation server stage only links via room — a trace
  whose server leg needs an operation id is `complete: false` by construction
  ([limitations.md](limitations.md)).
- Legacy grant posture vs operation protocol emit different stage sets
  (journal events vs log-room events): see
  [instrumentation.md](instrumentation.md) for which stages exist per
  posture.
- The filter is JSON in `filter=` — flat `?clientId=…` query params are
  ignored, and a filter that doesn't parse is dropped with `parseEventFilter`
  returning undefined (you get *everything*, not a filtered subset).

## E2E (`npm run debug:test:e2e`) failures

- `Geckodriver unavailable` / Firefox hangs: `PBOARD_GECKODRIVER` must point
  at a real geckodriver binary (an npx wrapper stub is not a binary).
- `Firefox probe runtime did not load`: the probe needs a fresh vite build —
  check the build step above it in the output; `web-ext`-less temporary addon
  install requires a developer-edition-capable Firefox (`/usr/bin/firefox`).
- `card did not replicate`: first check A2/A3 passed (relay auth is the gate;
  a grant refusal looks like silence until A3 fails). The diagnostics dump on
  failure prints both profiles' `collaborationManager.state()` and the relay
  log tail — `authorization_unavailable` after a relay *restart* is the grant
  cache: the E2E republishes with `boardCollaboration.security(board, true)`
  (scenario E); a manual session needs the same gesture.
- Drive-stub 404 lines (`[drive-stub] 404 …`) name the missing endpoint; the
  stub covers exactly what the fixture posture calls
  (`about/permissions/files/changes/generateIds/media`).
- Run with `PBOARD_E2E_DUMP=1` for the full per-client event inventory.
- The E2E relay logs to stdout; both streams are observed
  ([server-observation.md](server-observation.md)).

## Dashboard `/ui` shows nothing

Subscriptions are live-only: the dashboard shows events after it connects.
Use `debug:status events …` or MCP `get_events` for history. The dashboard
dials are themselves bridge connections — a second dashboard tab doubles
`subscriptions`.

## A "leaked" connection after extension reload

MV3 worker death can miss the socket close. The registry marks a client that
stops reporting; re-check after the next session's first event — the orphan
finding is the *report*, not the failure. If it persists across profile
restarts, it's a real leak and the check finding carries the trigger+room to
reproduce.
