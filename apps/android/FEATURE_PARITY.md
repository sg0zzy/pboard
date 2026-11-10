# Android local feature parity

Audited against `main` commit `85fcc08` (Download board), after rebasing `agent/cloud` onto the same commit. This audit covers the browser's local board/card features. Drive, sharing and WebRTC are a subsequent integration phase, rather than part of the offline parity claim.

| Browser feature | Android implementation |
| --- | --- |
| Create/select/rename/delete a board; change board template | Home overview and board editor, including deletion/type-conversion confirmations. Same repository/template definitions. |
| Board colour by category | Home tiles take their accent and category chip from the board's category (Notes, Ideas, Project), shared between the two project templates, with a Notes fallback for unknown templates. Colour no longer depends on the first card. |
| Manual board ordering | Settings controls call the same repository ordering API. Home additionally promotes the four most recently edited boards, as requested for Android. A home toolbar toggle switches between the preview tiles and a compact name-only ("Board only") layout; a board toolbar toggle collapses every card to a single summary row ("First row only"). Both are device-local presentation settings. |
| Board deletion returns home | Deleting the open board, or the board disappearing by any other route, returns to the home grid — including while a write is unsettled and when the delete succeeds locally but later remote work fails. The failure is still reported in the notice. |
| Board sharing surface | The share control is anchored on the live peer/role row: present-but-disabled while connecting, absent for editors and viewers, with the invitation form (and its result message) below the row so the card list never shifts. |
| Material menu icons | Card menus use standard Material Symbols (filled, 24 dp) with one leading glyph per action and distinct glyphs per display mode; the toolbar keeps the app's outline icon set. Menu text and behaviour are unchanged. |
| Card title, text, category and all statuses | Card editor and colored category/status choosers. Existing fields and supported template categories are reused. |
| Card text formatting and URLs | Reuses `MarkdownInline`/`MarkdownContent`: bold, italic, inline code, safe links, paragraphs, ordered/unordered lists. Existing source URLs remain visible and metadata is preserved. No raw HTML interpretation. |
| Checklists | Same Markdown parser, line indexes and `setTaskCheckedAtLine`; checkbox taps update only content and do not open the editor or start dragging. |
| Card display modes | Compact/Standard/Expanded in the card menu and editor; same existing `displayMode` field, default, cycling and text-clipping rules. Compact hides photos, Expanded shows a larger fitted photo. |
| Insert immediately below a card | Card menu **Add card below**, Ctrl/Command+Enter on a board card, and **Save and add below** in the editor. Reuses the repository's transient `afterItemId` input. |
| Duplicate a card | Card menu; same repository method. Preserves text/title/type/photo/source/display mode, inserts after the original and resets status to candidate. |
| Merge cards | Card menu → target chooser. Same repository append/tombstone semantics and target metadata/order. A confirmed source requires confirmation; a photo source cannot be merged. Targets are restricted to the same board. |
| Reorder cards | Hold/drag with auto-scroll, mouse/pen drag, Alt+Up/Down and Ctrl/Command+Shift+Up/Down. Only same-container targets; same `reorderAtTarget` and single-card rank update. |
| Status/category keyboard shortcuts | Left/Right cycles the complete browser status sequence; Ctrl/Command+Left/Right cycles supported categories; V cycles display mode; Up/Down focuses the adjacent card in the same container. |
| Edit/save/cancel | Single field taps or background double-tap open the Android editor. Toolbar Save and double-tap Save remain; Ctrl/Command+S saves and Ctrl/Command+Enter saves/adds below. Back/Escape handles menus and dirty drafts. Phone Enter inserts a newline. |
| Done/Rejected/Trash containers and bulk actions | Same non-empty, initially collapsed sections and manual ordering. Bulk trash, restore, permanent deletion and confirmed Empty Trash use the existing repository methods. |
| Copy card | Card menu; exact browser `cardTextForClipboard` format, including type/status tags. Empty text choices are disabled. |
| Copy board and terminal sections | **Copy board** and Done/Rejected header copy buttons. Exact `serializeBoard`/`serializeProject` output and container order. Board copying excludes Trash. Uses native clipboard on Android. |
| Download board | **Download board** uses the unchanged `buildBoardArchive` function from main: ZIP with `board.txt` plus images, image deduplication, Trash excluded. Android system Save as chooses a file destination without storage permissions. Web development retains browser downloads. |
| Board status fingerprint and completion effect | Reuses browser `ProjectFingerprint` and `BoardConfetti`, with Android-scoped styling, theme colors and reduced-motion handling. |
| Text size | Settings provide the same 80–130% steps and normalization. Persisted as a device-local setting; changing it does not change board edit timestamps. |
| Local images | Photo picker, one photo per card, caption/photo-only cards, replacement/removal and fitted thumbnails. Existing processing/blob/image-reference schema is reused. Duplication and export preserve photos. |
| Responsiveness | Card rows and the status fingerprint are memoized, equal snapshots are not re-rendered, idle polling no longer re-renders, edits are queued rather than dropped, board archives compress in a worker and photo processing runs off the render path. Behaviour and persisted data are unchanged. |
| Live local data, ordering, IDs and timestamps | Existing repository/schemas; snapshots are reactive. Reads, copying, exporting and preference changes never edit board timestamps. Text/status/mode/photo/reorder changes follow existing repository revision handling. |

## Excluded browser integration

Pin current page, pin a page's selected text/link, region/page screenshot capture, provider/content-script extraction, extension context menus, browser action/extension shortcuts, sidebar opening and browser minimum-width negotiation are excluded. Android's photo picker replaces desktop image-file dropping. Ordinary URLs contained in notes are retained; opening a saved link is distinct from capturing a web page.

## Intentional Android adaptations

The two-column home screen, native back, safe-area handling, fixed editor Save, touch dragging and colored mobile choosers remain. Secondary card actions live behind a single overflow button, never in the removed per-card action bar. Desktop middle-click insertion/duplication and Shift-drag merging are exposed as touch menu actions. Android swipes keep the requested bounded candidate → confirmed → started → to validate → done workflow; rejected/trash remain available through the chooser and full browser keyboard cycle. Status writes commit immediately rather than waiting for the desktop's status-move delay. A completion saved through Save-and-add opens the next draft; confetti is shown when returning to the board. Unsaved new cards are drafts until Save, rather than stored empty cards. Home tiles continue using text previews, while board cards show photos.

The ZIP is a prompt-and-images export, exactly as on the browser. It is not a lossless database backup or a sync/import format; neither client exposes ZIP import.

## Drive and realtime integration

Android uses the shared Drive-authorized v3 operation runtime and a native Credential Manager identity token alongside Drive authorization. Its foreground lifecycle starts synchronization; backgrounding closes live rooms and stops scheduled polling. The app keeps local data and pending operations when offline. Configuration and the real-device test procedure are in [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md). Android-to-Firefox interoperability has not yet been verified on a physical device.

## Validation

At this revision 130 Android tests in 23 files pass, together with Android typecheck and the frontend build, and the extension suite passes 1,870 tests in 257 files.

The tests added for the later UI work cover the behaviour that changed, not just the wiring:

- `tests/boardTileCategory.check.tsx` — one accent per category, one shared hue for both project templates, and colour that no longer follows the first card.
- `tests/cardMenuIcons.check.tsx` — a distinct Material glyph per card action and per display mode, with the destructive row and disabled states preserved.
- `tests/cloudBoardLayout.check.tsx` — the share control anchored on the peer-status row, stable before and after role resolution, and an invitation form that cannot reflow that row.
- `tests/storage.check.ts` — category and colour derived from the template; terminal cards cannot become the preview or recolour a tile.
- `tests/navigation.check.tsx` — both view layouts, collapse/expand, and edits queued rather than dropped while a write is in flight.
- `tests/boardArchive.check.ts`, `tests/photoProcessing.check.ts` — Android archive parity with the shared builder and off-thread photo processing.

The layout work was additionally verified in Chromium at phone viewport in light and dark themes. Capacitor sync, the debug APK and Pixel 8a/API 36 device checks were not re-run for these changes; the device results recorded earlier in this file describe previous builds. Broader physical-device, TalkBack and large-board coverage remains useful before release.
