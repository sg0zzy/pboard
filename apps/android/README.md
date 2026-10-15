# pboard Android

A local-first React/TypeScript/Vite application packaged with Capacitor 8. Application ID: `it.stefanogozzi.pboard`; display name: `pboard`; minimum Android: 13 (API 33); target/compile SDK: 36.

Milestone 0.1 established the native shell. Milestone 0.2 adds local boards and cards, editing, board deletion and trash management, manual ordering, live previews and a persisted preview setting. A new installation starts empty; `mockBoards.ts` remains a test fixture and is never loaded into the production database.

## Google Drive and WebRTC

Android now shares the extension's Drive snapshots, shared-board discovery, account ordering/preferences, permissions, image transport and WebRTC replication. Native Google Identity Services supplies access tokens. **Settings → Google Drive** provides Connect, Reconnect, Sync now and Disconnect. Open a board to see its access role/live peer count and invite editors or viewers through **Share board**. Existing collaborators can also be managed from the extension.

Create an **Android OAuth client in the existing Firefox Google Cloud project**. No Android client ID, client secret, `.env` variables or `google-services.json` needs to be put into this app. Google identifies the package/signing certificate directly. See [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md) for exact fields, this machine's debug SHA-1 and validation steps.

Sync runs in the foreground: after connection/resume, after local edits and periodically while open. Backgrounding stops replication/signaling and future sync timers; an already running HTTP reconciliation may finish. Failed sync retains local data and exposes an error/retry. Disconnect keeps local boards/photos, stops sync and clears the token cache without revoking the project-wide grant used by Firefox. The selected account is pinned for token renewal/reconnect; switching Google accounts is not exposed in this version.

Shared boards use the existing owner/editor/viewer model and project-scoped replication. Viewers cannot edit, including after leaving a room or reconnecting offline. Private board snapshots retain the existing timestamp comparison; shared boards retain the existing per-document WebRTC conflict policy. Photos use the existing Drive snapshot/shared-image paths. No database/schema migration or background Android service is added. No microphone or camera permission is needed for WebRTC data channels.

After a live WebRTC connection closes, recovery waits two seconds, reads the shared board's Drive backup without uploading, merges newer saved documents, and then retries WebRTC. Concurrent card/project room retries share the same in-flight Drive read. Newer local edits, local-only cards and deletion tombstones survive recovery; pending upload state is retained. The v1 Drive snapshot lacks deletion history and fractional ordering keys, so missing cards are not treated as deletions and existing live ordering is preserved for WebRTC to reconcile. A failed Drive read is reported but still allows the WebRTC retry. Leaving the board invalidates a late Drive response.

Validation for the cloud integration: 92 Android tests, all 399 extension tests, both browser builds/verification, Android typecheck/frontend build and debug APK passed. A Pixel 8a/API 36 emulator loaded Settings and the native Google plugin without errors, handled silent authorization requiring consent, and exchanged a message between real WebView WebRTC data channels. End-to-end Google login, cross-device Drive sync and project replication still need the registered Android OAuth client and test accounts.

The following milestone notes document the earlier offline implementation; their statements about cloud features being pending are superseded by this section.

## Architecture

All Android implementation and configuration stays in `apps/android`. No existing extension file, schema, browser UI, WebRTC implementation or Drive implementation was modified. No shared package or schema migration was introduced.

- `src/storage/repository.ts` directly reuses the browser-independent `src/storage/rxdbRepository.ts`, `blobStore.ts`, `orderKey.ts`, existing types and schemas from the repository root. It never imports the extension's browser/background/Drive adapters or registers sync callbacks.
- Android data lives in the separate `pboardandroidv1` RxDB database using the existing Dexie/IndexedDB storage, with a separate image store name. The WebView origin remains `https://localhost` across APK updates. `adb install -r` preserves app data; uninstalling or clearing app storage removes it. No SQLite plugin is added.
- RxDB collection subscriptions produce guarded snapshots for the UI. Read errors show a retry control; failed writes retain form drafts. `App.tsx` owns navigation and uses the official App plugin for native back. Unsaved edits, board deletion and emptying Trash require confirmation; navigation is blocked while saving. Card Save is in the fixed top toolbar and remains visible with the Android keyboard open.
- `HomeScreen`/`BoardTile` retain the two-column overview. Board and card forms provide title/text/type/status editing. Cards can be held for 400ms and dragged to reorder, with a lifted preview, edge scrolling and release-to-save; ordinary swipes still scroll and cancelled gestures do not write. There are no per-card action bars: double-tap edits a card, and holding it reveals a top-right trash target. Release inside trash to move a card into the Trash container; releasing a card already in Trash removes it permanently, as in the browser. Release elsewhere to reorder within its current container. Cancelled drags never delete. Keyboard and assistive activation still edit; Alt+Up/Down reorder and Delete trashes a card (or permanently removes a card already in Trash); settings can change manual board order and hide/show previews.
- Styling is self-contained CSS with system light/dark themes and Material 3 color roles, typography, 48px touch targets, rounded action buttons, 56px FABs, outlined fields and dialogs. No new component library or wallpaper-based dynamic color system is introduced. [Material 3 color roles](https://m3.material.io/styles/color/the-color-system) provide the styling structure, with pboard’s palette. Capacitor SystemBars and the minimal AndroidX edge-to-edge helper handle system insets; `platform/useSystemBars.ts` reapplies icon styles on live theme changes; Android uses `adjustResize` for the keyboard.

The Android package locks its own storage dependencies to the versions used by the extension. Vite deduplicates storage dependencies to this package, and TypeScript paths resolve dependencies used by the reused source files locally. Installing/building the extension is not required to build Android, but the repository source files must be present.

### Ordering and presentation

Boards reuse the existing `Project` model (`id`, `name`, `template`, `revision`, `createdAt`, `updatedAt`). RxDB's existing `orderKey` determines manual sidebar order; `listProjects()` returns that order.

`sortBoards` receives this ordered list, deduplicates by ID (first occurrence wins), places the four most recently edited boards first, then appends the remainder in manual order. Equal timestamps retain manual order; invalid/missing dates are oldest. Reads, opening a board, preview settings and manual board ordering do not change edit timestamps. Card edits and card moves do. Synchronization is not implemented and cannot touch timestamps here.

Categories are presentation mappings: brainstorming → Notes, idea → Ideas, project/software_project → Project. Overview accents/tints follow the first visible card type, using the browser’s existing `boardTemplates` definitions; empty boards use its neutral note colors. Card chips and accent borders use the same definitions, and status colors match the browser in both themes. These presentation choices add no persisted fields. A preview uses the first card in repository order that is neither deleted nor in trash, preferring its title over text. Trash cards remain editable in their collapsible container so their status can be restored. Permanent deletion uses the repository’s existing tombstone behavior.

## Development

Use Node 24 (the root `.nvmrc`), npm, JDK 21 and Android SDK 36. From the repository root:

```bash
cd apps/android
npm ci
npm run dev           # http://127.0.0.1:5173
npm test
npm run build         # typecheck and frontend bundle
npm run sync          # build and cap sync android
npm run android:run   # build, sync and run on a selected device/emulator
npm run android:debug # build, sync and Gradle assembleDebug
```

Tests use `*.check.ts(x)` with an Android-local Vitest pattern so extension test discovery remains unchanged. They cover sorting, restart persistence, edit timestamps, ordering/previews, subscription cleanup, forms, back navigation, error recovery, deletion confirmation and draft preservation.

## Android build and ADB installation

Android Studio is optional for normal editing/building. The Gradle wrapper and first Maven dependency downloads require internet during setup; the installed application requires no network access. All scripts, styles, icons and fonts are bundled; no development server URL is configured in the APK.

One command from the repository root builds the debug APK (and optionally installs/launches it):

```bash
scripts/build_android.sh   # same as npm run apk:debug; last line prints the APK path
export ANDROID_HOME="$HOME/Android/Sdk"      # JDK 21 must also be installed; set JAVA_HOME if java is not on PATH
npm run apk:debug          # frontend build + cap sync + gradlew assembleDebug
npm run apk:debug:install  # ... then adb install -r
npm run apk:debug:run      # ... then install and launch the activity
```

The script checks ANDROID_HOME, JDK 21+, the Capacitor CLI and gradle, and fails with the missing prerequisite. Flags: `--skip-frontend` reuses the previous bundle (Gradle-only rebuild), `--install`/`--run` need exactly one connected device unless only one of several is authorized. APK output: `apps/android/android/app/build/outputs/apk/debug/app-debug.apk`.

Manual equivalent:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 # adjust for your installation
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

# From apps/android:
npm run build
npx cap sync android
(cd android && ./gradlew assembleDebug)
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n it.stefanogozzi.pboard/.MainActivity
```

APK from the repository root: `apps/android/android/app/build/outputs/apk/debug/app-debug.apk`.
With multiple devices use `adb -s DEVICE_SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk`. Enable USB debugging and accept the USB authorization prompt on physical devices.

If SDK tools are missing, download **Command line tools only** from [Android downloads](https://developer.android.com/studio#command-line-tools-only). Follow the [sdkmanager setup](https://developer.android.com/tools/sdkmanager), putting its executable at `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager`, then install:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --sdk_root="$ANDROID_HOME" --licenses
```

Accept licenses interactively. Install Node 24/JDK 21 using your normal version/package manager if absent. No machine-specific SDK path or system environment changes are committed.

## Debugging and validation

Run the debug APK on a connected device and open `chrome://inspect/#devices` in desktop Chromium. Enable USB discovery and inspect the pboard WebView for JavaScript console output. Native logs: `adb logcat -s Capacitor Capacitor/Console AndroidRuntime` (add `-s DEVICE_SERIAL` before `logcat` if needed).

From the repository root, extension checks remain `npm ci && npm run check`.

Workspace validation: all 82 Android tests in 12 files, frontend typecheck/build, Capacitor sync and Gradle debug APK passed. Extension checks on rebased main passed all 399 tests in 60 files, both Firefox/Chromium builds and build verification. Pixel 8a/API 36 emulator checks covered light/dark startup and live theme changes, creation of a board/card with no active network, persisted text and preview settings after process restart, native back and no horizontal overflow. Follow-up emulator checks verified trusted touch hold/drag, persisted new order after restart, and tapping toolbar Save while the soft keyboard was visible.

## Limitations and later milestones

Data is local to this app; there is no transfer from the extension or cloud backup. The current snapshot reads all cards, suitable for this initial implementation; large-board performance should be measured before adding larger datasets. The editor stores plain Markdown text, with the browser’s formatting/checklist renderer on boards. Multiple image attachments, camera capture, collaboration and sync are not implemented. Local feature coverage and intentional mobile adaptations are documented in [FEATURE_PARITY.md](FEATURE_PARITY.md). Multi-record repository edits use existing sequential writes rather than introducing new transactions.

Android 13, physical-device, TalkBack, large-font and additional keyboard/device configurations need broader coverage. WebView IndexedDB storage survives ordinary restarts and APK updates but has no independent backup/export in this milestone.

WebRTC replication, Google Drive OAuth/authentication and synchronization, sharing, conflict resolution, migrations, automatic/background sync, background Android services, notifications and Play Store release setup remain pending later milestone specifications. Milestone 0.2 does not register network or background services.

## Files changed for milestone 0.2

All paths below are relative to `apps/android`. Existing extension files are unchanged.

- Added: `src/storage/repository.ts`, `src/platform/useSystemBars.ts`, `src/components/ScreenHeader.tsx`, `src/components/ConfirmDialog.tsx`, `src/screens/BoardScreen.tsx`, `BoardFormScreen.tsx`, `CardFormScreen.tsx`, `SettingsScreen.tsx`, and `tests/storage.check.ts`.
- Updated: `src/App.tsx`, `src/components/BoardTile.tsx`, `src/screens/HomeScreen.tsx`, `src/styles/index.css`, `tests/navigation.check.tsx`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `android/app/build.gradle`, `android/app/src/main/AndroidManifest.xml`, and this README.
- Removed: the obsolete `src/screens/PlaceholderScreen.tsx`. Existing ordering tests and sample fixtures are retained.

Follow-up Android UI files: added `src/interactions/useCardDrag.ts`, `src/data/cardColors.ts` and `tests/cardDrag.check.tsx`; updated board/card screens, App navigation, overview projection, BoardTile, CSS, navigation/storage tests and this README. Existing extension files remain unchanged.

Compact card interactions: `BoardScreen.tsx` removes per-card buttons and implements double-tap/keyboard activation; `useCardDrag.ts` follows both drag axes, hit-tests the temporary trash target, suppresses post-drag clicks, and routes trash drops separately from reorder writes. `Icon.tsx` and CSS supply the trash target; App no longer needs the old up/down callback. Tests cover single versus double taps, target highlighting, release-only deletion, leaving/cancelling over trash and keyboard access. Pixel 8a touch tests verified editing and the trash target.

Card category and status share the compact top row, including the lifted drag preview. Long category labels truncate to keep the status and drag grip visible without horizontal overflow.

Field editing: single-tap category or status to open a colored in-app chooser and save that field immediately on the board. Single-tap an existing title or the text to open the editor with the chosen field focused; toolbar Save commits text/title edits. Double-tap on the card background remains available. Chooser keyboard events do not open the editor, and drag-release clicks are suppressed. Added tests cover field-specific focus, isolated category/status patches, toolbar saves and drag-click protection; emulator checks verified the native status picker and focused text editing.

New cards autofocus the text content; the optional title remains available without taking initial focus. Editing an existing card still respects the field tapped on the board.

Card editor Save shortcut: double-tap the title, text or editor background to submit through the same form as toolbar Save. Single taps, swipes, long presses, cancellation, multiple fingers, selectors and active text composition do not trigger it. Empty-card validation and the in-flight save guard remain in effect; touch-generated compatibility double-clicks cannot submit twice. The toolbar Save button remains available. Implementation: `useCardSaveShortcut.ts` and `CardFormScreen.tsx`; gesture/validation tests are in `cardSaveShortcut.check.tsx`.

Pixel 8a emulator verification: one trusted touch tap remained in the editor; a second tap saved the edited text and returned to the board through the normal save path.

Board status swipes: swipe right to advance candidate → confirmed → started → to validate → done, or left to go back. The ends stop at candidate/done; rejected/trash stay accessible only through the selector. A horizontal swipe must cross roughly one fifth of the card width (48–80 logical pixels) and commits once on release. Short, diagonal, cancelled and multi-touch gestures do not change status. Vertical swipes still scroll; holding first still starts reorder/trash dragging. The normal status label retains the browser-aligned colors; the swipe preview uses the Material container roles. An update writes only the status through the original repository.

Pixel 8a trusted-touch verification confirmed left swipe done → to validate and right swipe to validate → done while remaining on the board, without opening the editor.

Done celebration: successful local transitions into done (swipe, selector, editor/new-card Save) reuse the browser’s `BoardConfetti` component and particle palette/generator unchanged. Android-only CSS reproduces its falling animation across the current visible safe-area viewport, rather than the scrollable board height. The non-interactive, screen-reader-hidden overlay clears after one second, restarts for a fresh completion and respects reduced motion. Opening existing done cards, changing their text or failed writes does not celebrate. React runtime/type resolution is deduplicated to the Android package for the reused component. Pixel 8a checks verified the viewport-sized effect and cleanup.


Terminal containers: cards in done, rejected and trash appear in **Done → Rejected → Trash** sections below active cards. Only non-empty sections are shown; they start collapsed when opening a board, with counts and accessible trash actions. Sections preserve the same manual repository order as the browser; neither completion time nor trashing changes ranks. Editing/status selection and swipe-back from done remain available when expanded. Dragging and keyboard moves target cards in the same container using the browser’s unchanged `reorderAtTarget` helper and repository single-card rank update.

“Trash done cards” and “Trash rejected cards” move all cards in that board’s chosen section to trash without deleting them. “Empty trash” confirms permanent removal, then calls the existing board-scoped repository `emptyTrash` method. Dragging a normal card onto trash now moves it there immediately; dragging an already trashed card onto trash permanently removes it, matching the browser. Restoring a status returns the card to its existing manual position. Bulk status updates use sequential writes; a failed write shows the existing error notice and earlier successful writes are retained.

Container changes: added `src/data/cardContainers.ts`; updated `src/screens/BoardScreen.tsx`, `src/interactions/useCardDrag.ts`, `src/App.tsx`, `src/styles/index.css`, `tests/cardDrag.check.tsx`, `tests/navigation.check.tsx`, `tests/storage.check.ts` and this README. Tests cover collapsed sections/counts, canonical ordering, section-local drag/keyboard moves, recovery from trash, bulk actions, empty-trash confirmation, persistence and isolation between boards. Existing extension files remain unchanged.

Pixel 8a/API 36 container verification: trash persisted after APK update and process restart; trusted taps expanded its section; restoring a card returned it to the active list; a trusted right swipe moved it into collapsed Done; the Done bulk action moved it into Trash; Android back cancelled the empty-trash confirmation; confirming it removed the trash cards. No horizontal overflow occurred throughout.


Colored card choices: the board’s category/status buttons open `src/components/CardFieldPicker.tsx`, a compact Material-style dialog. Category options reuse `cardColors` and `.card-type-label`; status options reuse `.card-status` and the existing status color classes, including light/dark overrides. The current choice has a checkmark and accessible pressed state. Selecting an option follows the same immediate single-field save path; Cancel, Escape and Android back close the chooser without saving or leaving the board. These in-app dialogs replace the board’s native select popup so option colors render consistently on Android; editor form selects are unchanged. Changes are confined to the picker, board screen, App modal handling, CSS, interaction/navigation tests and this README.

Pixel 8a/API 36 color verification: trusted taps opened both choosers and saved category/status changes. WebView computed styles confirmed identical option/card text colors in light and dark mode, and identical category background tints. Android back dismissed the chooser without leaving the board. All 56 Android tests, the debug APK build and all existing extension checks passed.


Android app icon: the launcher and splash screen use the repository’s `icons/logo.png`. The original remains unchanged. `scripts/generate-icons.py` creates separate 432 × 432 lossless PNG foreground and monochrome assets under `android/app/src/main/res/drawable-nodpi`, with padding for adaptive launcher masks. The foreground preserves the supplied artwork and colors; the themed-icon mask preserves dark outlines and the green check’s shape. Both launcher variants share these assets, with a neutral background that keeps the black logo readable in either system theme. The launch splash uses the same adaptive icon.

To regenerate after changing the source logo, run `python3 apps/android/scripts/generate-icons.py` from the repository root (requires Pillow). Normal Android builds need no Python dependency; generated resources are included in the app. All icon changes remain inside `apps/android`.

Android card photos: the editor’s **Add photo / Replace photo** button uses the official [`@capacitor/camera` photo picker](https://capacitorjs.com/docs/apis/camera), restricted to one photo. No camera or broad photo-library permission is added. Cancel does not alter the draft; decoding/selection failures retain the current picture and show an error. A photo can accompany text or be the only card content. **Remove photo** changes the draft; image changes commit only with toolbar Save or the existing double-tap shortcut.

The unchanged browser `processImageFile` utility accepts images up to 20 MB, fits them within 1400 pixels and encodes them for storage. Android’s existing separate blob store retains the processed image; the existing RxDB image reference/metadata fields are reused. `storage/cardPhotos.ts` resolves a replacement blob before passing image-reference fields and editor fields together through the unchanged repository updater, preserving its timestamps, revision and rank handling. Removing a reference does not delete a blob shared by another card or retained by a tombstone. Unreferenced image cleanup is deferred.

Inside a board, `CardImage` generates an aspect-preserving preview bounded to 480 × 240 pixels when needed. Small pictures are kept at their own size; no photo is cropped or enlarged. The editor shows the stored picture at a larger fitted size. Thumbnails are generated locally on demand, rather than adding schema fields or storing duplicate images. Temporary object URLs are released; missing/corrupt photos show a lightweight unavailable state; if thumbnail generation fails, the stored image is fitted with CSS. Home tiles retain their existing text previews.

Photo implementation files (all under `apps/android`): added `src/platform/pickPhoto.ts`, `src/images/thumbnail.ts`, `src/components/CardImage.tsx`, `src/storage/cardPhotos.ts`, `tests/photos.check.ts`, `tests/photoEditor.check.tsx`, `tests/photoStorage.check.ts`, `tests/cardImage.check.tsx`; updated `src/screens/CardFormScreen.tsx`, `src/screens/BoardScreen.tsx`, `src/App.tsx`, `src/components/Icon.tsx`, `src/styles/index.css`, `package.json`, `package-lock.json`, Capacitor’s generated Android plugin/build configuration and this README. No extension source, icon, image handler or schema changed.

Photos remain local and require no network access once installed. One image per card is supported; there is no camera capture, multi-photo gallery, photo editing UI or photo backup/sync. As with existing editor drafts, an operating-system process kill while the picker is open can lose unsaved changes; reopening retains previously saved cards. Large photo collections and thumbnail caching need further performance coverage.

Photo validation: all 69 Android tests in 10 files, the debug APK, all 164 extension tests, both browser builds and build verification passed. Pixel 8a/API 36 checks launched the native single-photo picker, attached a photo to an existing card, cancelled replacement without losing its image, created a photo-only card, and confirmed both pictures after process restart. A 1200 × 2400 test image became a stored 700 × 1400 picture and a 120 × 240 board thumbnail; the full aspect ratio was preserved in light and dark themes without horizontal overflow. The packaged manifest contains no camera or media-library permission.

Logo validation: the optimized color asset is 87,987 bytes (source: 1,926,412 bytes); its separate monochrome asset is 38,518 bytes. Pixel 8a/API 36 launcher inspection confirmed the supplied P/check/notes artwork renders fully inside the round icon. The debug APK, all 69 Android tests, all 164 extension tests, both browser builds and build verification passed. The source `icons/logo.png` and browser icon remain unchanged.


## Local feature parity after the main rebase

`agent/cloud` was rebased onto `main` commit `85fcc08` (Download board); the Android work and pre-existing staged/untracked files were restored. [FEATURE_PARITY.md](FEATURE_PARITY.md) contains the complete feature matrix, excluded web-page commands, mobile adaptations and the next Drive/WebRTC integration requirements.

The compact card overflow menu provides copy, duplicate, insert below, merge, trash and persisted Compact/Standard/Expanded modes. Confirmed merge sources require confirmation; photo sources cannot be merged; target photos and metadata remain intact. Board rendering reuses the unchanged browser Markdown/checklist components and safe links, fingerprint visualization, display-mode definitions, serialization, category/status keyboard cycles and archive builder. Settings persist the browser’s text-size steps without editing project timestamps. Editor **Save and add below** opens a clean next draft; Ctrl/Command+S saves and Ctrl/Command+Enter saves/adds below. Normal phone Enter remains a newline. Board keyboard focus/reordering work within the current container, and focus returns to duplicated, merged or reordered cards.

**Download board** exports the same ZIP as the browser (`board.txt` and deduplicated image files; Trash excluded). Android’s small `BoardExportPlugin` uses [`ACTION_CREATE_DOCUMENT`](https://developer.android.com/training/data-storage/shared/documents-files#create-file) to choose a destination and writes the completed ZIP off the UI thread. No storage permission is requested; cancellation leaves the board unchanged. Development in a browser retains the normal download helper. The archive is a text/images export, not a database backup or sync format.

Parity files added: `FEATURE_PARITY.md`, `src/components/CardActions.tsx`, `src/platform/boardExport.ts`, `android/app/src/main/java/it/stefanogozzi/pboard/BoardExportPlugin.java`, `tests/parityStorage.check.ts`, `tests/boardExport.check.ts`. Updated: App, board/card/settings screens, Icon, Android-only CSS, local snapshot/preferences and photo-save adapters, MainActivity registration, Android package/lock/config files, interaction/navigation tests and this README. Added exact-version `fflate` (same version as main) and the official Capacitor Clipboard plugin. TypeScript includes main’s simple-peer declaration for the repository’s new type-only collaboration role dependency; no WebRTC runtime is imported into the Android bundle. Existing extension files, schemas and sync implementations remain unchanged by the parity work.

Validation: all 82 Android tests in 12 files, all 399 extension tests in 60 files, both extension builds/verification and the Android debug APK passed. Pixel 8a checks covered preserved data after the rebase, overflow-menu duplication, native clipboard, Markdown/task toggling, persisted display mode and text size, confirmed-source merging into a photo card, and a native saved ZIP whose entries and CRC were verified. Drive and WebRTC integration remain disabled.

Final Pixel 8a checks on the latest APK verified a clean, text-focused next draft after Save-and-add, insertion immediately after the chosen anchor, preserved photos/checklists/text size after restart, and cancellation of the system export dialog without an error or board changes. No horizontal overflow was observed.
