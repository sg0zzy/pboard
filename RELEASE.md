# Pboard release operations

This guide covers preparing a stable release, requesting a beta, reviewing the
workflow outputs and recovering a failed attempt. Both channels publish the same
required packages to GitHub; delivery to browser stores is a separate operation.

The central contracts pinned in [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md)
govern allocation, publication, security and distribution. [VERSIONING.md](VERSIONING.md)
defines version selection and platform mappings; [BUILD.md](BUILD.md) defines the
toolchain and package checks. The executable configuration is
[project-standards.json](project-standards.json).

## Process overview

| Stage | Stable | Beta |
| --- | --- | --- |
| Select source/version | Review the intended commit and explicitly choose `X.Y.Z` | Choose a reviewed remote branch/SHA and development core `X.Y.Z` |
| Prepare/reserve | `prepare --apply` validates, commits metadata if needed and creates local annotated `vX.Y.Z` | `allocate --apply` dispatches the workflow, which reserves remote annotated `vX.Y.Z-dev.N` |
| Start remote release | `publish --apply` atomically pushes current `main` and the exact stable tag | The dispatched workflow continues with the reserved source |
| Build and sign | Required targets build from the tagged SHA; Android signing uses `release-signing` | Same required targets and protected signing gate |
| Review and publish | Review the staged plan, then approve `release-publication`; publish as latest stable | Review the staged plan, then approve `release-publication`; publish as prerelease, never latest stable |
| Deliver externally | Separate authorized manual AMO/Chrome Web Store operation | Store delivery disabled |

Both workflows use `official-release-lifecycle` to coordinate reservation,
building, staging and publication. Every new official version must exceed all
previous official reservations and publications, including failed or abandoned
attempts. Reserving a higher beta core can therefore prevent a later stable
release on a lower core. A tag permanently consumes its version; completion
requires the verified packages and a visible GitHub Release.

## Readiness

**Official releases are currently blocked.** The release owner must complete
the existing-history and production-signer records before preparation/allocation
can pass. Run the local configuration preflight from the repository root:

```sh
node scripts/release-control.mjs preflight
```

It reports the first configuration blocker; passing it does not establish remote
protections, complete the history review or prove publication readiness. Record
readiness evidence and remaining gaps in
[STANDARDS_MIGRATION_REPORT.md](STANDARDS_MIGRATION_REPORT.md).

All three official targets remain mandatory: Firefox ZIP, Chromium ZIP and
release-signed Android APK, plus reviewer sources, release manifest and SHA-256
checksums. Missing signing credentials or a failed target blocks completion.

Every release automatically inventories paginated remote Git tags and GitHub Releases (including drafts), plus durable reservations and all recorded alias versions in `project-standards.json`. API failures, unknown records, collisions and ordering violations fail closed. Inspect current evidence without release mutations with `node scripts/release-control.mjs inventory`; `preflight` also enforces readiness.

`history.unresolved` lists concrete migration gaps that current APIs cannot resolve, such as deleted reservations without durable evidence. Reconcile each gap once using reliable historical records, persist aliases/tombstones, and remove only resolved entries with evidence recorded in `STANDARDS_MIGRATION_REPORT.md`. An empty list permits routine automated validation; no per-release manual history approval is required. Missing migration configuration fails closed. The obsolete `history.reviewed` flag has no authority. A complete current API response does not prove the absence of deleted identities. Recorded alias versions remain reserved even when their remote names disappear, and aliases cannot redefine canonical versions.

Android allocated/submitted/distributed codes and production signing identity remain separately required. Keep durable tombstones when reservations might disappear remotely. Owner review must establish branch/tag protection, trusted workflow/build/dependency review, and actual protected `release-signing` and `release-publication` environments with eligible refs/reviewers. Environment names in YAML do not establish these settings.

## Shell commands

Use Node 24.15.0 or newer in the 24 series, npm, Git and Bash, plus an authenticated
GitHub CLI (`gh`) for remote reads and release initiation. Stable preparation
also needs the Android toolchain and installed root/Android dependencies listed
in [BUILD.md](BUILD.md#prerequisites-and-targets).

The `scripts/*.sh` wrappers resolve their checkout independently of the working
directory; use an absolute path to the wrapper when outside the repository.
Examples below assume the repository root. Existing source work must be
reviewed/committed before stable preparation, including relevant untracked files.
No script changes branches or worktrees. `publish` requires the current branch
to be `main`; `origin` must match the configured GitHub repository.

Use these commands to inspect or select the development core before releasing:

```sh
scripts/version.sh show
scripts/version.sh bump patch --dry-run  # preview the next development core
scripts/version.sh bump patch            # or: minor / major
scripts/version.sh set 0.11.0-dev         # explicit development core
scripts/version.sh --check
```

Bumps synchronize VERSION and all generated mirrors without committing, tagging
or building. Major/minor bumps reset subordinate fields. Invalid/regressing
cores and platform overflow fail before editing; a sync failure restores the
original metadata. Tracked Android versionCode stays unchanged for development
selection. Known local tags and durable reservations establish a floor;
these local commands do not claim to inventory unseen remote history.

## Stable preparation and tagging

Select the stable version with an explicit argument or use the core already
selected in `VERSION`. When the argument is omitted, `release.sh` reads this
checkout's `VERSION`: `X.Y.Z` and `X.Y.Z-dev` both select stable `X.Y.Z`, without
bumping it. The plan shows the resolved version before any changes. An explicit
argument takes precedence. The versions below are examples, not a declaration
that `0.10.3` is available. New release subcommands default to a nonmutating plan;
add `--apply` to execute the stated operation.

1. Complete the readiness review and review/commit the intended source. Confirm
   that the selected version is greater than every existing official reservation.
2. Preview preparation, then apply it to run the required checks and create the
   local release commit/tag. Inspect the resulting metadata, commit and tag.
3. Preview publication. With explicit authorization for the remote operation,
   apply it from current `main` at the tagged commit.
4. Monitor **Stable Release** in [release.yml](.github/workflows/release.yml).
   Complete signing approval and the [publication review](#publication-review-and-completion).

```sh
scripts/release.sh prepare --dry-run       # use the core from VERSION
scripts/release.sh publish --dry-run       # use the core from VERSION
scripts/release.sh prepare 0.10.3 --dry-run
scripts/release.sh prepare 0.10.3 --apply    # validate, sync, version commit if needed, annotated local tag
scripts/release.sh publish 0.10.3 --dry-run
scripts/release.sh publish 0.10.3 --apply    # atomic push of main + this exact tag; starts Stable Release
```

Plans list metadata/checks/commit/tag/remote actions. They perform no remote
calls or source/index/ref changes and are not eligibility checks. Apply requires
a clean intended tree, resolved migration gaps and signing readiness, full remote and local reservation
checks, and valid platform mappings. Preparation runs the existing root and
Android validation/build gates; there is no skip-checks override. It commits only
version metadata when needed and creates an immutable annotated `vX.Y.Z` tag on
the resulting commit. An already committed matching version needs no redundant
commit. It does not push.

`publish` requires the current `main` HEAD to match the annotated tag and VERSION
mirrors. It revalidates remote history immediately before an atomic branch/tag
push; it never forces refs, includes unrelated tags, or falls back to separate
pushes. The GitHub workflow rechecks history/source under the shared beta/stable
lifecycle before building or publishing. The existing server controls remain
mandatory. A tag is a reservation, not evidence of successful publication.

If metadata validation fails, the existing preparation transaction restores its
original metadata. If the later commit/tag phase fails, the script preserves and
reports a resumable metadata/commit checkpoint rather than resetting user work.
Review and commit pending metadata if needed, then resume without another version
commit using:

```sh
scripts/release.sh tag 0.10.3 --dry-run
scripts/release.sh tag 0.10.3 --apply        # full validation of already committed metadata, local tag only
```

Existing tags are never replaced/deleted. An identical remote tag is a no-op;
inspect/rerun its existing stable workflow. A conflicting tag blocks publication.
If a push has an uncertain result, inspect remote refs/workflows before retrying.
The old `scripts/release.sh [X.Y.Z] --dry-run|--apply` form remains available for
metadata-only preparation and still never commits or tags. Omitting its version
also uses the core from `VERSION`. Invoking `release.sh` without arguments shows
help.

## Beta release and retry

1. Complete the readiness review. Select reviewed committed source already
   available remotely and a development core that passes the global version floor.
2. Optionally run `next` to preview the next beta identity. It reads remote state
   and does not reserve that identity.
3. Preview `allocate`. With explicit authorization to dispatch **Beta Release**,
   apply it and monitor [beta-release.yml](.github/workflows/beta-release.yml).
4. Complete signing approval and the [publication review](#publication-review-and-completion).
   Use `retry` only to resume the exact existing beta reservation/source.

```sh
scripts/beta-version.sh next 0.10.3             # read-only remote preview; not a reservation
scripts/beta-version.sh allocate main 0.10.3 --dry-run
scripts/beta-version.sh allocate main 0.10.3 --apply
scripts/beta-version.sh retry v0.10.3-dev.1 --dry-run
scripts/beta-version.sh retry v0.10.3-dev.1 --apply
```

The core can be omitted when VERSION selects `X.Y.Z-dev`; `allocate` defaults to
`main`. `next` requires resolved migration gaps and signing readiness, and checks all remote tags,
releases and durable records plus known local reservations. Its result may be
superseded before allocation. It edits no source/refs and consumes no number.

`allocate --apply` uses the [GitHub CLI workflow dispatch](https://cli.github.com/manual/gh_workflow_run)
entry point: it resolves a branch/commit once to a full remote SHA and dispatches
`beta-release.yml` from trusted `main`. It does not allocate/push a beta tag
locally. The existing workflow validates trusted-main ancestry and source/config,
checks complete high-water history, and reserves an annotated `vX.Y.Z-dev.N` tag
under `official-release-lifecycle` before packaging. Both beta and stable use
that shared lifecycle. Token-created beta tags continue packaging within the
same workflow; no second tag-trigger run is assumed.

`retry --apply` preserves the existing beta tag selector and derives its original
core so the workflow retries that reservation/source. Changed source requires a
greater version. A dispatch receipt is not publication success: monitor the run
and its protected signing/publication approvals. If dispatch times out, inspect
existing runs before retrying to avoid a second fresh allocation. Beta outputs
use `prerelease: true` and `make_latest: false`; stores remain manual/disabled.

Invoking `publish --apply` or `allocate/retry --apply` explicitly requests its
stated remote operation. Merely adding these scripts grants an agent no standing
permission to run those commands, activate signing, publish or deliver to stores.

## Publication review and completion

After either channel starts, follow the run through these checkpoints:

1. Confirm the recorded channel, version, tag and full source SHA match the
   intended release. A dispatch receipt or pushed tag alone does not mean success.
2. Review the `release-signing` job and its approval, where configured. All
   required builds and final Android signature verification must succeed.
3. Download `release-plan-<run_id>-<attempt>` from the workflow run after staging.
   Review `release-notes.md`, `release-manifest.json` and `SHA256SUMS.txt` for the
   source/version, required target results, package identities and complete notes.
4. Approve `release-publication` only after that review. If the notes or identities
   are inadequate, hold approval and repair the plan process; the publisher
   requires the reviewed plan to match its regenerated bytes.
5. Confirm the workflow succeeded and the GitHub Release is visible with all three
   required packages, Firefox reviewer sources, `release-manifest.json` and
   `SHA256SUMS.txt`. Check the channel: beta is a prerelease with `make_latest: false`;
   stable is published with `prerelease: false` and `make_latest: true`.

Keep the tag/SHA, run/attempt, manifest and asset hashes as release evidence.
Report any manual store submission separately as pending, failed or confirmed
available. Temporary Actions artifacts alone do not establish a completed release.

## Build and publication gates

`build-targets.yml` builds each official target with read-only permissions from the resolved SHA and uploads temporary manifests/packages. Browser packages use the numeric mapping in [VERSIONING.md](VERSIONING.md). Firefox reviewer sources contain the complete committed tree; private environment files are not included. Signing is a separate protected job using trusted control code, not selected-source executables.

An unprivileged stage job prepares a downloadable release plan with complete notes, manifests and checksum identities before protected publication approval. Review that plan in the `release-publication` environment; the publisher requires identical regenerated plan bytes, failing if the stable baseline or other inputs changed. The protected publisher downloads verified artifacts, checks source/configuration, target outcomes, filenames, sizes, transport hashes and Android signer. It creates a draft, attaches packages plus `release-manifest.json` and `SHA256SUMS.txt`, downloads every uploaded asset to verify bytes, rechecks publication ordering, then makes the draft visible. A missing required target/asset or invalid signature blocks publication. Build and publication records are retained as Actions evidence for 90 days; immutable remote tags remain durable reservations. Completed Release manifests retain source/config/standards/run/package evidence.

Stable notes use the previous **successfully published stable** from the API at publication time, not the newest tag or beta. First-stable notes include all reachable history, including the root commit. A divergent stable baseline fails for human reconciliation. Commit-range evidence and all commit subjects, including merges are retained without a 100-commit truncation. Generated notes require human review for meaningful grouping, cherry-pick duplication, omissions and sensitive/internal text in the release-plan artifact before environment approval. Hold approval and repair/review the plan process if notes are inadequate.

## Signing and platform identities

- Firefox ID: `project-board@local.invalid`. Official ZIP is an unsigned **upload archive**, with license/notices and matching reviewer sources. It is not an installable signed XPI. AMO listed signing/publication remains manual; credentials `AMO_API_KEY` / `AMO_API_SECRET` are not passed into builds. A separate authorized AMO operation must verify returned signed output, keep its hash/receipt and distinguish submission/review from public availability. Unlisted signing is also external transfer and needs authorization.
- Chromium: unsigned **store-upload ZIP**, not CRX. Existing OAuth client IDs remain unchanged. The owner must verify the actual Chrome Web Store extension ID against `manifest.chromium.json` and `src/sync/googleDriveConfig.ts`; see [submission details](BUILD.md#chrome-web-store-submission). No private CRX signing key is configured or generated.
- Android ID: `it.stefanogozzi.pboard`, API 33+, compile/target 36. `release-signing` requires references `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`; the expected public certificate SHA-256 and highest historical/submitted code belong in `project-standards.json`. `scripts/sign-android.mjs` aligns/signs/verifies the final APK and certificate plus package version/code. There is no debug/unsigned fallback. These references do not create or rotate any key.
- Existing Android encoded codes are retained within documented bounds. No GitHub↔Play or beta/stable update edge is promised until production certificates, existing installs, numeric history and device data-preservation checks have been verified. Local debug uses the production app ID for compatibility with existing development installs and the tracked code without allocating production codes. A different signer or code can block updates: use a dedicated emulator/test profile, back up valuable data, and never treat uninstalling as upgrade evidence. No AAB/Play signing profile is configured.

## Distribution

| Destination / platform | Beta | Stable | Package, required evidence and retry identity |
| --- | --- | --- | --- |
| GitHub / declared targets | manual workflow initiation | authorized annotated tag push | Completed staged manifest/checksum/signature gates; tag + SHA + asset hashes; GitHub visibility verified |
| AMO / Firefox | disabled | manual | Verified Firefox upload ZIP + reviewer source; human signing/upload; record numeric version, input/output hashes, submission ID and actual review/publication state |
| Chrome Web Store / Chromium | disabled | manual | Verified Chromium ZIP; human dashboard upload; extension ID + native version + SHA-256 + receipt; review is pending until confirmed live |
| Google Play / Android | disabled | disabled | No configured AAB or credentials; no upload |
| Pages / documentation | no release delivery | manual, separately authorized repository Pages setup | Existing `docs/` branch-hosting instructions in README; not an application-bundle build/deploy target |
| Other destinations | disabled | disabled | No implicit delivery |

Manual store delivery consumes completed verified artifacts; do not rebuild from main. Signing/store transformations require recorded input/output hashes and version/receipt. Reconcile destination state before retries, and preserve a successful GitHub release if store delivery fails. The detailed Chrome listing, permissions and reviewer instructions remain in BUILD.md. No standing external automation authority is introduced.

## Failure and recovery

Failed packages leave the reservation consumed. For a transient stable failure, rerun the same trusted tagged workflow with the same source/config; source corrections need a greater version. For an exact beta retry, dispatch with the reserved tag as `ref` and its original `core`. A normal branch dispatch allocates a fresh greater reservation. A superseded reservation fails the forward gate. No tag may move.

A matching published tag is verified against its existing manifest and every asset hash and returns success without rebuilding or writing. Draft retries verify existing bytes and upload only missing identical-plan assets; conflicting/incomplete assets fail for explicit reconciliation. No `--clobber` or automatic asset replacement is used. If an API times out, inspect actual draft/public state, tag/SHA and byte hashes first. Conflicting bytes require incident review rather than overwriting. Required live remote acceptance/retry tests remain pending in the migration report.
