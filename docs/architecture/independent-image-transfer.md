# Job 9: independent image transfer and recovery

20 October 2026. Local implementation and validation; no deployment or release.
The [approved behavior contract](synchronization-contract.md) remains the target.

> **State at 6 November 2026 — this document describes code that only one platform
> now runs.** Every mechanism below hangs off the WebRTC collaboration manager
> (`src/collab/manager.ts`), and in the extension that manager's `doStart()` returns
> before it opens a pool, a signaling room or an image sync
> (`manager.ts:504-513`, gated by `setWebRtcDisabled(true)` in
> `src/sync/browser.ts:17`). Both extension bundles also replace
> `src/collab/peerRuntime.ts` with `peerRuntime.stub.ts`, whose
> `createProjectImageSync` and `createPboardWebRTCConnectionHandler` throw. So the
> peer `image-want`/`image-put`/`image-part` exchange described here **cannot run in
> the extension**. Android cannot reach it either: `apps/android/src/sync/service.ts:15`
> calls `setWebRtcDisabled(true)` too, so no peer pool or DataChannel starts there.
> The path is retained as source only.
>
> What replaced it in the extension is not a new image protocol: image bytes remain
> immutable, content-addressed Drive files referenced from card operations, written
> to the board's own folder as `image-<sha256>.json`
> (`src/sync/operations/driveStore.ts:191-203`) and uploaded **once per content hash**
> under a device-local receipt rather than on every publish
> ([drive-operation-sync](drive-operation-sync.md), "Images are uploaded once, by
> content"). Peer transfer is therefore not a latency path on any shipped platform:
> Android disables the peer pools as well.
>
> One detail below is also obsolete on its own terms: the account-private asset
> store is no longer a module called `privateImageTransport.ts` (that file does not
> exist in this tree). Private image persistence is the `imageTransport` the private
> history engine uses, writing `image-<hash>.pboard` in the account's AppData
> (`src/sync/runtime.ts:750`, `src/sync/privateDriveHistory.ts:382`).

## What is implemented

The independent WebSocket/WebRTC path now transfers and recovers attachment bytes
using the existing blob storage, content hashes and private Drive persistence:

- **Account-private asset store** (the `imageTransport` of
  [`privateDriveHistory.ts`](../../src/sync/privateDriveHistory.ts)):
  immutable, content-addressed `image-<hash>.json` records in this account's own
  `appDataFolder`, reusing the existing `DriveTransport` (bounded transient
  retry, no-store reads, immutable create; identical bytes are a no-op).
  Legacy shared-folder boards keep their shared Drive asset path unchanged.
- **Peer attachment exchange** ([peerHistory.ts](../../src/collab/peerHistory.ts)):
  on the same mutually proven, session-bound DataChannel already used for causal
  history, `image-want`/`image-put`/`image-ack`/`image-done` frames transfer
  bytes. The receiver independently re-derives the SHA-256 before storage, so a
  served asset cannot forge anything; MIME allowlist, size and dimension caps
  apply through the shared [imageAsset.ts](../../src/collab/security/imageAsset.ts)
  gate. Serving is decoupled from the receive pipeline (the per-image acks flow
  while the answer task continues, avoiding a serialized-frame deadlock); the
  `image-want` request resolves on `image-done`. All frames stay under the
  existing 512 KiB/chunk bounds and rate caps. The signaling/rendezvous relay
  carries no image contents (frames are peer-to-peer DataChannel payloads).
- **Recovery integration** ([imageSync.ts](../../src/collab/imageSync.ts)): the
  per-board image sync now requests missing bytes from authorized peers when its
  transport has none, and otherwise behaves as before (verification before
  storage; an arrived image never replaces newer text; retries keep attachments
  pending). The manager passes a session registry from the WebRTC handler and
  drains it on stop. `imageTransport` may be an async factory; the independent
  runtime selects the private asset store while the account is connected, and no
  transport (pure local bytes) when it is not.

No OAuth scope, Drive folder layout, RxDB document schema, board grant format or
production signaling default changes. Legacy Drive collaboration and its shared
image assets are untouched.

## Validation

- New regression file `tests/recovery/peerImageTransfer.test.ts` (4 tests):
  verified peer bytes over the DataChannel with tamper rejection and
  convergence; capability-negotiation fail-closed; immutable interrupted
  appDataFolder upload with bounded retry; imageSync peer-bridge recovery that
  preserves newer card text.
- Full TypeScript suite and recovery-directory suites pass without regression
  (the images-only relay restriction of Job 7 is respected: history frames still
  exchange no image bytes; the new exchange is a separate, hash-gated operation).
- Native/Android and live-Google acceptance remain Job 11/12 boundaries.

## Remaining before closing Job 9

- Out-of-order/resumable chunked transfer across a reconnect (currently a
  re-request on the next session; large assets are chunked within one attempt).
- Android runtime validation and the onboarding flow (Job 12 platform gate).
- Browser-level fixture coverage for two independent accounts exchanging images
  (the component tests cover the protocol; the native harness currently
  exercises text edits only).

## Attachment hardening after implementation review — 20 October 2026

- Serving checks verified signed card history for the authorized board before
  reading the global blob store. A hash alone cannot authorize a private or
  pending attachment. Receivers accept only explicitly requested images.
- Drive read/upload errors no longer prevent attempting peer recovery or other
  images. The manager tries remaining peers after one fails.
- Private asset operations pin their OAuth credential across lookup, transfer and
  HTTP retries. The runtime additionally verifies the board's durable private
  account binding and checks account continuity before/after each request. A
  credential is never refreshed into another account during an operation.
- Images exceeding the legacy history-frame bound use `image-part` messages on
  the DataChannel: 32 KiB string segments, strict sequential indexes/total,
  one bounded incoming assembly, per-part acknowledgement and pacing, 10-second
  stalled-assembly expiry, and the existing 20 MiB decoded-image maximum. Only
  the completed, hash-verified asset enters blob storage. Disconnect discards
  incomplete memory; reconnect retries from the beginning. History limits and
  signaling/server payloads are unchanged.
- Small images retain the existing `image-put` format. Older clients cannot
  receive the new large-image operation and fail closed; upgrade both peers for
  large attachments. This does not claim resumable byte-range transfer.

Regression coverage includes private-image denial, unsolicited payloads,
600 KiB transfer, interrupted transfer/retry, transient Drive failures,
credential switching and account-scoped persistence enrollment. The strict final
acceptance inventory remains incomplete; this change does not complete the
operating-mode UI or platform/security matrix.
