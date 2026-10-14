# Android local feature parity

Audited against `main` commit `85fcc08` (Download board), after rebasing `agent/cloud` onto the same commit. This audit covers the browser's local board/card features. Drive, sharing and WebRTC are a subsequent integration phase, rather than part of the offline parity claim.

| Browser feature | Android implementation |
| --- | --- |
| Create/select/rename/delete a board; change board template | Home overview and board editor, including deletion/type-conversion confirmations. Same repository/template definitions. |
| Manual board ordering | Settings controls call the same repository ordering API. Home additionally promotes the four most recently edited boards, as requested for Android. |
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
| Live local data, ordering, IDs and timestamps | Existing repository/schemas; snapshots are reactive. Reads, copying, exporting and preference changes never edit board timestamps. Text/status/mode/photo/reorder changes follow existing repository revision handling. |

## Excluded browser integration

Pin current page, pin a page's selected text/link, region/page screenshot capture, provider/content-script extraction, extension context menus, browser action/extension shortcuts, sidebar opening and browser minimum-width negotiation are excluded. Android's photo picker replaces desktop image-file dropping. Ordinary URLs contained in notes are retained; opening a saved link is distinct from capturing a web page.

## Intentional Android adaptations

The two-column home screen, native back, safe-area handling, fixed editor Save, touch dragging and colored mobile choosers remain. Secondary card actions live behind a single overflow button, never in the removed per-card action bar. Desktop middle-click insertion/duplication and Shift-drag merging are exposed as touch menu actions. Android swipes keep the requested bounded candidate → confirmed → started → to validate → done workflow; rejected/trash remain available through the chooser and full browser keyboard cycle. Status writes commit immediately rather than waiting for the desktop's status-move delay. A completion saved through Save-and-add opens the next draft; confetti is shown when returning to the board. Unsaved new cards are drafts until Save, rather than stored empty cards. Home tiles continue using text previews, while board cards show photos.

The ZIP is a prompt-and-images export, exactly as on the browser. It is not a lossless database backup or a sync/import format; neither client exposes ZIP import.

## Drive and WebRTC integration

Implemented through the shared platform-independent `src/sync/runtime.ts` and Android's native Google Identity Services authorization bridge. Android supports foreground Drive reconciliation, private board/photo snapshots, incoming shared-board discovery, editor/viewer invitations, permission-based write gates, account ordering/hidden-board preferences, shared images and project-scoped WebRTC replication. Settings exposes connection/retry/disconnection; a board exposes its role and connected peer count. Collaborator removal/role management remains in the extension UI. Google setup is documented in [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md).

Backgrounding stops live pools/signaling and future timers, with resume/online retry; no background service is included. Disconnect preserves local data. Data-channel connectivity has the same NAT/STUN limitations as the extension and no dedicated TURN deployment. Shared snapshot recovery has the same existing restriction: newer shared text merges through a live peer; Drive restores missing shared boards and image data. Cross-device Google authorization and real network replication require the registered Android OAuth client and signed-in test accounts.

## Validation

82 Android tests in 12 files and 399 extension tests in 60 files passed, along with both browser builds/verification and the debug APK build. Pixel 8a/API 36 checks covered preserved photos after rebase/update/restart, native clipboard, duplication, Markdown/checklists, confirmed-source merge into a photo card, stored text size, Save-and-add resetting/focusing the next draft, exact insertion order, download cancellation and an exported ZIP whose entries and CRC were verified. Native export adds no storage permission. Broader physical-device, TalkBack and large-board coverage remains useful before release.
