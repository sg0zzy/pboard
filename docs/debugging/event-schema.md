# Diagnostic event schema (version 1)

`src/debug/schema.ts` is the single source of truth. This page mirrors it;
`pboard_debug_describe_protocol` returns the same contract over MCP, and
`tests/debugProtocol.test.ts` pins the contract itself (every component has a
registered event set; unregistered names are rejected at both producer and
bridge — run it after editing the registry).

A `DebugEvent`:

```ts
{
  schemaVersion: 1,
  timestamp: string,          // producer wall clock, ISO-8601 — never compared across machines
  monotonicTime?: number,     // producer monotonic ms, for durations
  sequenceNumber: number,     // per-producer, strictly increasing; gaps = dropped telemetry
  traceId?, spanId?, parentSpanId?,
  clientId?, sessionId?, userId?, boardId?, connectionId?, operationId?, // 1–128 chars when present
  component: DebugComponent,  // registry below
  event: string,              // must be registered for that component
  severity: "debug" | "info" | "warn" | "error",
  context?: string,           // background | sidebar | node-e2e | harness-runner | relay-observer …
  details?: Record<string, unknown> // plain object; sanitized, see limits
}
```

The bridge stores it as `StoredDebugEvent` = event + `receivedAt` (bridge
receive stamp; the only cross-producer ordering source) + `bridgeSeq` (dense
per bridge lifetime; the query cursor). The bridge never rewrites producer
fields.

## Components and events

`debug` — `bridge.status`: SDK/bridge self-status (drops, backpressure,
connect/disconnect).

`websocket` — socket lifecycle on any instrumented dial (all four dial sites
go through `trackTransportSocket`):
`connection.requested`, `connection.opened`, `connection.closing`,
`connection.closed` (close code + cause: `client`|`server`|`network`),
`message.sent`, `message.received` (frame `type[:action]` + room only — payload
contents never leave through this path; per-frame events are `debug` severity
by default), `reconnect.scheduled`, `reconnect.attempted`,
`reconnect.completed`, `reconnect.failed`, `subscription.requested`,
`subscription.accepted`.

`auth` — `authentication.started`, `authentication.completed`,
`authentication.failed` (relay admission/authentication),
`identity.established`, `token.refresh.started`, `token.refresh.completed`,
`token.refresh.failed`, `authorization.rejected`.

`sync` — operation lifecycle: `operation.created`, `operation.queued`,
`operation.transmitted`, `operation.acknowledged`, `operation.received`,
`operation.validated`, `operation.applied`, `operation.duplicate`,
`operation.rejected`; `conflict.detected`, `conflict.resolved`;
`sync.completed`, `sync.failed`, `sync.state`.

`persistence` — `rxdb.write.requested`, `rxdb.write.completed`,
`rxdb.write.failed`, `snapshot.loading`, `snapshot.loaded`,
`snapshot.creating`, `snapshot.saved`, `oplog.processed`, `oplog.recovered`,
`persistence.recovery.failed`.

`drive` — `upload.requested`, `upload.completed`, `upload.failed`,
`download.requested`, `download.completed`, `download.failed`,
`ratelimit.detected`, `retry.scheduled`, `authorization.failed` (403-class),
`revision.conflict` (409-class).

`lifecycle` — `background.boot`, `runtime.initialized`, `runtime.disposed`,
`listeners.registered`, `listeners.removed`, `socket.ownership.assigned`,
`socket.ownership.released`.

`relay` — produced by the log observer from the Rust relay's own tracing
lines ([server-observation.md](server-observation.md)):
`connection.accepted`, `connection.closed`, `authentication.result`,
`subscription.changed`, `operation.received`, `operation.forwarded`,
`operation.buffered`, `authorization.denied`, `error`.

`harness` — `scenario.started`, `scenario.completed`, `scenario.failed`,
`fault.injected`, `fault.cleared`, `capture.started`, `capture.stopped`
(mock harness only).

## Trace model

The correlation key is `traceId`, falling back to `op:<operationId>` (never a
new id minted over a production one; trace ids are observability-only and
change no sync semantics). The canonical card-operation pipeline
(`CARD_OPERATION_TRACE_STAGES`) is:

1. `sync/operation.created` (sender)
2. `sync/operation.queued` (sender)
3. `websocket/message.sent` (sender)
4. `relay/operation.received` (server)
5. `relay/operation.forwarded` (server)
6. `websocket/message.received` (receiver)
7. `sync/operation.applied` (receiver)

A `TraceView` reports `missingStages`/`duplicateStages` against that contract
and lists errors; server stages correlate by room hash prefix, so views that
need per-operation server ids are `complete: false` by construction
([limitations.md](limitations.md)).

## Limits, sanitisation, redaction

- `maxEventBytes` 16 KiB serialized — larger events are rejected at both
  producer and bridge.
- Details are sanitized on the producer: depth ≤ 4, arrays ≤ 24 entries
  (`+N more`), strings ≤ 480 chars (`…`).
- `REDACTED_KEY_PATTERN` matches key names
  `token|secret|privatekey|wrapkey|credential|authorization|receipt|apikey|password|cookie|sdp|keymaterial`
  (case-insensitive); the value is replaced with `"[redacted]"` before the
  event leaves the producer.
- The bridge re-validates structure (`validateDebugEvent`): registered
  component/event, severity enum, identity fields 1–128 chars, `details` a
  plain object. Invalid events are rejected with a reason that never echoes
  event contents.
- Content rule for new instrumentation (repo policy): never put document
  contents, credentials, SDP or key material in `details` — emit identity,
  counts and state names instead.

## Filters

`DebugEventFilter` (used by `/events?filter=<json>`, the dashboard, live
subscriptions, and MCP): `clientId`, `context`, `component`, `event`,
`severity[]`, `traceId`, `operationId`, `connectionId`, `boardId`,
`sessionId`, `since` (ISO), `text` (substring over event name + string detail
values). All present fields AND together. The `filter` query parameter is
**JSON-encoded**; `clientId`/`traceId` as flat query params are ignored.
