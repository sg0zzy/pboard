# Testing infrastructure

The [architecture and gaps](architecture.md) record describes current fixtures and the unfinished local integration platform. Tests require the project's documented Node version and installed lockfile dependencies (`npm ci`). With dependencies already installed, focused in-process tests do not need Google credentials:

```sh
npx vitest run tests/multiBrowser/fakeDriveAuthorization.test.ts tests/multiBrowser/driveAuthorityRuntime.test.ts
```

`scripts/test-all.sh` runs every locally runnable suite in one pass (root and Android typechecks, root Vitest, Android Vitest, relay `cargo test`, the buffer probe) and prints a per-suite summary; `--only <suite>` narrows it to one. It exists so a complete local check does not depend on remembering the individual commands.

The recovery tests are not a separate entry: `tests/recovery/**` is inside the root glob, so `npm test` already runs all 36 files (237 tests) and `tests/recovery/recoveryInventory.test.mjs`, which checks that `scripts/recovery/scenarios.json` still maps every contract scenario once, still cites existing evidence, and still reports its gaps rather than claiming acceptance. `scripts/recovery/run.mjs --browser` (native Chromium fixtures, currently requiring a Google credential) is a manual command, not part of any gate.

Public-endpoint and credential-dependent smokes are intentionally excluded — see the script header.

`npm run typecheck` checks TypeScript; `npm test` runs the root Vitest suite. The whole suite passes locally (1,870 tests over 257 files at the time of writing); run results must still be reported, not assumed. The existing `npm run test:collaboration` defaults to a public service and is not an offline command. Do not use it for an isolated local run. Two-Firefox extension automation, a local identity/Drive/relay stack, seeded replay and complete offline verification are not yet available as a combined harness.
