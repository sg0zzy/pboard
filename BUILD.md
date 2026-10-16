# Building Pboard

Policy authority: [DEVELOPMENT_STANDARDS.md](DEVELOPMENT_STANDARDS.md). This guide documents repository commands and packaging details; release operations are in [RELEASE.md](RELEASE.md).

## Prerequisites and targets

Node 24.15.0 or newer in the 24 series (`.nvmrc`: 24), npm, Git and a POSIX host are required. Use `npm ci` at the root. Firefox requires 142+, Chromium 114+ with Side Panel support. The managed builder currently supports Linux/macOS POSIX hosts; Windows users need WSL or equivalent. Unsupported native Windows shell invocation is not a configured host.

Android additionally needs `npm ci` in `apps/android`, JDK 21, `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) pointing to SDK platform 36 and build-tools with `aapt`, `zipalign`, `apksigner`; SDK platform-tools for explicit device installation. Minimum device API is 33. Existing Gradle/Capacitor dependencies and wrapper remain repository-owned.

| Target ID | Platform / architecture | Final package / profile | Local | CI | Beta | Stable |
| --- | --- | --- | --- | --- | --- | --- |
| firefox | Firefox / universal | unsigned store-upload ZIP; checksum-only | required* | required | required | required |
| chromium | Chromium / universal | unsigned store-upload ZIP; checksum-only | required* | required | required | required |
| android | Android / universal | test-only debug-signed APK | required* | required | excluded | excluded |
| android-release | Android / universal | production-signed APK, verified certificate | excluded | excluded | required | required |

`*` Local defaults select all three; explicit target arguments select a subset, each required. No optional targets are declared. Firefox/Chromium archives are not signed installable XPI/CRX files. [project-standards.json](project-standards.json) is the executable matrix/signing mapping. No desktop installer/AAB/standalone web app exists. Official Android targets remain mandatory and blocked pending signing/history review.

## Commands

```sh
npm ci
npm run typecheck
npm test
scripts/build_all.sh                         # Firefox + Chromium + Android debug
scripts/build_all.sh firefox chromium        # explicit subset
npm run build                               # managed Firefox build + package
npm run build:chromium                       # managed Chromium build + package
npm run build:all                            # managed builds of both browsers
npm run check                               # root typecheck/tests + both browser builds/verification
npm --prefix apps/android run typecheck
npm --prefix apps/android test
npm run apk:debug                           # managed Android build
npm run apk:debug:install                    # explicit adb update installation
npm run apk:debug:run                        # explicit install and launch
```

Every managed invocation accepts dirty input, captures a private copy before compilation, and reserves its own directory before starting. Root commands leave unpacked browser output at `dist/` / `dist/chromium/` for temporary installation. The compiler's `PBOARD_STAGE=1` mode, `npm run package:*`, and Android's native `npm run android:debug` are low-level intermediate/reviewer operations; use the managed commands above to preserve final local output. Package verification compares archive bytes with the corresponding build and verifies browser-background startup. Firefox additionally runs `npm run lint:firefox` with warnings as errors.

`npm run release:firefox`, `release:chromium`, and `release:all` are historical aliases for checks/builds; they do not publish. `scripts/compile-manifests.sh` remains available. `scripts/prepare-build.sh` now forwards to the managed builder without selecting a version. `--skip-frontend`/`--skip-android-build` are rejected: reusing an unverified old bundle cannot establish source identity. `--stable-apk` is rejected on the test-only builder; use official release packaging for production APKs.

## Managed artifacts

Output: `local_artifacts/<core>-local.<unique-integer>/Pboard-<identity>-<target>-universal.{zip,apk}`, with `build-info.json`. Each directory is an exclusive direct-child reservation. Manifest schema 1 / manager `pboard-local-builds` records state, source SHA/dirty/snapshot digest, effective configuration digest, standards pin, locks, host/toolchain, package versions, checksums/sizes and target outcomes. Local Android certificates are recorded as debug-only.

Source identity covers path/content/mode of tracked and relevant untracked inputs, deletions, and the effective public Firefox OAuth parameter. Compilation reads a private snapshot, not the changing working tree. Secret/env files, raw Git patches, caches, dependencies, Git internals, artifacts and private native config are excluded. Env files are not copied; only the documented public OAuth parameter is supplied privately. Dependency bytes come from installed `node_modules` identified by lockfiles; run `npm ci` after changing a lock and do not mutate dependencies during a build. Native private `google-services.json` integrations are not configured by the managed profile; official releases never consume ignored private source inputs.

Failures preserve partial packages and per-target reasons, record failed state and skip retention. Successful completion verifies hashes and allocates a durable completion sequence under the shared storage lock. A cleanup maintenance failure returns nonzero while preserving the successful build state.

```sh
scripts/clean-artifacts.sh --dry-run           # candidate identities, protection and skipped/retained reasons
scripts/clean-artifacts.sh --run               # replan/revalidate, then keep latest 10 eligible builds
scripts/clean-artifacts.sh --run --keep 2      # explicit one-pass override
node scripts/artifact-retention.mjs --protect BUILD_ID
```

Default retention is 10 successful unprotected managed builds, ordered by locked completion sequence. `--keep 0` also deletes the newest unprotected success. `.keep` of any type protects a build and does not count toward the limit. Use the locked protect command for race-free protection; an out-of-band edit cannot be atomic with active deletion. Active/failed/unknown/malformed/ambiguous/legacy directories are reported and retained. Symlinked roots/children are rejected/excluded. Internal symlinks are unlinked without traversal. Old `local_artifacts/<version>/<id>/` directories are never automatically migrated or pruned.

For manual recovery, stop/inspect the selected failed/interrupted build's processes first. Preview with `node scripts/artifact-retention.mjs --remove BUILD_ID --dry-run`; after reviewing identity/state/protection, explicitly delete with `--remove BUILD_ID --confirm BUILD_ID`. This removes that one positively owned direct child including any protection, under the same lock and containment checks. Unknown/malformed/legacy directories are refused and preserved for inspection. Recovering a stale lock is a separate deliberate human operation after checking no active builder/collector exists.

## CI

`.github/workflows/ci.yml` handles main pushes and PRs targeting main. It checks out exactly `github.sha` (proposed merge for PRs), records head/base/event/run/attempt identities, runs required root or Android checks, builds all three CI targets and uploads verified temporary packages/manifests for 14 days. Required tooling or upload failures fail CI. Compilation has read-only repository permission and receives no production secrets. Incomplete manifests are uploaded separately on failure. Browser smoke harnesses needing real browsers/accounts and physical-device update checks are excluded from ordinary CI; core automated tests, Android tests, strict Firefox lint and package verification are required.

## Loading the extension

Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/manifest.json`. Chromium: `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium/`. These are development installations, not evidence of store signing or acceptance.

## Chrome Web Store submission

Readiness review: 13 October 2026, version 0.9.3. The repository has a GPLv3
license, README, public homepage, privacy policy, and terms. All three public
Pages URLs returned HTTP 200 during this review. This does not verify the
publisher's Chrome Web Store account or Google Cloud production settings.

`npm run release:chromium` passed on Node 24.21.0: strict typechecking, 55
test files / 383 tests, production Chromium build, and background startup /
manifest verification. Authenticated Drive tests and manual Chrome UI
testing were not performed during this review.

### Before submitting

- Deploy the updated `docs/privacy.md` so the public policy includes the
  Chrome Web Store Limited Use statement as well as the Google API statement.
- Confirm the Chrome publisher account is registered, its contact email is
  verified, and two-step verification is enabled.
- Upload an initial draft to reserve the store extension ID. Confirm the
  Chromium OAuth client is registered for that ID; its client ID must match
  `manifest.chromium.json` and `src/sync/googleDriveConfig.ts`. An unpacked
  build can have a different ID. Follow Chrome's
  [OAuth setup instructions](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)
  to test with the store ID.
- Confirm the Drive API is enabled, OAuth branding uses the public URLs below,
  and the consent screen is ready for external production users. Full `drive`
  access is a restricted scope: complete Google's applicable verification and
  confirm whether an assessment is required for this data flow. Repository
  configuration and mocked tests cannot establish approval. See
  [Drive scope classifications](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
  and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
- Review collaboration authorization before distributing sharing publicly.
  `src/collab/manager.ts` accepts peers with `isPeerValid: () => true` in both
  pools. Viewer restrictions apply in the standard local client; receivers
  do not independently authenticate remote peers or authorize every write.
  Terms disclose this, but disclosure does not resolve the security gap. See
  [the collaboration security limits](docs/collaboration.md#authorization-and-security-limits).
- Prepare at least one real Chrome screenshot (1280×800 or 640×400) and a
  440×280 small promotional image. The repository contains extension icons,
  including a correctly sized 128×128 PNG, but no store screenshots or promo
  image. See [Chrome's image requirements](https://developer.chrome.com/docs/webstore/images).
- Run `npm ci` with a current Node 24 release, then `npm run release:chromium`.
  The lockfile's `jsdom` dependency requires Node 24.15.0 or newer within
  the Node 24 series; selecting major version 24 alone is insufficient.
- Package **the contents of `dist/chromium/`**, with `manifest.json` at the
  ZIP root. Do not upload the Firefox artifact or ZIP the enclosing `dist/`
  directory. Run `npm run package:chromium` after the release check. Builds
  include `LICENSE.md` and generated `THIRD-PARTY-NOTICES.txt`; packaging
  requires both and compares the archive against the build. Keep corresponding source and reproducible build
  instructions available for recipients of each published version.
- Load the production build in Chrome with the store ID and test local
  capture, screenshots, copying, restart persistence, Drive connect/reconnect,
  private sync, incoming shared boards, viewer/editor behavior, and revocation.
  Repeat Drive tests with a separate account; mocks do not verify these flows.
- Complete the dashboard's listing, privacy declarations, distribution, and
  reviewer instructions, then submit the verified ZIP. Choose deferred
  publishing if you want to review the approved item before making it public.

### Listing text and links

Suggested short description (also used by the manifest):

> Keep a private, structured project state alongside AI conversations.

Suggested listing description:

> Keep project notes, decisions, tasks, links, and images in a Chrome side
> panel alongside your conversations and web research. Organize cards into
> project boards, capture selected text, links, images, or a page region, and
> copy a board as structured text for use in another tool.
>
> Boards save on your device first. No Pboard account is required. Connecting
> Google Drive optionally enables asynchronous snapshot synchronization and
> board sharing. Connected boards and images are sent to Google; shared boards
> can also transfer to collaborators through Drive and WebRTC. Full Drive
> authorization is requested to discover and manage incoming shared boards.
>
> Pboard has no advertising, analytics, telemetry, or AI API integration.
> Capturing or sharing content is under your control. Pboard is open source
> under GPLv3. See the privacy policy and terms for data handling and current
> collaboration limitations.

- Homepage: <https://sg0zzy.github.io/pboard/>
- Privacy policy: <https://sg0zzy.github.io/pboard/privacy/>
- Terms: <https://sg0zzy.github.io/pboard/terms/>
- Support: `stefanogozzi@gmail.com`
- Source: <https://github.com/sg0zzy/pboard>

### Privacy practices and permission justifications

Suggested single purpose: **Organize and capture project reference material
in persistent sidebar boards, with optional synchronization and sharing.**

| Permission / host | Justification |
| --- | --- |
| `storage` | Persist extension settings, synchronization state, and local authorization state; board documents and images also use local IndexedDB. |
| `contextMenus` | Capture selected text, links, images, and the current page through explicit menu actions. |
| `clipboardWrite` | Copy cards or a structured board when the user clicks Copy. |
| `activeTab` | Temporarily access the current page after an extension action, shortcut, or context-menu invocation. |
| `scripting` | Read requested selections/links and inject the temporary region-capture overlay. |
| `sidePanel` | Display the project's boards and capture controls alongside the current page. |
| `identity` | Authorize optional Google Drive sync and sharing after Connect Drive. |
| `alarms` | Schedule asynchronous uploads after connected boards become dirty. |
| ChatGPT hosts | Load the bundled selection adapter on the two supported ChatGPT origins. |
| Google API hosts | Read/write Pboard Drive files and sharing permissions; exchange, refresh, or revoke authorization as appropriate for the browser. |
| Optional `<all_urls>` | Permit capture on user-chosen sites from the side panel, including region screenshots and inspecting selections/links when temporary access is unavailable. Access is requested through a capture action. |

Select **No remote code**: runtime code is bundled locally; Google requests
transfer data, and STUN establishes peer connections. Confirm this against
the final package whenever dependencies or runtime loading change.

Do not claim that no user data is handled simply because storage is local
first. Match dashboard declarations to `docs/privacy.md`: captured website
content, source URLs/page titles (the dashboard's web-history category),
Google/collaborator names and email addresses, and authorization credentials
are handled. Captured conversations can contain personal communications;
notes/images can contain other sensitive categories. Review the actual
dashboard definitions and disclose applicable categories, including optional
Drive and collaboration transfers. Certify Limited Use only after checking
the complete behavior. See [Chrome's privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).

### Reviewer instructions

Local features require no account. Open the side panel, create a board and
card, capture a selection from an ordinary HTTPS page, capture a region,
copy the board, and restart Chrome to check persistence. Grant optional page
access only when prompted by capture controls.

For optional features, connect an authorized Google test account, edit a
board, and check restoration in a second browser with the same account.
Share a board with a second account and test editor/viewer roles, image
transfer, member removal, and disconnect/reconnect. Provide any required
test access through the dashboard's private Test instructions tab; never
commit credentials to the repository or listing. Explain OAuth verification
status and the documented collaboration limitations to reviewers.


# Reproducing the AMO submission build (reviewers)

These steps reproduce the Firefox compilation and upload contents from reviewer sources. Official archives additionally stamp the numeric package version recorded in the release manifest: no secrets, no network access beyond npm, no
prebuilt artifacts.

## 1. Prerequisites

- Node.js **24** (`.nvmrc` pins 24; the version check in
  `scripts/compile-manifests.sh` enforces the major version).
- npm (ships with Node). No database, no compiler toolchain.

```sh
# optional: get the pinned Node version
nvm install
```

## 2. Install dependencies

```sh
npm ci
```

`npm ci` (not `npm install`) — `package-lock.json` is the exact dependency
tree used for the submitted build (lockfile v3).

## 3. Build the Firefox variant

```sh
PBOARD_STAGE=1 scripts/compile-manifests.sh firefox
```

This single script performs the whole pipeline with the pinned Node:

1. `PBOARD_STAGE=1 npm run build` — three Vite passes (`vite.sidebar.config.ts`,
   `vite.background.config.ts`, `vite.content.config.ts`) plus
   `scripts/copy-manifest.mjs`, producing `dist/`.
2. `node scripts/verify-build.mjs firefox` — checks that `dist/` contains
   `manifest.json`, `sidebar.html`, `background.js`, `content.js`,
   `icons/pin.svg`, that the manifest version matches `package.json`, and
   that the bundled `background.js` executes in a bare JS sandbox (no
   Node-only globals).

Equivalent granular commands:

```sh
PBOARD_STAGE=1 npm run build # staging compilation only (review checkout)
npm run verify:build -- firefox  # verify only
```

No environment variables are required. The optional Google OAuth client
secret (`VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET`, documented in
`.env.example`) is embedded when supplied through the environment or `.env.local`; from
a clean review checkout it is absent and the build still succeeds.

## 4. Compare against the submitted package

The production extension was packaged with:

```sh
npx web-ext build --source-dir dist --config web-ext-config.cjs
```

`web-ext-config.cjs` excludes source maps and `chromium/**`, while keeping
the sidebar JavaScript chunks. Run `npm run package:firefox` to package and
verify all runtime files before submission.

To compare byte-for-byte, unpack the submitted `.xpi`/`.zip` and diff it
against a fresh `dist/`. For official archives, first account for the documented four-field version stamp in `manifest.json`; a Mozilla-signed XPI also has service-generated signature files. For the unsigned staging ZIP, remaining differences are file order
(`web-ext` sorts entries) and the `zip` timestamp headers. File contents
are deterministic: identical sources, lockfile, and Node version yield
identical JS bundles (Vite production build hashes are content-derived).

## 5. Known deviation when rebuilt without secrets

If a `.env.local` with `VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET` was
present at the original build, the Google OAuth secret is embedded in two
bundles: the Firefox `sidebar` bundle (`dist/assets/sidebar-*.js`) and the
background bundle (`dist/background.js`, the Firefox-only `client_secret`
used for token exchange). Rebuilding from the AMO source archive — which
deliberately omits `.env.local` — produces the same files except that the
secret string is empty in both bundles. The differences are therefore:
`background.js` (secret string only), the sidebar asset's content hash
(because that one string changed), and the inline asset hash in
`sidebar.html` (pointing at the renamed sidebar asset). Every other file
(`manifest.json`, `content.js`, remaining `assets/*`) hashes identically.
This is expected and documented behavior: the secret is an optional
build-time input (see `.env.example`), not part of the reviewed source.
