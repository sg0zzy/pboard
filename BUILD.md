# Building Pboard

## Prerequisites

- Node.js 24.15.0 or newer within the 24 series. `.nvmrc` selects major version 24; the lockfile's `jsdom` dependency requires at least 24.15.0. `scripts/compile-manifests.sh` checks only the major version; `package.json` has no `engines` pin.
- Firefox and/or Chromium for smoke testing, if desired.

## Quick start

```sh
npm install
npm run check        # typecheck + tests + both builds + verify
```

## Build commands

| Command | What it does |
|---|---|
| `npm run build` | Firefox build → `dist/` |
| `npm run build:chromium` | Chromium build → `dist/chromium/` |
| `npm run build:all` | Both variants |
| `npm run verify:build` | Sanity-checks the built output (files present, manifest matches `package.json`, background bundle runs without Node-only globals) |
| `npm run check` | Full gate: `typecheck` + `test` + `build:all` + `verify:build` |

Each variant has a matching release script (`npm run release:firefox`, `release:chromium`, `release:all`) that runs typecheck, tests, build, and verification in one shot.

## Linting the Firefox package

```sh
npm run build
npx web-ext lint --source-dir dist
```

`web-ext-config.cjs` excludes source maps and the entire `dist/chromium/`
subdirectory. All runtime JavaScript in `assets/` must be included. Firefox
142 or newer is required by `strict_min_version`.

## Package and publish Firefox updates

```sh
npm run release:firefox
npm run lint:firefox
npm run package:firefox
```

The last command creates `web-ext-artifacts/pboard-<version>.zip` and compares
every runtime file in it against `dist/`. Upload that verified ZIP, rather
than a previous artifact. Version 0.9.2 on AMO was missing all `assets/*.js`
because the old packaging configuration excluded them; temporary installation
from `dist/` bypassed that exclusion. Version 0.9.3 fixes the packaging.

The workflow `.github/workflows/firefox-release.yml` runs tests, a Firefox
build, Mozilla lint, and archive verification on pull requests and pushes to
`main`. Publishing a stable GitHub Release automatically submits the matching
version to the existing AMO listing, including reviewer sources. Prereleases
build artifacts without submitting to AMO. Mozilla review can delay public
availability; a successful workflow means the version was submitted.

One-time setup:

1. Generate API credentials for the Mozilla account that owns Pboard at
   https://addons.mozilla.org/en-US/developers/addon/api/key/.
2. In GitHub → Settings → Secrets and variables → Actions, add repository
   secrets `AMO_JWT_ISSUER` (JWT issuer/API key) and `AMO_JWT_SECRET` (JWT secret).
3. If the Firefox Drive OAuth build needs the optional credential, also add
   `VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET`. This value is embedded in the
   extension, as explained in `.env.example`; AMO credentials are used only
   during submission.

For each release, update `package.json`, the root package versions in
`package-lock.json`, both manifests, and `tests/releaseMetadata.test.ts` to the
same unused version. Commit and push the changes, tag that commit as
`v<version>` (first fixed release: `v0.9.3`), and publish a GitHub Release for
the tag. Keep the Gecko ID `project-board@local.invalid` unchanged so uploads
update the existing listing. Alternatively, run the workflow manually with
the version tag selected; manual runs also submit to AMO. Do not resubmit
the same version after a successful upload.

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
  directory. There is currently no `package:chromium` command. Include the
  GPLv3 license and required bundled dependency license/copyright notices
  in the distributed package; the current build-copy script copies only the
  manifest and icons. Keep corresponding source and reproducible build
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
> Google Drive optionally enables asynchronous backup, synchronization, and
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

## Loading the extension

- **Firefox**: `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → pick `dist/manifest.json`.
- **Chromium**: `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick `dist/chromium/`.

## Tests

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

# Reproducing the AMO submission build (reviewers)

These steps reproduce the exact Firefox package submitted to Mozilla Add-ons
from the source archive: no secrets, no network access beyond npm, no
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
scripts/compile-manifests.sh firefox
```

This single script performs the whole pipeline with the pinned Node:

1. `npm run build` — three Vite passes (`vite.sidebar.config.ts`,
   `vite.background.config.ts`, `vite.content.config.ts`) plus
   `scripts/copy-manifest.mjs`, producing `dist/`.
2. `node scripts/verify-build.mjs firefox` — checks that `dist/` contains
   `manifest.json`, `sidebar.html`, `background.js`, `content.js`,
   `icons/pin.svg`, that the manifest version matches `package.json`, and
   that the bundled `background.js` executes in a bare JS sandbox (no
   Node-only globals).

Equivalent granular commands:

```sh
npm run build              # build only
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
against a fresh `dist/` — the only acceptable differences are file order
(`web-ext` sorts entries) and the `zip` timestamp headers. File contents
are deterministic: identical sources, lockfile, and Node version yield
identical JS bundles (Vite production build hashes are content-derived).

## 5. Known deviation when rebuilt without secrets

If a `.env.local` with `VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET` was
present at the original build, the Google OAuth secret is embedded in the
Firefox `sidebar` bundle (`dist/assets/sidebar-*.js`). Rebuilding from the
AMO source archive — which deliberately omits `.env.local` — produces the
same bundle except that one string is empty (`dt=```). Every other file
(`manifest.json`, `content.js`, `background.js`, remaining `assets/*`,
`sidebar.html` apart from the inline asset hash) hashes identically; the
sidebar asset's content hash changes because that single string changed.
This is expected and documented behavior: the secret is an optional
build-time input (see `.env.example`), not part of the reviewed source.
