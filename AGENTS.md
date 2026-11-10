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
