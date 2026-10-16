# Pboard release operations

The central contracts pinned in [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md) govern allocation, publication, security and distribution. Project implementation is in `project-standards.json` and `.github/workflows/`.

## Readiness

Official publication is deliberately blocked until the release owner fills and reviews the existing-history and production-signer records. Run `node scripts/release-control.mjs preflight` to see the first blocker. This migration does not create credentials or declare unverified signing identities. All three official targets remain mandatory: Firefox ZIP, Chromium ZIP and release-signed Android APK, plus reviewer sources, release manifest and SHA-256 checksums.

Before activation, inventory complete remote tags/releases, historical aliases, deleted/abandoned identities and all Android allocated/submitted/distributed codes. Record reconciled aliases/tombstones in `project-standards.json`; set `history.reviewed` only when complete. Keep durable tombstones there when reservations might disappear remotely. Owner review must establish branch/tag protection, trusted workflow/build/dependency review, and actual protected `release-signing` and `release-publication` environments with eligible refs/reviewers. Environment names in YAML do not establish these settings.

## Shell commands

Use Node 24, Git, Bash and an authenticated GitHub CLI (`gh`). Run commands from
any directory; the scripts resolve this checkout. Existing source work must be
reviewed/committed before stable preparation. No script changes branches or
worktrees. `origin` must match the configured GitHub repository.

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

Select the exact stable version explicitly. New release subcommands default to a
nonmutating plan; add `--apply` to execute the stated operation.

```sh
scripts/release.sh prepare 0.10.3 --dry-run
scripts/release.sh prepare 0.10.3 --apply    # validate, sync, version commit if needed, annotated local tag
scripts/release.sh publish 0.10.3 --dry-run
scripts/release.sh publish 0.10.3 --apply    # atomic push of main + this exact tag; starts Stable Release
```

Plans list metadata/checks/commit/tag/remote actions. They perform no remote
calls or source/index/ref changes and are not eligibility checks. Apply requires
a clean intended tree, reviewed history/signing, full remote and local reservation
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
The old `scripts/release.sh X.Y.Z --dry-run|--apply` form remains available for
metadata-only preparation and still never commits or tags.

## Beta release and retry

```sh
scripts/beta-version.sh next 0.10.3             # read-only remote preview; not a reservation
scripts/beta-version.sh allocate main 0.10.3 --dry-run
scripts/beta-version.sh allocate main 0.10.3 --apply
scripts/beta-version.sh retry v0.10.3-dev.1 --dry-run
scripts/beta-version.sh retry v0.10.3-dev.1 --apply
```

The core can be omitted when VERSION selects `X.Y.Z-dev`; `allocate` defaults to
`main`. `next` requires reviewed history/signing and checks all remote tags,
releases and durable records plus known local reservations. Its result may be
superseded before allocation. It edits no source/refs and consumes no number.

`allocate --apply` uses the [GitHub CLI workflow dispatch](https://cli.github.com/manual/gh_workflow_run)
entry point: it resolves a branch/commit once to a full remote SHA and dispatches
`beta-release.yml` from trusted `main`. It does not allocate/push a beta tag
locally. The existing workflow validates trusted-main ancestry and source/config,
checks complete high-water history, and reserves an annotated `X.Y.Z-dev.N` tag
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
