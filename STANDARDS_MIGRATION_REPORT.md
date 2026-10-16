# Standards migration report

Adoption date: 2026-10-16. Central origin: https://github.com/sg0zzy/dev-standards. Edition **1.0.0**, commit **`e3111c4e9dc652f833a5f2ba5232c292646e7969`**. No central tags existed; Git resolved main to this SHA. Browser access returned 404, but authenticated Git retrieval succeeded. The pinned checkout and SHA-256 inventory of all 21 files were verified locally. No policy was reconstructed from memory.

Status: **partial adoption, with tested local development and fail-closed release infrastructure**. Unverified production identity/history, repository controls and existing recovery/security gaps prevent claiming full compliance. No remote workflow or release was executed.

## Audit and migration checklist

Inspection covered root/ancestor/nested agent instructions (no project-owned AGENTS.md existed), local VERSIONING/BUILD/RELEASE/README and docs index, workflows, npm/lock metadata, both browser manifests, version/build/package/release scripts, Android Gradle/manifests/Capacitor configuration, artifact locations and Pages configuration. Existing browser reviewer, license, store listing/permission and Android operational instructions were retained. Dependency and `.delta` worktree agent files were outside this checkout's policy scope.

The internal checklist established before edits was: preserve initial dirty work; pin/verify standards; consolidate authority/docs; map architecture/version/platform/signing/distribution; fix local snapshot/storage/retention; update read-only CI outputs; share release coordination and staged publication; fail closed on unverified production signing/history; validate documentation, scripts, workflows, tests and builds; report gaps without application rewrites.

The checkout already had edited/untracked build/release work and a staged deletion of `scripts/build-manifest.mjs`. Those changes were incorporated rather than reset; the staged deletion remains untouched. No branch switch, Git commit/tag creation, push, remote dispatch, publication, deployment or credential change was performed.

## Implemented documentation changes

- Added `DEVELOPMENT_STANDARDS.md`, following the central adoption template: pin, precedence, applicable documents, native mappings, justified departures, MUST gaps, authorization and update/offline behavior.
- Added `dev-standards.lock.json` and repository-owned `scripts/verify-standards.py` for exact Git SHA plus full-file digest verification. Central policies are retrieved separately rather than duplicated locally; normal builds never fetch them.
- Added concise root `AGENTS.md`: read adoption first, verify and consult pinned policies, central precedence, project commands/data safeguards, preserve active worktree and user work, and explicit remote boundaries. No useful subsystem agent instructions were removed.
- Replaced the duplicated local versioning contract with `VERSIONING.md` describing Pboard's actual authority, generated mirrors, numeric platform mappings, code bounds and version-zero compatibility surface.
- Reworked `RELEASE.md` into concrete preparation, signing, workflow, notes, manual distribution and recovery instructions. Removed claims that unsigned/debug packages are production releases, and that retries may silently replace completed assets.
- Updated `BUILD.md`, README and docs index. Retained Chrome listing/permission/reviewer guidance, package verification, temporary installation and reproducible Firefox compilation. Distinguished upload ZIPs from signed XPI/CRX. Clarified that Drive synchronization is not historical backup.
- Reframed the stale cloud-worktree handoff file as historical context while preserving its branch/worktree safety instructions.

Generic SemVer, local-build identity, retention, release-state, permission and architecture rules now have their authority in dev-standards rather than independently editable local policy. Operational commands and project-specific mappings remain local. No useful operational document was deleted.

## Implemented tooling and workflow changes

`project-standards.json` declares required target matrices separately for local/CI/beta/stable, explicit signing profiles, retention, historical-inventory readiness, and per-channel store modes. Unknown targets, contradictory requiredness, invalid signing/modes and retention values fail validation. All prior packaging capabilities remain: Firefox/Chromium ZIPs, Android debug testing and Android release APK compilation; official release APK completion now requires a verified production signature. No native desktop/AAB target existed.

The unified local builder captures a private immutable dirty-source copy, records tracked/untracked/deleted input identities plus the effective public OAuth parameter, and builds with repository-owned implementations. Every selected target is required and recorded. It archives final output to unique exclusive direct children of `local_artifacts/` for both stable and development-selected VERSION states. It preserves developer `dist/` locations as intermediates. Private env files and raw Git patches are not archived. Low-level staging/reviewer commands are explicitly documented.

Artifact transactions use schema/manager ownership, explicit state, atomic manifest replacement, sizes/hashes and a completion sequence allocated under one shared lock. Creation, completion, protection and collection coordinate through that lock. Retention defaults to 10 successful unprotected builds and rejects/excludes unsafe roots/children, traversal, malformed/unknown/legacy records and duplicate completion sequences. `.keep` of any type protects without consuming a slot. Cleanup replans/revalidates; failed builds never invoke it. Manual failed/protected recovery has a dry-run and requires repeating the exact positively owned build ID as confirmation. Legacy layouts remain untouched. The old unreferenced metadata writer was removed after its callers were replaced; the prior staged legacy-manifest deletion was preserved.

Local Android builds no longer require selecting a development core or mutate tracked Gradle fields. They use a local versionName, retain the tracked code, verify package identity/signature, and remain debug/test-only. Unsupported old bundle reuse fails explicitly. Device install/launch still requires the explicit existing flags.

Version sync now includes the previously stale Android lockfile, which moved from mirrored `0.10.1` to canonical `0.10.2`. Tests derive the version from VERSION. Existing authoritative VERSION and tracked Android code/ID remain unchanged. Encoded production-code compatibility is retained with strict bounds; complete production history is still required before activation.

CI now checks out the exact event SHA, records proposed-merge PR head/base identity, runs required root/Android checks, builds Firefox/Chromium/Android, and uploads mandatory temporary packages and manifests for 14 days. Failed diagnostics are separately labeled. No production signing/API secrets are passed to compilation. Actions are pinned to full commits resolved from their v4 references during migration.

Beta/stable workflows share `official-release-lifecycle`. Trusted control code resolves/revalidates source, checks reviewed-main ancestry and matching configuration/Firefox identity, inventories paginated remote tags/releases plus reviewed aliases/tombstones, and uses SemVer ordering. Beta allocation creates annotated refs without update/force operations; stable validates annotated tags. Beta reservation continues packaging in the same workflow. Exact-beta-tag retry uses that tag as selector. Source corrections or superseded reservations need a greater version.

Official compilation is read-only. A separate protected Android signer consumes the hash-verified unsigned intermediate, verifies final package fields/certificate, and uploads verified output. Aggregate staging requires every mandatory target and transport hash. A reviewable notes/manifest/checksum plan is produced before protected publication approval. Publication requires identical regenerated plan bytes, verifies draft upload bytes and rechecks ordering before visibility. Beta explicitly disables latest stable. Store delivery was removed from the combined release job and is manual/disabled, independent of GitHub completion.

Stable preparation now requires explicit `X.Y.Z`; dry-run makes no edits or refs, and apply rolls back metadata on validation failure. Commit, annotated tag and authorized push remain separate human operations. Neither local build nor preparation auto-increments a stable release or publishes anything.

Vitest now explicitly includes this checkout's `tests/**/*.test.{ts,tsx,mjs}`. The first broad run accidentally included an old embedded `.delta/worktrees/` checkout (124 files/838 tests) and produced a WebRTC timeout/unload error. Scoping excludes unrelated worktree tests without modifying either worktree's application code.

## Retained decisions and compatibility

- Preserve TypeScript/React/RxDB WebExtensions and existing Capacitor/React/native Java Android integration. Native Kotlin/Compose is a SHOULD preference, not a migration requirement.
- Preserve Gecko ID `project-board@local.invalid`, Android ID `it.stefanogozzi.pboard`, existing OAuth IDs, data schemas, synchronization formats and native API 33/36 support.
- Preserve existing Android code arithmetic and historical values; new official reservations remain blocked until its actual signing/submission high-water inventory is reviewed. No unsupported upgrade edge is promised.
- Use verified central retrieval instead of vendored duplicate policies. Offline work requires a previously verified checkout; missing unverifiable policy blocks policy-dependent release/deletion.
- Keep manual release commit/tag preparation and manual/disabled stores. No standing external automation authorization is adopted.

## Compliance by area

| Area / central cases | Result and evidence |
| --- | --- |
| Adoption P01–P03 | Pin and all policy digests verified; template/native mapping supplied; invalid mappings tested. Offline behavior documented; initial offline-without-cache is explicitly blocked |
| Local L01–L03, L13 | Two full dirty builds at the same Git SHA succeeded with unique directories and different snapshot digests; VERSION unchanged; compilation uses captured inputs. Installed dependencies are identified by locks and must not be mutated during a build |
| Artifacts L04–L12 | Isolated tests cover default/zero retention, reverse completion order/clock disagreement, protection, stale plan, failed/active/unknown/legacy records, malformed/traversal records, duplicate sequence, symlink root/child/internal link, stale lock and concurrent processes |
| Local failure L06/L14 | Missing-SDK injection returns failure, records failed required Android outcome and preserves both preceding successes without retention |
| Versions V01–V03 | Numeric/core/prerelease/metadata precedence, skipped-core forward progress, failed-reservation high-water and malformed official forms pass repository tests |
| CI C01–C05 | Exact-revision/read-only/required matrices/temporary upload gates statically validated; live GitHub CI execution pending; no optional targets declared |
| Beta B01–B07 | Dispatch, full inventory, create-only tag, common serialization, exact-tag retry and explicit prerelease/latest controls implemented. Remote concurrency/retry/publication execution pending; activation blocked by inventory/signing |
| Stable S01–S07/S10 | Explicit preparation/dry-run, annotated/source checks, staged mandatory gate and complete stable baseline implemented. No refs created locally; actual tag-triggered builds and environment review pending |
| Retry S08–S09 | Published retries verify existing bytes and return a no-op without rebuilding; drafts reuse hash-identical staged assets and upload missing ones. Conflicting content fails for audited recovery; live timeout/retry tests pending |
| Android A01–A08 | Debug APK built/verified; arithmetic boundaries and beta→stable numeric ordering tested; missing production identity fails preflight. Production signer/history/device updates and store certificate compatibility remain unverified |
| Distribution D01–D05 | Store modes manual/disabled, builds do not upload stores, destination evidence/retries documented. Real store transfer/acceptance not tested; no automatic store integration claimed |
| Security Q01–Q02 | Read-only builds, isolated signer/control publisher, reviewed-plan gate, no raw secret/diff archives, immutable asset guards. Actual protected environments/rulesets remain owner work; no remote mutations performed |
| Architecture R01–R12 | Existing architecture and data behavior preserved; conditional stack rationale documented. Existing full backup/restore and collaboration trust gaps remain; no full architecture-compliance claim |

## Local validation evidence

Source context: existing checkout on `main`, original uncommitted work preserved; manifests record full HEAD and effective configuration digests. Evidence files below are local ignored logs, not official release artifacts.

| Check | Observed result |
| --- | --- |
| Exact standards SHA and SHA-256 inventory | Pass, 21 files; `python3 scripts/verify-standards.py /tmp/pboard-standards.R5jlaX` |
| Remote standards tag inventory | No tags; pinned main SHA independently resolved by Git |
| Read-only project history | Three tags and three published stable releases: v0.9.3, v0.9.6, v0.10.1. These do not establish deleted identities or Android store history |
| Root TypeScript | Pass (`npm run typecheck`) |
| Scoped full root suite | 70 files / 465 tests passed; `.build-state/migration-tests.log` |
| Added release-gate fault suite | Five tests passed with fake Git/GitHub executables and isolated files; no network/ref mutations. Missing target, corrupted bytes, dirty source, wrong signer and missing reviewed plan and changed published bytes fail closed; identical existing publication verifies read-only |
| Focused retention/version/release gates | 24 tests / 3 files passed on the final focused run, including later comparator/trusted-identity/idempotence changes. Logs: `.build-state/migration-policy-tests-final.log`, `.build-state/migration-release-tests.log` |
| Android TypeScript and tests | Pass, 15 files / 98 tests; `.build-state/migration-android-tests.log` |
| Full local build twice | Firefox and Chromium package byte-verification, Firefox strict lint and Android debug Gradle assembly/signature/identity passed; `.build-state/migration-build.log`, `.build-state/migration-build-final.log` |
| Final public build entry | `npm run build` passed after the final local-runner changes, including locked staging preservation; `.build-state/migration-firefox-final.log` |
| Manifest integrity | Every preserved final package size/SHA-256 matched its manifest; both successes recorded all three targets; completion sequences 1 and 2 |
| Failure injection | Invalid SDK path failed; two prior successes preserved; failed manifest excluded by cleanup dry-run; `.build-state/migration-failure.log` |
| Version mirrors | `node scripts/sync-version.mjs --check` passed after repairing Android lock mirror |
| Workflow syntax | All four YAML documents parsed; actionlint 1.7.7 passed (temporary local installation) |
| Shell validation | `bash -n` passed for all repository shell scripts. ShellCheck was unavailable |
| Build verification | `node scripts/verify-build.mjs all` passed |
| Documentation references and whitespace | 66 relative file/heading references resolved after excluding inline Markdown examples; `git diff --check` passed |

Preserved successful build IDs:

- `0.10.2-local.147594974188894793326708714648792616696`
- `0.10.2-local.93527491865933640660251706827635283081`

A later public-entry Firefox build is `0.10.2-local.59163505989340352848318128210965140998`. All are under ignored `local_artifacts/`; the second build's Android Gradle assembly completed in 20 seconds. Private source copies were removed after build; no source patch archive was retained. Root tests use genuine local WebRTC handshakes, not live Google Drive or public-store integration. Mocked release tests do not prove live publication or device updates.

## Remaining gaps and recommended next steps

1. **Release owner:** reconcile deleted/failed official reservations, full Android installed/submitted codes and public production certificate identity. Fill the deliberately unset production metadata only with verified evidence; assess outstanding store versions before enabling the four-field browser mapping. Never generate/rotate a key to bypass the blocker.
2. **Repository owner:** verify branch/tag rulesets, trusted reviewed main source, non-bypassable approvals/eligible refs for `release-signing` and `release-publication`, and secret placement. Review generated notes/manifest/hash plan before approving publication.
3. **Release maintainer:** validate existing-publication no-op and same-plan partial-draft resume with controlled API timeout/failure cases; conflicting draft or official bytes must continue to fail for audited incident handling. Artifact attempts are propagated from reservation outputs so failed-job retries can find prior successful build artifacts.
4. **Application maintainers:** establish and exercise a complete recoverable backup/restore procedure, including attachments and relevant relationships/settings; resolve existing peer authentication/receiver-write authorization limitations using the existing security plan. This task intentionally preserves application/data behavior.
5. **Maintainers, after explicit remote authorization:** execute CI, beta failure/retry/concurrency, stable staging/publication/notes, upload-timeout and immutable retry cases in a controlled repository. Verify device install/update/data preservation for every update edge before promising compatibility. Then record live evidence and revise adoption status.
6. **Store owners:** deliver verified completed artifacts manually only when authorized; retain input/output hashes, signing identities and submission/approval receipts. Keep store outcomes independent from GitHub release success.

Implemented local changes and simulations are distinct from these pending owner decisions and remote acceptance work. No full GitHub release validation or complete standards compliance is claimed.
