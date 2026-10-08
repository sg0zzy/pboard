# Building Pboard

## Prerequisites

- Node.js (≥ 20 recommended; developed on Node 24). No local `engines` pin.
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

`web-ext-config.cjs` excludes source-map assets. `dist/chromium/` sits inside `dist/`, so `web-ext` warns about it — the Chromium variant is not a Firefox package, ignore that. Expected: 0 errors, 0 warnings (requires Firefox ≥ 142, enforced via `strict_min_version`).

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
tree used for the submitted build (207 packages, lockfile v3).

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
npm run verify:build firefox  # verify only
```

No environment variables are required. The optional Google OAuth client
secret (`VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET`, documented in
`.env.example`) is only embedded when a `.env.local` file provides it; from
a clean review checkout it is absent and the build still succeeds.

## 4. Compare against the submitted package

The production extension was packaged with:

```sh
npx web-ext build --source-dir dist --config web-ext-config.cjs
```

(`web-ext-config.cjs` excludes source-map assets.) `dist/chromium/` sits
inside `dist/`, so `web-ext` ignores it via the exclude list; it is a
Chromium-only variant, not part of the Firefox package.

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