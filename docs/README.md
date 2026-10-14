# Pboard documentation

Use this index to find the maintained description of each part of Pboard. Reviewed 14 October 2026 against package version 0.9.5.

| Document | Purpose |
| --- | --- |
| [Repository README](../README.md) | Overview, installation, Drive configuration, and Pages setup |
| [Product specification](../SPECIFICATION.md) | Implemented user behavior and product limits |
| [Build and release guide](../BUILD.md) | Build commands, validation, packaging, Mozilla submission, and reviewer reproduction |
| [Refactor status](../REFACTOR_STATE.md) | Short implementation status and remaining verification |
| [Local storage architecture](rxdb-storage-refactor.md) | RxDB schemas, ordering, images, migration, fallback, rollback, and historical measurements |
| [Collaboration architecture](collaboration.md) | Drive layout, sharing, snapshots, signaling, WebRTC conflicts, account preferences, and security limits |
| [Privacy policy](privacy.md) | Published disclosures and contact details |
| [Terms of Service](terms.md) | Software license, content, optional integrations, and service limitations |
| [GPLv3 license](../LICENSE.md) | Complete repository license text |
| [Experiment instructions](../experiments/collaboration/README.md) | Isolated Node and browser benchmark harnesses |

## Historical research

[Collaboration and storage evaluation](archive/collaboration-storage-evaluation.md) records the 28 September investigation, option comparisons, and initial benchmark results. Its descriptions and proposals are historical. Keep this evidence separate from current architecture; do not treat old test counts or benchmark samples as release verification.

## Public GitHub Pages content

`index.md`, `privacy.md`, and `terms.md` are the public homepage, privacy policy, and Terms of Service. `_layouts/default.html` and `assets/site.css` provide the shared presentation. `_config.yml` excludes the technical guides, this index, and historical research from the Pages build. Publishing steps are in the repository README.

## Maintenance notes

This review corrected legacy-only storage descriptions, outdated browser/Node requirements, the Google scope list, and unsupported claims about peer authentication and automatic WebSocket fallback. Repeated handoff phase lists and contradictory test totals were consolidated; dated benchmark evidence was retained. No runtime behavior was changed.

When code changes, update the relevant maintained guide and link to it from the handoff rather than copying its architecture. Use package/manifests for version requirements, package scripts for validation commands, and `src/storage`, `src/sync`, and `src/collab` for runtime behavior. Date validation evidence and state which harness was run; Google mocks are not real-Drive verification.
