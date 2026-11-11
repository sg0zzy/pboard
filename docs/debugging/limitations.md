# Limitations

Honest boundaries of what the Live Debug Bridge can and cannot show.

## Correlation

- **Server stages are room-scoped, not operation-scoped.** The relay's
  tracing lines carry its own `session`/`room`, never client operation ids,
  so `TraceView` links server legs by room and marks traces that would need
  a per-operation server stage `complete: false`. Adding operation ids to
  relay log lines is a relay change (and its own review), not a bridge fix.
- **Cross-machine ordering is approximate.** `receivedAt`/`bridgeSeq` give
  bridge-arrival order; producer wall clocks are never compared across
  machines. Within one producer use `sequenceNumber`/`monotonicTime`.
- **One bridge, one clock.** Multiple bridges cannot merge buffers; run one
  per debugging session.

## Observation, not participation

- **No control against real clients.** Fault injection, disconnect and test
  commands are mock-mode only. You cannot make the bridge resend, delay or
  break a running browser — the bridge is a read tap; use the harness for
  controlled faults.
- **The pull model is polled.** `/inspect/:clientId` answers within the
  client's poll window (seconds), and only while the client's context is
  alive. An MV3 worker that went silent cannot be inspected; its *events*
  remain in history.
- **Disabled instrumentation shows nothing.** The default production build
  emits nothing by design; enabling costs a reload
  ([firefox-debugging.md](firefox-debugging.md)). A bridge with no enabled
  clients is indistinguishable from a broken app unless you checked the
  setting first.

## Coverage

- **Content-blind by contract.** The bridge proves *that* an operation was
  created, transmitted, applied — with ids and timing — never *what* the
  card said. Diagnosing wrong-content bugs still needs RxDB-level tooling or
  a reproduction; the trace tells you where the divergence window is.
- **Postures differ in stage sets.** The operation-protocol posture emits the
  full log-room lifecycle; the legacy grant posture (E2E fixture) emits
  journal-level `created`/`applied` (and both emit transport/auth/Drive). A
  stage that "should" be there may simply not exist for that posture
  ([instrumentation.md](instrumentation.md)).
- **The Drive-authority operation room is not fixture-testable.** Its relay
  admission verifies real Google-issued JWTs against Google's fixed JWKS; the
  local verifier override exists only in the `test-google-fixture` build used
  by the recovery smokes. The bridge instruments that room's transport and
  auth identically to the others — its E2E coverage comes via the shared
  choke points, and acceptance runs the grant posture end to end.
- **Mock relay ≠ Rust relay.** Harness scenarios run a mini relay contract
  (the whitelist the observer expects); the real relay's behaviour is covered
  by the Firefox E2E and the Rust test suite, not by mock scenarios.
- **Buffered history is bounded** (20 000 events, dense cursors per bridge
  lifetime). Overflow is reported (`droppedByOverflow`,
  `bufferOverflown`), never hidden — but after an overflow the past is gone:
  start captures early for long investigations.

## Not intended to replace

- **Crash/error reporting.** Exceptions go through normal error handling; the
  bridge records sync/transport facts, not stack traces (they'd carry paths
  and potentially content).
- **Profiling.** Timings here are lifecycle stamps and monotonic deltas —
  enough to answer "where did this operation's minute go", not a CPU profile.
- **Security auditing of production.** The relay's own audit logs remain the
  source of truth for what actually happened on the server; the observer is
  a convenience mirror of a whitelisted subset.
