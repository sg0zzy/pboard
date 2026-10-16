# Pboard version mapping

The [standards adoption](DEVELOPMENT_STANDARDS.md) pins the authoritative central VERSIONING, RELEASE and ANDROID contracts. This file describes Pboard's fields and compatibility surface.

`VERSION` is the only editable product-version authority: `X.Y.Z` selects a stable candidate; `X.Y.Z-dev` selects a proposed development core. Stable selection is explicit. Local builds derive a separate `X.Y.Z-local.N` identity using a collision-resistant integer and do not edit these files or consume published beta numbers.

`node scripts/sync-version.mjs` derives the core-version mirrors in both browser manifests, root and Android package/lock files, and Gradle `versionName`. `node scripts/sync-version.mjs --check` verifies them without edits. `scripts/version.sh bump patch|minor|major` or `set X.Y.Z-dev` explicitly selects a development core. Use `scripts/version.sh show` to inspect the selection; append `--dry-run` to a bump/set command to preview without edits. Bumps validate current/known reservation ordering and both platform adapters, and restore metadata on synchronization failure. Stable commit/tag preparation and beta workflow dispatch are in [RELEASE.md](RELEASE.md#shell-commands). Tests read VERSION rather than maintaining a literal version.

## Platform fields

- Local browser ZIPs retain the tracked numeric core; the build manifest associates it with the full local product version. Temporary loading uses `dist/` or `dist/chromium/`.
- Official browser archives use `major.minor.patch.slot`: beta slot N in 1..65534; stable slot 65535. Fields must fit Chrome's 0..65535 range. Chromium `version_name` carries the full product version. The release manifest records both versions, providing a lossless association for Firefox too. Previously distributed three-field versions are preserved; the next release must pass the complete historical inventory and high-water gate before this mapping is activated. Browser packages remain upload ZIPs, not signed XPI/CRX files.
- Android ID remains `it.stefanogozzi.pboard`; minimum API 33, target/compile API 36. Official mapping remains `(major*100000 + minor*1000 + patch)*1000 + slot`, with beta N in 1..998 and stable slot 999. Bounds: major ≤20, minor ≤99, patch ≤999, code ≤2,100,000,000. Exceeding a bound stops allocation. Local debug APKs use the tracked code and a local versionName; they consume no production reservation.
- The encoded Android scheme is retained to avoid changing historical identities. It needs the owner's full code/submission inventory before activation; skipped/failed official tags remain reservations. No production update edge is claimed before matching installed-certificate and device verification. See [signing](RELEASE.md#signing-and-platform-identities).

## Compatibility surface

Pboard is in version zero. User board/card/image data, IndexedDB/RxDB schemas and migrations, text/image exports, browser extension IDs, Android ID/signing/update history, and Drive/WebRTC formats are compatibility surfaces. There is no public stable API promise; changes may occur during initial development, but data loss or incompatible migrations require a recovery path and explicit disclosure. Synchronization is not a historical backup. Existing export/restore gaps are recorded in the adoption declaration and are not waived by version zero.
