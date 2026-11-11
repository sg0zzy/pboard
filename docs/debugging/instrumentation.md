# Instrumentation

Every emit site in the shipping runtime, and the rules for adding a new one.
All sites below are **gated**: with the bridge disabled (the default in every
production build) each costs a boolean check or a single property read.

## The three helpers

1. **`emit(event)`** (`src/debug/bus.ts`) — the only entry point. Enforces
   validation, sanitisation, redaction, queue bounds and batching. Returns the
   per-producer sequence number (0 when disabled or rejected).
2. **`trackTransportSocket(socket, trigger, room?, device?)`**
   (`src/sync/transportDiagnostics.ts`) — one call per dial. Attaches
   `{once:true}` lifecycle listeners (`connection.requested/opened/closing/
   closed`, `reconnect.*` via the owner's `dial.reconnected(delayMs)` call)
   and returns a `TransportDial` handle whose `debugConnectionId` is defined
   only while a bridge is watching. It never wraps the socket.
3. **`emitBridgeFrame(dial, direction, frame, details?)`** — frame-level
   `websocket.message.sent/received`. Unwatched callers pay one property read.
   Only the frame `type` (+ optional `action`) and `room` are projected —
   payload contents never pass through this path.

`markBridgeWatching()` is called once per context when the bridge activates
(`src/debug/browser.ts` handle path and the E2E probe); before that, dials
exist in the ledger but carry no `debugConnectionId` and emit no per-frame
events.

## Emit sites

| Site | Events | Mechanism |
|---|---|---|
| `src/sync/transportDiagnostics.ts` | `websocket.connection.*`, `reconnect.*` | `trackTransportSocket` at the single choke point all four dial sites call (`logSync`, `logSession`, `experimentalWebSocketSignaling`, `keyCourierTransport`) |
| `src/sync/operations/logSync.ts` | auth pair (`authentication.started/completed/failed`), `subscription.accepted`, frame events | `emitBridgeFrame` on its send/receive; auth events when `debugConnectionId` is present |
| `src/sync/operations/logSession.ts` | same shape (protocol v3 shared session) | ditto (`settleAttach`, `emitAuthRejected`, `transmit`/`receive`) |
| `src/collab/experimentalWebSocketSignaling.ts` | auth pair + frame events | welcome→`authenticate` (started: version + room only), `authenticated` (completed), `fail()` (failed); `send`/inbound (frame events) |
| `src/sync/operations/localStore.ts` | `sync.operation.created` / `.queued` | after the durable commit of a local operation (operationId, seq, clock, kind, collection — no content) |
| `src/sync/operations/logRoom.ts` | `operation.transmitted` / `.acknowledged` / `.duplicate` / `.received` / `.validated` / `.applied` | per-stage, seq-scoped |
| `src/sync/driveTransport.ts` | `drive.upload.*` / `download.*` / `retry.scheduled` / `ratelimit.detected` / `revision.conflict` / `authorization.failed` | file-id prefix + status; ids only, never board content |
| `src/storage/journalStorage.ts` | `sync.operation.created` (local commit) | causal journal choke point: after `journal.finish`, one event per committed entry of origin `local` (ids, collection, parent count) |
| `src/storage/changeJournal.ts` | `sync.operation.applied` | `ChangeJournal.accept` — every verified inbound path (peer replication, reconciliation receive, Drive history archive) lands here; origin `observed`, only new durable commits |
| `src/background/index.ts`, `src/sidebar/main.tsx` | `lifecycle.runtime.initialized`, `listeners.registered` | composition roots (also call `configureDebugForContext` + `registerDebugStateInspection`) |

The last two storage rows are the instrumentation for the **legacy grant
posture** (`operationSync: false`, e.g. the Firefox E2E fixture): that posture
replicates the causal journal over DataChannels, not operation-log rooms, so
its authored/applied choke points are `journalStorage` (local) and
`ChangeJournal.accept` (observed). The operation-protocol posture emits the
`localStore`/`logRoom` events instead; both postures share the transport,
auth, Drive and lifecycle instrumentation.

## Adding an event

1. Register the name in `DEBUG_EVENTS` (`src/debug/schema.ts`) — one line,
   with a sentence of meaning. The bridge and producer both reject
   unregistered names, so this step cannot be skipped.
2. Choose identity: `boardId` always for board-scoped events; `operationId`
   whenever one exists; `connectionId` from a dial you already hold.
3. Details carry ids, counts, state names, codes. The redaction pattern is a
   backstop, not a licence: never add document contents, tokens, SDP, or key
   material — the event proves *that and when*, not *what*.
4. Gate the cost behind an existing boolean (`debugConnectionId !== undefined`,
   or just call `emit` when you already know the bus is on). Never await a
   diagnostic.
5. Add it to `docs/debugging/event-schema.md` and — if it is a stage of a
   user-visible pipeline — to `CARD_OPERATION_TRACE_STAGES` (or accept the
   honest `missingStages` report).
6. Cover it: a producer unit test (the emit fires, shape validates, content
   rule holds), and it should appear in a harness or E2E scenario trace when
   it is on the hot collaboration path.

## What instrumentation must never do

- Throw: sanitisation is inside the bus; a custom emit site must not let a
  diagnostics error escape its call.
- Change control flow: no `await emit`, no reading emit's return to decide
  behaviour, no reordering work around diagnostics.
- Observe payload: `emitBridgeFrame` takes a projection argument for a reason.
- Keep references: the bus holds only sanitized events; the ledger holds
  counters and small records with bounded history.
