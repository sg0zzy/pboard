# Test harness integration

`tools/pboard-debug/harness.ts` drives **mock clients through a mini sync
runtime on the real debug bus**, against a running bridge, in bridge mode
`mock`. It exists to make the bridge's own contract (traces complete,
findings fire, errors surface, captures export) a re-runnable test — and to
give scenarios a fault-injection channel that real clients must never expose.

```bash
PBOARD_DEBUG_MODE=mock npm run debug:bridge &   # faults need mode mock; default mode is local
node tools/pboard-debug/harness.ts --scenario happy-path-sync --bridge http://127.0.0.1:8790
node tools/pboard-debug/harness.ts --scenario relay-forward --fault drop-next-ack --fault-client harness-a
```

or through MCP against any bridge: `pboard_debug_run_scenario` with
`action: "list" | "<name>"` (the runner executes in-process in the MCP server
and talks to the bridge over HTTP).

## Scenarios

| Name | What it exercises |
|---|---|
| `happy-path-sync` | one client: connect, authenticate, one card operation through created→queued→transmitted→acknowledged→applied; asserts the trace has every expected stage. With `--fault drop-next-ack` the ack is dropped and the failure is observed instead |
| `relay-forward` | two clients + one mock relay: A submits, relay forwards, B applies; the trace must span both clients and include server stages |
| `reconnect-loop` | dial storm for one trigger+room: reconnect events fire, the duplicate-connection finding must NOT fire for legitimately closed dials |
| `server-restart` | mock relay closes then refuses: dropped socket, failed reconnect, recovery; every error must be visible to the MCP layer (`get_errors`) |
| `relay-log-observation` | feeds real relay tracing lines through `relayObserver`: parsed `relay.*` events reach the bridge, unmapped lines are counted |
| `stress-events` | 1 000 events through the real bus: backpressure behaves, sequence integrity holds, no loss below the queue bound |

Each run: registers a runner client, seeds events with a stable seed, records
a **capture** for the whole run, and exports it — on failure with
`failureSummary` set, so a broken scenario always leaves an artefact in
`test-results/debug-traces/`. Exit code is non-zero when any check fails,
which is what CI and `debug:test` rely on.

## Fault injection

Faults live entirely in the bridge's mock mode:

- `POST /command {clientId, action, args}` queues a fault; only mode `mock`
  accepts it — `local` and `production-observer` answer 403
  (`fault injection is not available in mode "…"`). Production observation is
  read-only by construction.
- The target harness client polls `GET /fault/poll`, consumes its queue, and
  emits `harness.fault.injected` so the fault itself appears in the trace
  (a fault that isn't in the capture didn't happen).
- Known actions: `drop-next-ack` (acknowledgement is swallowed once —
  `happy-path-sync` turns red exactly once, observably), `relay-down` (the
  mock relay refuses the next dials — drives `server-restart`'s failure leg).
- CLI: `--fault <action>` with optional `--fault-client <clientId>` scopes the
  fault; MCP: `pboard_debug_send_command` with the same body.

## Failure reports

A failed scenario reports per-check results (`{name, ok, detail}`), the trace
id(s) it correlated, and the exported capture path — enough to start from the
capture file alone ([trace-format.md](trace-format.md)). The
`vitest`-level suites (`tests/debugProtocol/Bridge/Stress.test.ts`) pin the
same contracts in-process; `npm run debug:test` runs them, and
`npm run debug:test:e2e` runs the real-browser acceptance A–E
([firefox-debugging.md](firefox-debugging.md)).
