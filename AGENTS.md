# Project agent instructions

Read [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md) before relevant work. Consult the applicable central policies at the exact pinned revision and verify their source with `scripts/verify-standards.py`. The central standards take precedence over conflicting local conventions. Use a verified cached checkout if central access is unavailable; if neither can be verified, report this and avoid guessing compliance or policy-dependent release/deletion operations.

Project implementation details:

- `VERSION` is authoritative; [VERSIONING.md](VERSIONING.md) maps generated mirrors and platform fields.
- [BUILD.md](BUILD.md) documents independent build commands, target capabilities, artifact cleanup/protection and reviewer reproduction. [RELEASE.md](RELEASE.md) documents preparation, signing, distribution and failure recovery.
- `project-standards.json` declares targets and destination modes. Release readiness remains blocked until owners reconcile history, certificate identity and repository protections. Record evidence and gaps in [STANDARDS_MIGRATION_REPORT.md](STANDARDS_MIGRATION_REPORT.md).
- Preserve the existing browser/Android architecture, user data and compatibility identities. Read [SPECIFICATION.md](SPECIFICATION.md), [storage](docs/rxdb-storage-refactor.md), and [collaboration](docs/collaboration.md) before changes to those systems. Do not introduce frameworks solely for standardization.
- Preserve pre-existing staged, unstaged and untracked work. Before work, inspect `git status`, `git branch --show-current` and `git rev-parse --show-toplevel`. Stay in the current worktree/branch; do not switch branches or modify another worktree. `AI_INSTRUCTIONS_BRANCH_cloud.md` is a historical cloud-worktree note, not a command to relocate this checkout.
- Never include private env files, raw source diffs, keystores or secret values in artifacts/logs. Keep public OAuth client parameters distinct from confidential signing credentials.
- Remote actions require explicit applicable authorization under the pinned SECURITY policy. This migration authorizes no commits, tags, pushes, remote workflow runs, publication, deployments or credential changes. Do not silently change the standards pin or activate distribution.

Keep subsystem instructions where present. No project-owned nested AGENTS.md was found at adoption; dependency/worktree copies are outside this checkout's instruction scope.

## Testing and documentation maintenance

When modifying Pboard, inspect the existing testing infrastructure and [testing architecture](docs/testing/architecture.md). Changes affecting authentication, collaboration, synchronization, persistence, external APIs, or browser lifecycle must include appropriate updates to local mocks, regression tests, and technical documentation. Execute the relevant regression suite and report its results; disclose checks that cannot run.

- Review identity mocks and authorization tests for authentication changes; review Drive fixtures and contract tests for Drive API changes.
- Review relay protocol contracts, server fixtures and synchronization tests for message changes; review convergence and regression tests for synchronization changes, and recovery and durability tests for persistence changes.
- Cover new user-visible collaborative operations with multi-client tests. For collaboration bugs, reproduce the bug in a regression test before fixing it whenever feasible.
- Update affected architecture diagrams and mock limitations. Add new scenarios to the testing scenario catalog when one exists, and keep contracts and documentation aligned with actual behavior.

## Live Debug Bridge

When changing authentication, synchronization, transport, Drive, or persistence code, keep the Live Debug Bridge instrumentation truthful (see [docs/debugging/](docs/debugging/README.md)):

- Emit only through `src/debug` helpers, and register every event name in `DEBUG_EVENTS` (`src/debug/schema.ts`) before emitting it; unregistered names are rejected at both producer and bridge.
- Diagnostics must never change application behaviour and must be content-free: ids, counts, states and codes only — never tokens, credentials, SDP, key material or board contents. The bus redacts by key name as a backstop, not as permission.
- `src/debug` and `tools/pboard-debug` run under Node's type stripping: keep those modules free of runtime imports in `schema.ts` and of non-erasable TypeScript syntax.
- Changes to `src/debug`, `tools/pboard-debug`, or any emit site require `npm run debug:test`; changes to collaboration transports additionally require the real-browser acceptance run `npm run debug:test:e2e` (Firefox + geckodriver via `PBOARD_GECKODRIVER`, see [firefox-debugging.md](docs/debugging/firefox-debugging.md)).
- Update `docs/debugging/event-schema.md` when the registry changes, `docs/debugging/instrumentation.md` when emit sites change, and `CARD_OPERATION_TRACE_STAGES` when a user-visible pipeline gains or loses a stage.
- The bridge binds loopback only, authenticates with `PBOARD_DEBUG_TOKEN` when set, and refuses cross-origin callers; fault injection exists only in bridge mode `mock`. Production observation is read-only (relay log observer); accessing production at all requires explicit applicable authorization under the pinned SECURITY policy.
- Exported captures and E2E artefacts live under gitignored `test-results/`; they contain ids and timings. Never commit them; when quoting one (a report demonstration), include only the minimal excerpt and never expand redacted or content-bearing fields.
