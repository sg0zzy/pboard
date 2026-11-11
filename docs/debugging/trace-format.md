# Trace capture format

A capture is an exported, self-describing record of a debug window: the
matching events, the connection lifecycles they touched, and the metadata
needed to read them offline. Files live in `test-results/debug-traces/`
(gitignored) named `capture-<captureId>-<ISO-stamp>.json`, written by
`POST /capture/export` (`pboard_debug_export_capture`), or automatically at
scenario end by the harness. The shape is `TraceCaptureFile`
(`src/debug/protocol.ts`) — the test suites pin it.

```jsonc
{
  "kind": "pboard-debug-capture",
  "captureVersion": 1,
  "schemaVersion": 1,
  "metadata": {
    "captureId": "60e8e1cd",            // stable short id; matches file name and /captures/:id
    "startedAt": "2026-11-11T00:33:17.000Z",
    "stoppedAt": "2026-11-11T00:33:18.212Z",
    "label": "firefox-e2e-card",         // caller-supplied context
    "mode": "mock",                      // bridge mode at capture time
    "environment": "node",
    "seed": "pboard-debug-default-seed", // harness runs: reproducible seed
    "clientIds": ["firefox-a", "firefox-b", "relay-observer"],
    "filter": { "boardId": "e2e-board" },// the capture's event filter, when bounded
    "failureSummary": "…"                // set when stopped after a failed test
  },
  "connections": [{                       // every connection referenced by the captured events
    "connectionId": "conn-…",
    "clientId": "firefox-a",
    "trigger": "logsync:room",            // why the dial existed
    "room": "pboard-collab-e2e-board-cards",
    "state": "closed",                    // requested|open|closed
    "requestedAt": "…", "openedAt": "…", "closedAt": "…",
    "closeCode": 1006, "closeCause": "network",
    "reconnectScheduled": 1
  }],
  "events": [{                            // StoredDebugEvent: producer fields + bridge stamps
    "schemaVersion": 1, "timestamp": "…", "sequenceNumber": 41,
    "clientId": "firefox-a", "context": "sidebar",
    "component": "sync", "event": "operation.created", "severity": "info",
    "boardId": "e2e-board", "operationId": "op-…",
    "details": { "seq": 7, "kind": "card.create" },
    "receivedAt": "…",                     // bridge receive stamp (cross-producer ordering)
    "bridgeSeq": 1204                      // dense cursor within this bridge lifetime
  }],
  "truncatedEvents": 0                     // present when the export cap dropped events
}
```

## Reading rules

- Order events by `bridgeSeq` (or `receivedAt`); `timestamp` is per-producer
  wall clock and is not comparable across machines. Within one producer,
  `sequenceNumber` gives exact producer-side order — a gap says the producer
  dropped telemetry, never that the operations were unordered.
- `metadata.filter` records what the capture deliberately excludes; an absent
  filter means every event in the window was recorded (subject to the buffer
  bound — a capture that overlaps a buffer overflow carries the bridge's
  honest `bufferOverflown` at query time, before export).
- Connections state the cause of each close (`client`|`server`|`network`) —
  the difference between "we left" and "the relay died" is in the file.

## Examples in-repo producers

- Firefox E2E scenario B records a label `firefox-e2e-card` around one marker
  card and exports it (B4) — the smallest real cross-client trace.
- `tools/pboard-debug/harness.ts` exports one capture per scenario run,
  success or failure, and stamps failures with `failureSummary` (see
  [test-harness-integration.md](test-harness-integration.md)).
