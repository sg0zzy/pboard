# Development standards adoption

| Field | Adopted value |
| --- | --- |
| Standards origin | https://github.com/sg0zzy/dev-standards |
| Edition | 1.0.0 |
| Immutable commit | `e3111c4e9dc652f833a5f2ba5232c292646e7969` |
| Tag | None exists at adoption; default-branch commit selected |
| Policy source | Separately retrieved checkout, verified against [dev-standards.lock.json](dev-standards.lock.json) |
| Integrity verification | `python3 scripts/verify-standards.py /path/to/dev-standards`; full Git SHA and SHA-256 of all 21 documentation/configuration files |
| Adoption date and authority | 2026-10-16; explicit repository migration request in this session; no remote-operation authority granted |
| Scope/status | Partial adoption: Firefox, Chromium and Android; release activation and existing data/security safeguards have gaps recorded below |
| Native configuration | [project-standards.json](project-standards.json) |
| Evidence | [STANDARDS_MIGRATION_REPORT.md](STANDARDS_MIGRATION_REPORT.md) |

This declaration follows the central adoption template. Central policies define the contracts; this repository supplies independent implementations. Builds never fetch or execute anything from dev-standards.

## Authority and applicable documents

Apply, in order: explicit user instructions and non-overridable security/platform requirements; the pinned central standards; documented project exceptions permitted by those standards; local policies; historical implementation. Central MUST/MUST NOT requirements override conflicting local conventions. SHOULD departures need rationale; documenting an unmet MUST does not make it compliant.

Read [the pinned central README](https://github.com/sg0zzy/dev-standards/blob/e3111c4e9dc652f833a5f2ba5232c292646e7969/README.md) and applicable `VERSIONING.md`, `BUILD.md`, `RELEASE.md`, `ARTIFACTS.md`, `DISTRIBUTION.md`, `SECURITY.md`, `ARCHITECTURE.md`, `COMPLIANCE.md`, `ANDROID.md`, `CONFIGURATION.md`, and `ADOPTION.md` from that same commit. The central `AGENTS.md` governs maintenance of the standards repository; this project's [AGENTS.md](AGENTS.md) follows its project-agent template.

## Project mapping

| Policy concept | Repository implementation |
| --- | --- |
| Architecture, offline/privacy, recovery | [README.md](README.md#architecture), [SPECIFICATION.md](SPECIFICATION.md), [storage](docs/rxdb-storage-refactor.md), [collaboration](docs/collaboration.md); recovery/security gaps below |
| Version authority, mirrors, development base, compatibility | [VERSIONING.md](VERSIONING.md), `VERSION`, `scripts/sync-version.mjs` |
| Build matrices, package profiles, host capabilities | `project-standards.json`, [BUILD.md](BUILD.md) |
| Source capture and local artifacts | `scripts/local-build.mjs`, `scripts/artifact-retention.mjs`, [BUILD.md](BUILD.md#managed-artifacts) |
| CI revision, tests, temporary output | `.github/workflows/ci.yml`, [BUILD.md](BUILD.md#ci) |
| Shared official reservation/publication coordination | `official-release-lifecycle` concurrency group in both release entry workflows; `scripts/release-control.mjs`; [RELEASE.md](RELEASE.md) |
| Preparation, notes, recovery | `scripts/release.sh`, `scripts/beta-version.sh`, `scripts/release-cli.mjs`, `scripts/prepare-release.mjs`, [RELEASE.md](RELEASE.md) |
| Signing, Android history and update edges | `project-standards.json`, `scripts/sign-android.mjs`, [RELEASE.md](RELEASE.md#signing-and-platform-identities) |
| Destination modes and authorization | `project-standards.json`, [RELEASE.md](RELEASE.md#distribution) |

## Decisions, exclusions and gaps

| Type | Policy | Decision and consequences | Owner |
| --- | --- | --- | --- |
| SHOULD departure | ARCHITECTURE: Android stack | Retain working Capacitor/React/TypeScript Android application and native Java plugins; a Kotlin/Compose rewrite would add migration risk without adoption benefit | Maintainers |
| SHOULD departure | ADOPTION: vendored snapshot | Use verified retrieval plus full-file digests instead of copying central documents. Verified checkouts may be cached locally; initial offline access needs a previously verified checkout | Maintainers |
| Implementation | RELEASE: preparation automation | Bash preparation validates/synchronizes metadata, creates a dedicated commit when needed and an annotated local tag; push is a separate explicit command. Metadata failures roll back; later Git failures preserve a documented resumable checkpoint | Maintainers |
| Scope exclusion | BUILD | No native desktop installer or standalone hosted application exists. Browser extensions run on desktop OSs. No AppImage/MSIX/EXE/macOS/AAB target is removed or newly implied | Maintainers |
| Explicit defaults | ARTIFACTS / BUILD | Keep 10 successful unprotected local builds; temporary CI packages 14 days. No override | Maintainers |
| MUST gap | RELEASE / ANDROID | Complete remote history, deleted reservations/store submissions, production certificate and installed-code inventory are unverified. explicit `history.unresolved` migration gaps, signing fingerprint/code null and Android `historyReviewed: false` block official allocation/publication; ordinary releases use automated remote inventory without manual history approval | Release owner |
| MUST gap | SECURITY | GitHub branch/tag protections and protected environment controls cannot be established by local files; validate actual repository settings before release activation | Repository owner |
| MUST gap | ARCHITECTURE recovery | Board ZIP/text/image exports exist but are not a complete database backup/restore. Full recovery procedure and representative restore evidence are missing, particularly Android photos and tombstones | Application maintainers |
| MUST gap | ARCHITECTURE privacy/sync | Existing peer authentication/receiver authorization limitations remain in [collaboration.md](docs/collaboration.md#authorization-and-security-limits); see existing security plan. No application/data rewrite in this migration | Application maintainers |
| Validation gap | RELEASE / COMPLIANCE | Remote workflows, live publication retries, store signing/acceptance and physical-device update paths have not executed in this migration; only isolated retry simulations ran | Release owner |

These gaps prevent a full-compliance claim. Do not remove required targets or weaken their signing profiles to obtain a green release.

## Authorized automation

No standing authority to push, create remote tags, publish, sign through external services or deploy is adopted by this change. Future reviewed beta dispatches/stable tag pushes can initiate the declared GitHub flow under central SECURITY; owner configuration and required environment approvals still apply. External stores remain manual or disabled. A mode, credential or configuration flag alone is not permission for an agent to act remotely.

## Retrieve, verify and update

Retrieve a documentation checkout outside this repository, then detach at the pin:

```sh
git clone https://github.com/sg0zzy/dev-standards.git /tmp/pboard-dev-standards
git -C /tmp/pboard-dev-standards checkout --detach e3111c4e9dc652f833a5f2ba5232c292646e7969
python3 scripts/verify-standards.py /tmp/pboard-dev-standards
```

Read applicable documents from that verified checkout. The digest inventory includes all normative documents, cross-references, templates and examples. Do not execute central build tools or use a newer local sibling checkout accidentally.

If central access fails, use an existing verified cached checkout of exactly this revision. If none is available, report the missing policy source and continue independent safe inspection only; do not guess rules, claim compliance, release, or perform policy-dependent deletion.

To update: explicitly select a stable tagged revision when available (otherwise a specific default-branch SHA); compare obligations against this pin; assess identity/signing/data/cleanup/distribution effects; implement and validate affected acceptance cases; regenerate file digests from the verified new commit; update the pin, mappings and evidence together for review. Preserve all historical tags, codes and protected artifacts. Do not enable a destination as a side effect of updating standards.
