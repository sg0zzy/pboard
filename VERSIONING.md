# Repository Versioning & Release Contract

**Policy version:** 1.0  
**Status:** Normative  
**Applies to:** all project repositories, build scripts, CI workflows, packaging and coding agents.

## 1. Goals and terminology

- **Release version:** the public, stable version of a product, e.g. `0.9.7`.
- **Development version:** a SemVer pre-release, e.g. `0.9.6-dev.27`.
- **Build instance:** one execution of a build, identified by a unique **build ID** even if no file or commit has changed.
- **Git revision:** the full commit SHA (and whether the worktree was modified).
- **Official artifact:** a distributable produced by the release workflow from an immutable release tag.

**Invariants:** no build overwrites an archived artifact; each artifact can be traced to its inputs; public releases come from clean, tagged commits; release notes cover all changes since the previous *published stable release*; platform-native version fields preserve supported upgrade ordering.

## 2. Version syntax and precedence

1. Use [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH[-PRERELEASE][+METADATA]`.
2. Stable releases are `X.Y.Z`. Development builds are `X.Y.Z-dev.N`, with `N` a positive integer and no leading zeroes.
3. Build metadata, e.g. `+g8a7b21c.dirty`, may be displayed for diagnostics; it **does not affect SemVer precedence**. Never use it as the only mechanism for choosing an upgrade.
4. `X.Y.Z-dev.N` precedes `X.Y.Z`; `-dev.2` precedes `-dev.10`. A development build begun **after** stable `X.Y.Z` must use a *higher core version* than `X.Y.Z`.
5. There is **no even/odd rule** and no requirement to release a version that was used for development. Development version cores may be skipped. Example:
   `0.9.4` (published) → `0.9.5-dev.1` → `0.9.5-dev.2` → `0.9.6-dev.1` → `0.9.7` (published).
6. A release MAY use the same core as the latest development version (e.g. `0.9.6-dev.27` → `0.9.6`) or a higher core (e.g. → `0.9.7`). The decision is explicit; agents must **not assume** that every release increments PATCH or that a development core will be released.
7. The meanings of MAJOR/MINOR/PATCH follow SemVer where a public compatibility contract/API exists. For applications without a public API, document the user-visible compatibility policy (data formats, saved settings, CLI/protocols, integrations). Before `1.0.0`, incompatible changes may occur in MINOR, as allowed by SemVer.
8. Never reuse a *published stable release version* or move/recreate an existing published release tag. Never decrease the development core relative to any version already distributed to testers on the same update channel.

## 3. Sources of truth

- A single machine-readable project version file (for example `VERSION`, `version.json`, `package.json` or an equivalent project-native setting) is the **source of truth for the intended core version and development status**. Do not manually maintain conflicting version strings across components.
- The build system supplies `N` and the build identity; `N` is **not** embedded by an auto-modifying source commit on each local compilation.
- Git is the source of truth for code identity (full SHA, tag, dirty state).
- Release tags are `vX.Y.Z` and must refer to the commit from which the official distribution was built. Annotated tags are preferred.
- Packaging metadata (`versionName`, `versionCode`, assembly versions, package versions, etc.) must be derived from the source version plus the documented platform adapter, rather than edited independently.

## 4. Local builds

1. Local development builds MUST work with uncommitted changes. No commit is required just to test a change.
2. Each invocation creates a **new build ID**, even when source and commit are unchanged. A practical default is a UTC timestamp with subsecond precision plus a collision-safe suffix; an atomic local counter is also allowed.
3. When a single workstation has an exclusively local sequential development counter, it may advance `dev.N` for each build. Across workstations/CI, `N` MUST be coordinated if it is intended to be a globally unique, monotonically increasing version; otherwise use distinct build IDs and **do not claim global uniqueness of `dev.N`**.
4. Persist local counter state **outside tracked files** (for example under a gitignored `.build-state/` directory); use atomic locking/increment to avoid concurrency collisions. Reset `N` when the selected development core changes. Do not auto-commit a version bump for every compilation.
5. Any dirty build MUST carry `dirty=true` and its commit SHA. Also preserve a patch/diff snapshot or a content digest of the actual inputs: SHA + `dirty` alone cannot reconstruct source. Protect that snapshot if it could contain secrets.
6. Save every artifact under a unique, versioned directory, e.g. `dist/dev/0.9.6-dev.27/<build-id>/`. The artifact's filename may include platform and architecture. Never overwrite an existing path; fail on collision.
7. Every archived build directory MUST contain a machine-readable `build-manifest.json`, including: product; version; build ID; UTC time; commit SHA; dirty flag; source diff/content digest (if dirty); target platform/architecture; build toolchain version; output filename(s) and SHA-256 checksum(s). Include dependency lockfile/checksum where practical.
8. `dist/` and local build state are gitignored. A command to explicitly clean old local outputs may be provided but MUST NOT run implicitly during builds/releases.

## 5. Version transitions

- A development version bump (patch/minor/major or an explicitly chosen target core) changes the intended core version, resets its **local** `dev.N` counter and creates no release tag. Agents MUST NOT make bumps merely to allow a compilation.
- Stable releases are **explicit operations**. A release request must specify or confirm the exact target `X.Y.Z`. `release patch/minor/major` helpers are convenience operations, not hard-coded requirements to publish the immediately next development core.
- The release version MUST be strictly greater, by SemVer precedence, than the last stable release and must be suitable for supported platform upgrade ordering.
- On a normal stable release, remove `-dev.N` from the published display version. A stable release MUST never contain the dirty marker.
- Post-release development MUST select a core greater than the newly published stable version before creating further development builds. Development numbering starts again at `dev.1` for the new core.

## 6. Release pipeline and artifact integrity

1. Require a clean Git worktree, passing checks, an exact target version and no conflicting existing `vX.Y.Z` tag.
2. Update the canonical version file as needed, commit the change, and create the annotated stable tag **on that commit**. CI validates tag, version file and commit consistency; CI MUST fail on disagreement.
3. Build all supported distribution targets from the **same tag/commit** (including independently built platform binaries). Record their target-specific toolchains and checksums.
4. Publish **the same CI outputs** to GitHub Releases and any downstream distribution destinations. Do not silently rebuild while publishing. A rebuild is a new artifact with a separate traceable build ID, not an overwrite.
5. Published stable artifacts and tags are immutable. If a release is defective, publish a new version instead of replacing the old binaries under the same identity. Draft releases may be prepared before publication, but once publicly distributed the immutability rule applies.
6. On failure, do not pretend a tag or publication succeeded. Any partial publication must be identified and reconciled explicitly. Pushing tags, publishing releases, uploading store packages, and triggering deployment are distinct auditable actions.
7. The release job should verify reproducibility where practical; same commit does **not** guarantee byte-identical binaries without pinned toolchains, inputs and deterministic build settings.

## 7. Changelog and release notes

- Generate release notes from the **previous published stable release tag** to the current stable release tag (e.g. `git log v0.9.4..v0.9.7`), including intervening development phases and skipped version numbers.
- Development builds, local build IDs and untapped intermediate versions do not reset the changelog range.
- If a previous stable release has never existed, compare with the repository history/root or a documented baseline.
- Automated commit lists are a starting point, **not sufficient final release notes**. Curate user-visible additions, fixes, compatibility/migration notes, breaking changes and known issues. Use PR titles/labels or Conventional Commits if available, but do not invent unsupported claims.
- If multiple maintenance lines exist, use the previous stable release on the *same lineage* and document cherry-picks and backports; do not blindly choose the globally latest tag.

## 8. Platform adapters and update monotonicity

### Android

- `versionName` is the human-readable version; `versionCode` is a nonnegative integer with platform/store constraints. Google Play requires newly published APK/AAB `versionCode` values to increase over previous versions and sets a maximum of **2,100,000,000**.
- Do not assume SemVer suffixes, PATCH parity or a dotted version automatically produce valid Android upgrade ordering. Implement and test an explicit `versionCode` mapping.
- Recommended bounded scheme **if numbers fit**: reserve a numeric range per core version. For example, with `0 <= major <= 20`, `0 <= minor <= 99`, `0 <= patch <= 999`, compute `core = major*100000 + minor*1000 + patch`, then `versionCode = core*1000 + slot`. Dev slots `1..998`; stable slot `999`. Check the Google Play cap before use and reserve any extra channels deliberately. This ensures the stable version is newer than preceding dev builds of its own core and later cores sort higher. If `dev.N` may exceed 998, advance core, change the documented allocation, or use a centrally managed monotonic allocator **before distributing**, never wrap/truncate silently.
- Different machines can allocate the same dev slot if not coordinated. CI/public beta channels MUST use a coordinated allocation or separate package IDs/channels. For tests intended to upgrade in place, verify package ID, signing key, `versionCode`, and store/channel compatibility. Release signing credentials must never be present in untrusted development jobs.
- Treat Play's global used-code history as authoritative: even if a version was skipped or unpublished in GitHub Releases, do not reuse a `versionCode` already consumed by the Play distribution workflow.

### Other targets

- Windows/macOS/Linux/browser extensions may constrain accepted version syntax and numeric ranges. Provide documented adapters for each target; map the canonical version deterministically where possible and keep Git SHA/build ID in About/diagnostics or the manifest.
- Do not assume the same literal SemVer string is accepted unchanged by all package managers or stores.
- A single release version corresponds to a coherent set of outputs from the same source revision; target-specific package/build numbering may differ when required by platform rules.

## 9. Required behavior for coding agents

Agents and automations **MUST**:

1. Read this file before altering versioning, build scripts, packaging, CI, tags, release notes or publishing logic.
2. Preserve the canonical version source and use its derived values consistently on every platform.
3. Never bump versions, tag, publish or deploy incidentally during routine development work. Do these only when explicitly requested or when the task is specifically implementing a version transition.
4. Allow local development builds from dirty worktrees; identify them accurately and never label them stable.
5. Generate non-overwriting local artifacts and manifests. Detect filename, directory, counter and CI collisions rather than silently replacing outputs.
6. Fail closed on version regressions, invalid SemVer, existing tag conflicts, Android `versionCode` regressions or packaging incompatibility.
7. Never amend or move published stable tags; propose a new release instead.
8. Generate release notes from the appropriate previous stable tag, including skipped development version cores.
9. Keep publish/deploy operations clearly separate from build/test steps, with explicit authorization for externally visible operations.
10. Prefer small changes, tests and clear documentation. If a repository cannot satisfy part of this contract, document the exception and its risks instead of quietly ignoring it.

## 10. Suggested commands (interface, not mandatory implementation)

```text
./build.sh dev                   # Unique non-overwriting local build; dirty allowed
./build.sh test                  # Run checks without a version bump
./version.sh bump patch          # Select the next development core; no release
./version.sh set 0.9.6-dev      # Explicitly select a development core
./release.sh prepare 0.9.7      # Validate, update version, commit and tag locally
./release.sh publish 0.9.7      # Explicitly push/tag and start official CI publication
```

Treat command names as illustrative. When these commands are added to a repository, document their actual behavior, prerequisites, dry-run mode and authorization boundaries. The `prepare` step MUST NOT silently trigger a public release.

## 11. Conformance checks / examples

- `0.9.4` → `0.9.5-dev.1` → `0.9.6-dev.1` → stable `0.9.7`: **valid**.
- `0.9.6-dev.27` → stable `0.9.6`: **valid** (release is later than its prerelease).
- `0.9.7` stable → `0.9.7-dev.1`: **invalid** as a new development release on the same update line (it sorts earlier).
- Two local builds of the same dirty commit: **both valid**, provided they have different build IDs and output paths, and source identity is retained.
- Same `dev.N` generated on two machines: **not globally unique** unless centrally allocated; build IDs distinguish artifacts, but Android upgrade order must be handled separately.
- Moving `v0.9.7` to a different commit or silently replacing its published `.apk`: **forbidden**.
- Changelog for stable `0.9.7` when previous stable is `0.9.4`: **compare `v0.9.4..v0.9.7`**, not dev versions.

---

**References:** [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html); [Android app versioning](https://developer.android.com/studio/publish/versioning).  
**Local project exceptions:** record them in the repository's `README.md` or a dedicated `docs/versioning-exceptions.md` with an explicit rationale; do not modify this shared contract ad hoc.
