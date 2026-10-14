# Releasing Pboard

Automated release flow: `VERSION` file → `scripts/prepare-build.sh` (bump, sync, build all targets) → test locally → commit and push → `scripts/release.sh` (tag + notes) → GitHub Actions submits Firefox to AMO and publishes the GitHub Release.

## How VERSION works

`VERSION` is the single source of truth (e.g. `0.10.1`, format `MAJOR.MINOR.PATCH`). `scripts/sync-version.mjs` applies it to:

- `manifest.json` (Firefox) and `manifest.chromium.json` (Chromium)
- `package.json` and `package-lock.json` (root npm, via `npm`-compatible plain edit)
- `apps/android/package.json` (Android npm workspace)
- `apps/android/android/app/build.gradle` → `versionName "VERSION"` and a **monotonically increasing** `versionCode` (bumped by 1 per sync; never reset)
- `tests/releaseMetadata.test.ts` (the version assertion)

Check without writing: `node scripts/sync-version.mjs --check` (exit 1 + file list when out of sync). The AMO workflow independently re-verifies tag ↔ manifest version and the Gecko ID (`scripts/verify-release-tag.mjs`) before building.

## Prepare a build

```sh
./scripts/prepare-build.sh            # patch bump (default)
./scripts/prepare-build.sh --minor    # 0.10.1 → 0.11.0
./scripts/prepare-build.sh --major    # 0.10.1 → 1.0.0
./scripts/prepare-build.sh --no-bump  # same version again (retry after a failed build)
```

The script: refuses to bump when version files already have uncommitted changes (avoids double bumps), runs `npm ci` if needed, then typecheck + tests, builds Firefox, runs `web-ext lint --warnings-as-errors` against the real output, byte-verifies the Firefox package, builds Chromium, packages and byte-verifies it, then the Android workspace (typecheck, tests, `cap sync`, `gradlew assembleDebug`). Never commits, pushes, tags, or publishes.

## Artifacts (test these)

| Target | Path |
|---|---|
| Firefox | `web-ext-artifacts/pboard-<version>.zip` (unsigned, byte-compared to `dist/`) |
| Chromium | `web-ext-artifacts/pboard-chromium-<version>.zip` (unsigned) |
| Android | `apps/android/android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed) and a copy `web-ext-artifacts/Pboard-<version>-debug.apk` |

Local testing pointers: Firefox `about:debugging` → Load Temporary Add-on → `dist/manifest.json`; Chromium `chrome://extensions` → Load unpacked → `dist/chromium/`; Android install the debug APK on a device (`adb install web-ext-artifacts/Pboard-<version>-debug.apk`). Generated artifacts stay out of Git (`.gitignore` covers `web-ext-artifacts/*.zip`, `dist/`, Android `build/`).

## Commit and push manually

```sh
git add -A
git commit -m "Release 0.10.1"   # or your own message
git push origin main             # CI must go green first
```

## Run the release script

```sh
./scripts/release.sh
```

It fails fast (actionable error, nonzero exit) unless: version refs match `VERSION`, tracked tree is clean, branch is `main`, local `main` == `origin/main` (it never pushes `main`), tag `v<VERSION>` exists neither locally nor on origin. It then:

1. finds the previous release tag by ancestry (`git tag --merged HEAD`, `sort -V`; handles the first release by ranging from the root commit),
2. builds notes from commit subjects in `prevTag..HEAD` (non-merge commits plus merge subjects, deduplicated by subject),
3. writes and displays `web-ext-artifacts/release-notes-v<version>.md`,
4. asks for explicit confirmation,
5. creates the annotated tag `v<VERSION>` with the notes as tag message,
6. pushes **only that tag** (never `main`, never `--force`), triggering the AMO workflow.

If the tag push fails, the tag already exists locally — retry `git push origin refs/tags/v<version>` manually.

## How GitHub Actions publishes to AMO

The pushed tag triggers `.github/workflows/release.yml` (concurrency-controlled per tag; a normal `main` push never publishes):

1. **validate** (`contents: read`): re-checks tag ↔ manifest version + Gecko ID, then typecheck, tests, Firefox build, strict lint, package byte-verification, reviewer-source archive, `web-ext sign --config web-ext-config.cjs --channel=listed --upload-source-code ... --no-input` using the `AMO_API_KEY`/`AMO_API_SECRET` secrets.
2. **github-release** (`contents: write`): runs only if the submission succeeded; reads the release notes **from the tag annotation** (`git tag --format='%(contents)'`) and attaches the unsigned build + source archive.

Android and Chromium are **not** published anywhere automatic. Submission success ≠ Mozilla approval; the listing updates only after review.

## How release notes are generated

Purely from Git history (`git log` subjects) — nothing invented, no AI, nothing omitted unless it's a duplicate subject. Merge commits: kept once; their merged commits appear as their own bullets; identical subjects deduplicated. The notes are reviewed locally before confirmation and stored in the tag annotation, not in any tracked file.

## Recovering from failures

| Failure | Action |
|---|---|
| Build fails in `prepare-build.sh` | Script stops with nonzero exit; rerun with `--no-bump` (same version, no double bump) |
| Dirty tree guards trip | Commit the version files, or use `--no-bump` to rebuild without bumping |
| `release.sh`: out-of-sync versions | Run `node scripts/sync-version.mjs`, commit, continue |
| Tag exists / AMO already has version | Never re-tag or resubmit the same version; cut the next patch version; never delete or move a pushed tag |
| Tag push failed | Tag exists locally; `git push origin refs/tags/v<version>` |
| AMO submission failed in Actions | Fix, push to `main`, re-run `prepare-build.sh --no-bump`, commit, `release.sh` with bumped `VERSION`; never force-push tags |
| GitHub-Release job failed after AMO submit | Re-run **only** the `Publish GitHub release` job (Re-run failed jobs); do not re-submit to AMO |
| Local main behind/diverged from origin | Script says which; `git pull --ff-only` / reconcile manually |

## Example release cycle

```sh
./scripts/prepare-build.sh              # 0.10.1 → 0.10.2, builds all three targets
# test Firefox/Chromium/Android artifacts
git add -A && git commit -m "Release 0.10.2" && git push origin main
# wait for CI green
./scripts/release.sh                    # review notes, confirm → tag v0.10.2 pushed
# watch https://github.com/sg0zzy/pboard/actions → AMO gets 0.10.2, GitHub Release appears
```

## Prerequisites

- Node 24 (`.nvmrc`), npm, JDK 21 + Android SDK for the APK, Git.
- GitHub secrets: `AMO_API_KEY`, `AMO_API_SECRET` (existing AMO pipeline; unchanged).