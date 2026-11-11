# MCP tools

`npm run debug:mcp` (`tools/pboard-debug/mcp.ts`) speaks MCP over stdio and
proxies the bridge's HTTP surface. It adds no state and no privileges: 21
tools are read-only; 2 are explicitly test-control (`pboard_debug_run_scenario`,
`pboard_debug_send_command`) and are answered by the bridge only in `mock`
mode.

## MCP client configuration

```json
{
  "mcpServers": {
    "pboard-debug": {
      "command": "npm",
      "args": ["run", "--silent", "debug:mcp"],
      "env": { "PBOARD_DEBUG_URL": "http://127.0.0.1:8790" }
    }
  }
}
```

Environment: `PBOARD_DEBUG_URL` (default `http://127.0.0.1:8790`),
`PBOARD_DEBUG_TOKEN` (must match the bridge), `PBOARD_DEBUG_AUTO_START=1`
(spawn a local bridge when none answers). Works with any MCP client — OMP,
Codex, Qwen — including clients without streaming notifications: waiting is
a long-poll tool (`pboard_debug_watch_events`), not a notification stream.

## Reading state

| Tool | Bridge call | Notes |
|---|---|---|
| `pboard_debug_get_status` | `GET /status` | buffer occupancy, drop counters, mode, schema/server version, `latestCursor` |
| `pboard_debug_list_clients` | `GET /clients` | every producer that has sent events (Firefox profiles, harness runner, relay observer) with per-client rejected counts |
| `pboard_debug_list_sessions` | `GET /sessions` | one session per client boot/reload |
| `pboard_debug_list_connections` | `GET /connections` | registry: every dialled socket with owner, trigger, room, state; `counts` envelope |
| `pboard_debug_check_connections` | `GET /connections/checks` | `{findings, counts}`: duplicate live dials per trigger+room, orphaned/never-closed connections, ownership findings |
| `pboard_debug_get_events` | `GET /events` | filters AND together; `after` is the dense `bridgeSeq` cursor; the page is a newest-N tail window; `bufferOverflown` says older events may have been evicted unseen |
| `pboard_debug_watch_events` | `/status` + `/events` poll loop | long-poll: waits `waitMs` (≤ 30 000) for events after `after`, returns them with a fresh cursor; re-call with the cursor to keep watching |
| `pboard_debug_get_errors` | `/events` (severity ≥ warn) | grouped by event name, one example each — the fast "what is wrong" question |
| `pboard_debug_get_connection_history` | `/events` + `/connections` (one connectionId) | full life of one socket: lifecycle order, ownership, its frames |

## Traces and state

| Tool | Bridge call | Notes |
|---|---|---|
| `pboard_debug_trace_operation` | `GET /trace?traceId=` or `?operationId=` | `TraceView`: ordered stages across clients, `missingStages`, `duplicateStages`, errors. An operation id resolves as `op:<id>` |
| `pboard_debug_list_traces` | `GET /traces?limit=` | recent traces, newest first, with completeness |
| `pboard_debug_get_client_state` | `GET /inspect/:clientId` | pull model: the bridge queues a request, the client's own instrumentation answers within the poll window; 504 with a hint when no client answers. Snapshot is controlled and read-only (counts, states, ids — no contents) |
| `pboard_debug_compare_clients` | two `/inspect/:clientId` | side-by-side board-state diff (counts, sync state, pending) |
| `pboard_debug_get_sync_state` | `/events` latest `sync.state`/`sync.completed`/`sync.failed` per board | event-derived current state |
| `pboard_debug_get_pending_operations` | `/events` created/queued minus acknowledged | per board: operations that never completed |
| `pboard_debug_describe_protocol` | none (embedded) | the schema contract itself — components, every event name, limits, trace stages |

## Captures

| Tool | Bridge call | Notes |
|---|---|---|
| `pboard_debug_start_capture` | `POST /capture/start` | records matching events (+ their connection lifecycles) into a bounded capture |
| `pboard_debug_stop_capture` | `POST /capture/stop` | pass `failureSummary` when stopping after a failed test — it lands in the capture metadata |
| `pboard_debug_export_capture` | `POST /capture/export` | writes `test-results/debug-traces/capture-<id>-<stamp>.json` ([trace-format.md](trace-format.md)) |
| `pboard_debug_list_captures` | `GET /captures` | stopped captures with counts and failure summaries |
| `pboard_debug_replay_trace` | `GET /captures/:id` | re-display in order, optionally filtered — a reading aid, NOT a re-execution |

## Test control (mock mode only)

| Tool | Bridge call | Notes |
|---|---|---|
| `pboard_debug_run_scenario` | runs harness in-process + bridge | `list` or a scenario name; drives mock clients through the real sync runtime and records a capture. See [test-harness-integration.md](test-harness-integration.md) |
| `pboard_debug_send_command` | `POST /command` | fault injection / disconnect / test control against **mock clients only**; the bridge answers 403 `fault injection is not available in mode "…"` in `local` and `production-observer` |

## Cursor discipline (for agents)

`latestCursor` from `get_status` is the right "start watching from here" mark.
`watch_events` without `after` starts from now (history is skipped — call
`get_events` if you want the past). Cursors stay valid only within one bridge
lifetime; on a bridge restart, status returns a fresh `latestCursor` and old
cursors resolve from the buffer start — check `bufferOverflown` before
claiming an absence of events is real. `get_events` returns the newest `limit`
matches: to walk history forward, use `after` + a high `limit`, not repeated
`get_events` without a cursor.
