# Pboard refactor status

Reviewed against the repository on 14 October 2026; package version 0.9.4. This is a short status and handoff document. Architecture details live in the [documentation index](docs/README.md) rather than being repeated here.

## Implemented

- RxDB/Dexie is the default local repository, with project/card/settings subscriptions, fractional rank ordering, and a separate image Blob store. Legacy AppState is preserved for migration, fallback, and rollback. See [local storage](docs/rxdb-storage-refactor.md).
- Optional Google Drive private snapshots and account preferences remain asynchronous. Shared boards use visible Drive folders, owner/editor/viewer permissions, discovery/import, separate shared snapshots, and hash-verified image transfer. Both `drive.appdata` and full `drive` are requested.
- The sidebar starts a serialized collaboration manager for the active board. Two scoped WebRTC pools replicate projects/cards, with a separate account-order/removal settings pool. Newer document writes win conflicts; account deletion markers prevent resurrection. See [collaboration](docs/collaboration.md).
- Share controls, same-account live enablement, viewer mutation gates, local role refresh, and immediate account-list removal are wired into the app. Only owners delete shared content; collaborators remove it from their own lists.
- Unit/integration tests and a native Chromium two-profile harness exist. The ordinary gate is `npm run check`; browser signaling/conflict coverage runs separately with `npm run test:webrtc:browser`. See [BUILD.md](BUILD.md).

## Remaining verification and limits

- Exercise authenticated real-Drive discovery, invitations, role changes/removal, signaling latency, image delivery, and snapshot conflicts. Mocked transports and simulated Drive browser tests do not verify Google's behavior.
- Exercise Firefox and Chromium lifecycle paths: sidebar closure/reopen, extension update/reload, browser restart, and MV3 worker suspension/restart. Earlier rollout measurements in the storage guide are historical.
- Verify restrictive networks and Drive quota/backoff behavior. The shipped app uses Drive signaling; it has no automatic WebSocket fallback or configured TURN relay.
- Remote WebRTC peers are not independently authenticated: `isPeerValid` returns `true`. Local viewer gates and Drive folder access do not validate signed remote writes or provide immediate peer revocation. See [authorization and security limits](docs/collaboration.md#authorization-and-security-limits).
- Same-document conflicts use timestamps, not a text CRDT. Clock skew and concurrent edits can lose changes. Tombstones, old local recovery copies, and image references are retained; automatic blob garbage collection is not implemented.

## Documentation maintenance

The 12 October review removed duplicated phase lists, contradictory test totals, and old PR/checkpoint notes from this handoff. The earlier [storage evaluation](docs/archive/collaboration-storage-evaluation.md) is retained as historical research. The specification, README, storage guide, and collaboration guide now distinguish the implemented behavior from proposals and manual validation gaps.

No extension runtime code changed in this documentation cleanup. Previous test totals are not presented as evidence of a current passing suite; run the documented checks when validating a code change or release.
