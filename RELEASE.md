# Pboard release operations

The central contracts pinned in [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md) govern allocation, publication, security and distribution. Project implementation is in `project-standards.json` and `.github/workflows/`.

## Readiness

Official publication is deliberately blocked until the release owner fills and reviews the existing-history and production-signer records. Run `node scripts/release-control.mjs preflight` to see the first blocker. This migration does not create credentials or declare unverified signing identities. All three official targets remain mandatory: Firefox ZIP, Chromium ZIP and release-signed Android APK, plus reviewer sources, release manifest and SHA-256 checksums.

Before activation, inventory complete remote tags/releases, historical aliases, deleted/abandoned identities and all Android allocated/submitted/distributed codes. Record reconciled aliases/tombstones in `project-standards.json`; set `history.reviewed` only when complete. Keep durable tombstones there when reservations might disappear remotely. Owner review must establish branch/tag protection, trusted workflow/build/dependency review, and actual protected `release-signing` and `release-publication` environments with eligible refs/reviewers. Environment names in YAML do not establish these settings.

## Stable preparation

```sh
scripts/release.sh X.Y.Z --dry-run
scripts/release.sh X.Y.Z --apply
```

Dry-run displays intended metadata files, checks and the human commit/tag/push plan without changing source, refs, index or remotes. Apply requires a clean intended tree, reviewed history/signing, a greater explicitly selected version, root validation, Android tests and a managed debug APK build. It synchronizes metadata and restores original metadata on failure. It never commits, tags or pushes. Review the diff, test all local targets with `scripts/build_all.sh`, and prepare a dedicated reviewed release commit if metadata changed. An annotated `vX.Y.Z` must identify that commit; pushing it is a separate explicitly authorized human operation.

The stable tag workflow validates exact syntax, annotation, peeled SHA, committed VERSION, trusted main ancestry, configuration and full high-water inventory. Both entry workflows use `official-release-lifecycle` for their complete lifecycle. Remote create-only beta refs and high-water revalidation also protect against independently pushed stable reservations. Tag rulesets should prohibit deletion/replacement and bypass.

## Beta release

The **Beta Release** workflow is manually dispatched with `ref` (default `main`, reviewed branch/full committed SHA reachable from main, or an existing annotated beta tag for exact-source retry) and optional `core`. Without an explicit core, committed VERSION must select `X.Y.Z-dev`. It resolves source once, checks trust/configuration, inventories all remote official state and reviewed tombstones, allocates a globally forward `X.Y.Z-dev.N`, and creates an annotated immutable tag before packaging. Token-created tags continue packaging within the same workflow; no second tag-trigger run is assumed.

The beta release is `prerelease: true` with `make_latest: false`. Stable publication is `prerelease: false` with latest enabled. Neither channel delivers to stores.

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
