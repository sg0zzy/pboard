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