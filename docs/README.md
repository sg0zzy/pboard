# Pboard documentation

Use this index to find the maintained description of each part of Pboard. Development standards adopted 16 October 2026; version authority is `VERSION`.

| Document | Purpose |
| --- | --- |
| [Standards adoption](../DEVELOPMENT_STANDARDS.md) | Pinned central authority, mappings, exceptions and gaps |
| [Migration evidence](../STANDARDS_MIGRATION_REPORT.md) | Local validation and remaining release prerequisites |
| [Release operations](../RELEASE.md) | Preparation, signing, GitHub staging and manual distribution |
| [Version mapping](../VERSIONING.md) | Product authority and native package fields |
| [Repository README](../README.md) | Overview, installation, Drive configuration, and Pages setup |
| [Product specification](../SPECIFICATION.md) | Implemented user behavior and product limits |
| [Build and release guide](../BUILD.md) | Build commands, validation, packaging, Mozilla submission, and reviewer reproduction |
| [Refactor status](../REFACTOR_STATE.md) | Short implementation status and remaining verification (partly predates the operation-log runtime) |
| [Local storage architecture](rxdb-storage-refactor.md) | RxDB schemas, ordering, images, migration, fallback, rollback, and historical measurements |
| [Job sequence](JOBS.md) | The approved implementation order, with a state note on what each job became |
| [Synchronization contract (historical)](architecture/synchronization-contract.md) | Superseded by the Drive-first operation contract; retained as the acceptance baseline its 55 scenario IDs still index |
| [WebSocket signaling experiment (historical)](architecture/websocket-signaling-experiment.md) | The 0.5 signaling-only milestone; banner-marked history |
| [Recovery validation](architecture/recovery-validation.md) | Local fault harness, fresh-device recovery, security evidence and explicit implementation gaps |
| [Durable change journal](architecture/causal-change-journal.md) | Local journal and reconciliation foundation; transport integration now lives in the operation log |
| [Offline authorization and service admission](architecture/offline-authorization.md) | Durable permissions, pending edits, independent Google service gate and remaining Job 8 blockers |
| [Independent image transfer](architecture/independent-image-transfer.md) | Peer DataChannel attachment exchange, private asset store and recovery limits |
| [Operating modes and unified recovery](architecture/operating-modes-status.md) | Job 11 binding/status/scheduling implementation and Job 12 gate status |
| [Authenticated peer history](architecture/peer-causal-history.md) | Signed causal changes, bounded peer exchange, retained conflicts and compatibility limits |
| [Manual conflict resolution](architecture/conflict-resolution.md) | Version comparison, persistent drafts, signed resolutions and recovery limits |
| [Drive-first operation synchronization](architecture/drive-operation-sync.md) | Why Drive is the durable store and the ACL authority, and what the operation protocol replaces |
| [WebSocket operation log](architecture/websocket-operation-log.md) | Owns the wire protocol: one socket per context, multiplexed rooms, the key courier, retention, consolidation and the account inbox |
| [Board assets](architecture/board-assets.md) | Operation-carried metadata with bytes on Drive; implemented modules and the missing wiring |
| [Collaboration architecture](collaboration.md) | Current transport (one WebSocket per context, multiplexed rooms), Drive layout and ACL authority, snapshots and consolidation, lifecycle hints, budgets, measured costs, **status and known gaps**, and preserved history |
| [Security refactor: audit](security-refactor-audit.md) | The authorization/storage refactor's starting audit and the plaintext-form boundary |
| [Security refactor: progress](security-refactor-progress.md) | Implementation checklist for the Google/Drive authorization refactor, with resume notes |
| [Testing infrastructure](testing/README.md) | Local commands, fixture boundaries and what the in-process suite does not prove |
| [Testing architecture](testing/architecture.md) | Test boundaries, fixture limitations, current verification and remaining gaps |
| [Collaboration security implementation plan](collaboration-security-plan.md) | Proposed encrypted transport policy, device authentication, receiver authorization, migration, and release verification |
| [Privacy policy](privacy.md) | Published disclosures and contact details |
| [Terms of Service](terms.md) | Software license, content, optional integrations, and service limitations |
| [GPLv3 license](../LICENSE.md) | Complete repository license text |
| [Experiment instructions](../experiments/collaboration/README.md) | Isolated Node and browser benchmark harnesses |

## Historical research

[Collaboration and storage evaluation](archive/collaboration-storage-evaluation.md) records the 28 September investigation, option comparisons, and initial benchmark results. Its descriptions and proposals are historical. Keep this evidence separate from current architecture; do not treat old test counts or benchmark samples as release verification.

## Public GitHub Pages content

`index.md`, `privacy.md`, and `terms.md` are the public homepage, privacy policy, and Terms of Service. `_layouts/default.html` and `assets/site.css` provide the shared presentation. `_config.yml` excludes every technical guide — by name and by directory (`architecture/`, `testing/`, `archive/`) — plus this index and the two security-refactor records; those name deployment hosts, a deployed-binary digest and local paths, so publishing them would leak operational detail. Publishing steps are in the repository README.

## Maintenance notes

A review on 10 November 2026 brought the guides in line with the running code
again. The corrections, each verified against the tree:

- **The WebRTC peer stack is unreachable on every platform.** Both composition
  roots call `setWebRtcDisabled(true)` (`src/sync/browser.ts`,
  `apps/android/src/sync/service.ts`); several guides still said Android ran it.
  The modules survive as source with unit tests, not as a path.
- **Live collaboration is a Firefox-and-Android path.** The Chromium provider
  (`src/sync/googleChromeAuth.ts`) supplies no Google identity credentials, so a
  Chromium board opens no room and converges through Drive.
- **The plaintext operation codec is production**, not an unwired experiment: it
  seals every Drive-authorized room.
- **The account inbox has a client on both ends**, so a cross-account invitation
  reaches the invitee's account channel instead of waiting for a Drive poll.
- **Account board order is realtime** over the account room, with the Drive
  preference file as the durable record.
- Measured figures were re-taken: 1 870 client tests in 257 files (172 of them in
  18 multi-browser files), 106 Android checks, 169 relay tests, sidebar chunk
  637 kB (183 kB gzip), background 839 kB (247 kB gzip).

The GitHub Pages exclusion list was also corrected: it named five files while the
README promised that every technical document was excluded, so `architecture/`,
`testing/` and the two security-refactor records would have been published —
including a deployment host, a deployed-binary digest and local file paths. The
list now excludes those directories and files explicitly.

When code changes, update the relevant maintained guide and link to it from the
handoff rather than copying its architecture. Use package/manifests for version
requirements, package scripts for validation commands, and `src/storage`,
`src/sync`, and `src/sync/operations` for runtime behavior. Date validation
evidence and state which harness was run; Google mocks are not real-Drive
verification.

Peer-era documents remain as history and carry a banner saying what superseded
them; they are not rewritten into claims about the current product.

Private history persistence and recovery: [Job 6 architecture and validation](architecture/private-drive-history.md).
