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
| [Synchronization contract (historical)](architecture/synchronization-contract.md) | Superseded by the Drive-first operation contract; retained as the acceptance baseline its 55 scenario IDs still index |
| [Recovery validation](architecture/recovery-validation.md) | Local fault harness, fresh-device recovery, security evidence and explicit implementation gaps |
| [Durable change journal](architecture/causal-change-journal.md) | Local journal and reconciliation foundation; transport integration now lives in the operation log |
| [Offline authorization and service admission](architecture/offline-authorization.md) | Durable permissions, pending edits, independent Google service gate and remaining Job 8 blockers |
| [Independent image transfer](architecture/independent-image-transfer.md) | Peer DataChannel attachment exchange, private asset store and recovery limits |
| [Operating modes and unified recovery](architecture/operating-modes-status.md) | Job 11 binding/status/scheduling implementation and Job 12 gate status |
| [Authenticated peer history](architecture/peer-causal-history.md) | Signed causal changes, bounded peer exchange, retained conflicts and compatibility limits |
| [Manual conflict resolution](architecture/conflict-resolution.md) | Version comparison, persistent drafts, signed resolutions and recovery limits |
| [Collaboration architecture](collaboration.md) | Current transport (one WebSocket per context, multiplexed rooms), Drive layout and ACL authority, snapshots and consolidation, lifecycle hints, budgets, measured costs, **status and known gaps**, and preserved history |
| [Collaboration security implementation plan](collaboration-security-plan.md) | Proposed encrypted transport policy, device authentication, receiver authorization, migration, and release verification |
| [Privacy policy](privacy.md) | Published disclosures and contact details |
| [Terms of Service](terms.md) | Software license, content, optional integrations, and service limitations |
| [GPLv3 license](../LICENSE.md) | Complete repository license text |
| [Experiment instructions](../experiments/collaboration/README.md) | Isolated Node and browser benchmark harnesses |

## Historical research

[Collaboration and storage evaluation](archive/collaboration-storage-evaluation.md) records the 28 September investigation, option comparisons, and initial benchmark results. Its descriptions and proposals are historical. Keep this evidence separate from current architecture; do not treat old test counts or benchmark samples as release verification.

## Public GitHub Pages content

`index.md`, `privacy.md`, and `terms.md` are the public homepage, privacy policy, and Terms of Service. `_layouts/default.html` and `assets/site.css` provide the shared presentation. `_config.yml` excludes the technical guides, this index, and historical research from the Pages build. Publishing steps are in the repository README.

## Maintenance notes

This review (6 November 2026) brought the entry points and the collaboration
guide in line with the running code: one WebSocket per browser context with
multiplexed rooms (protocol 3), Drive as the durable store and ACL authority, the
relay as a bounded operation log with replay, and the account channel's
inert-in-production status stated as a gap. It also removed the per-board-socket
and WebRTC-as-current-transport descriptions and corrected the Drive flush
intervals. No runtime behavior was changed.

When code changes, update the relevant maintained guide and link to it from the
handoff rather than copying its architecture. Use package/manifests for version
requirements, package scripts for validation commands, and `src/storage`,
`src/sync`, and `src/sync/operations` for runtime behavior. Date validation
evidence and state which harness was run; Google mocks are not real-Drive
verification.

Peer-era documents remain as history and carry a banner saying what superseded
them; they are not rewritten into claims about the current product.

Private history persistence and recovery: [Job 6 architecture and validation](architecture/private-drive-history.md).
