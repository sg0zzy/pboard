# Releasing Pboard for Firefox (AMO)

Releases are fully automated: pushing a tag `v*.*.*` builds the Firefox extension, validates it, submits it to the existing [addons.mozilla.org listing](https://addons.mozilla.org/firefox/addon/pboard/), and publishes a GitHub Release with the unsigned build and reviewer sources.

CI runs on every push to `main` and every pull request targeting `main` (typecheck, tests, Firefox build, `web-ext lint --warnings-as-errors`, package verification). It never contacts AMO.

## 1. Configure GitHub secrets (once)

1. Create at https://addons.mozilla.org/en-US/developers/addon/api/key/ — one key/secret pair for the Mozilla account that owns the Pboard listing.
2. In GitHub **Settings → Secrets and variables → Actions → Repository secrets**, add:
   - `AMO_API_KEY` — the API key (JWT issuer)
   - `AMO_API_SECRET` — the API secret (JWT secret)

Secrets are read only by `.github/workflows/release.yml`. They are never printed and never committed.

## 2. Prepare a release

Pick the next unused version following the tag format `vMAJOR.MINOR.PATCH` (e.g. `v0.9.6`). Then update, in the same commit:

- `package.json` → `version`
- `manifest.json` → `version` (Firefox)
- `manifest.chromium.json` → `version` (keep in step with Firefox)
- `tests/releaseMetadata.test.ts` → the hardcoded expected version

Commit to `main` and wait for the CI workflow to pass before tagging.

## 3. Synchronize the manifest version

The release workflow aborts before any AMO call when the tag does not match the Firefox manifest (see `scripts/verify-release-tag.mjs`):

- tag `v0.9.6` requires `manifest.json` `"version": "0.9.6"`
- the manifest's `browser_specific_settings.gecko.id` must remain `project-board@local.invalid` — this is the ID of the existing AMO listing and must never change

Check before tagging:

```sh
node scripts/verify-release-tag.mjs v0.9.6   # must pass; manifest.json must already say 0.9.6
```

## 4. Run the local tests

```sh
npm ci
npm run release:firefox
npm run lint:firefox   # includes --warnings-as-errors
npm run package:firefox
```

## 5. Create and push the annotated tag

```sh
git tag -a v0.9.6 -m "Pboard 0.9.6"
git push origin v0.9.6
```

The tag must be pushed by itself — never force-push or delete/re-push a tag, or you risk a duplicate AMO version.

## 6. Check the GitHub Actions result

In GitHub → **Actions → Firefox AMO release**, the run for the tag has two jobs:

1. **Validate tagged Firefox build** — typecheck, tests, production build, strict lint, package verification and byte-comparison against `dist/`, tag/version check, reviewer-source archive, then the AMO submission.
2. **Publish GitHub release** — only runs if the submission succeeded; attaches the unsigned ZIP and the source ZIP to the tag's GitHub Release.

The uploaded artifacts live on the workflow run page (name `firefox-release`) for inspection.

## 7. Check the new version on AMO

1. Open https://addons.mozilla.org/en-US/developers/addon/pboard/versions/ — the new version appears there immediately with status *Awaiting review*.
2. A successful submission does **not** mean Mozilla approved or publicly listed the version. Approval can take days; the version becomes public only after review.
3. Users see the update on AMO once the version is approved and listed.

## 8. Recovering from a failed submission

- **Validation failed** (typecheck, tests, lint, packaging): fix the problem, commit to `main`, then create a fresh tag on that commit. Never re-push the same tag.
- **AMO rejected the upload** (e.g. lint error at review): if the version never appeared in the AMO dashboard, fix and re-tag as a new patch version and delete nothing. If the version exists on AMO, resubmitting the same version is not possible — publish it as the next patch version (`v0.9.7`).
- **AMO accepted but the GitHub Release job failed**: do **not** rerun the AMO submission. Rerun only the `Publish GitHub release` job from the workflow run page (Re-run failed jobs). The artifacts and release are separate from the AMO upload.
- **Wrong tag pushed (typo)**: delete the tag only if its workflow failed *before* AMO submission; otherwise leave it and release the corrected version under a new tag.
- Never delete, re-push, or force-move a tag whose submission reached AMO.

## Local dry-run without publishing

```sh
npm run release:firefox && npm run lint:firefox && npm run package:firefox
git archive --format=zip --output=pboard-source.zip HEAD .nvmrc .env.example package.json package-lock.json tsconfig.json manifest.json manifest.chromium.json sidebar.html vite.sidebar.config.ts vite.background.config.ts vite.content.config.ts web-ext-config.cjs src scripts icons BUILD.md LICENSE.md README.md
```

This reproduces what the release workflow runs and archives; it does not call AMO.