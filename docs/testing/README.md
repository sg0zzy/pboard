# Testing infrastructure

The [architecture and gaps](architecture.md) record describes current fixtures and the unfinished local integration platform. Tests require the project's documented Node version and installed lockfile dependencies (`npm ci`). With dependencies already installed, focused in-process tests do not need Google credentials:

```sh
npx vitest run tests/multiBrowser/fakeDriveAuthorization.test.ts tests/multiBrowser/driveAuthorityRuntime.test.ts
```

`npm run typecheck` checks TypeScript; `npm test` runs the root Vitest suite. The whole suite passes locally (1,870 tests over 257 files at the time of writing); run results must still be reported, not assumed. The existing `npm run test:collaboration` defaults to a public service and is not an offline command. Do not use it for an isolated local run. Two-Firefox extension automation, a local identity/Drive/relay stack, seeded replay and complete offline verification are not yet available as a combined harness.
