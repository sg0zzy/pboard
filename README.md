Licensed under the GNU General Public License v3.0. See LICENSE

# Pboard

Pboard is a local-first Firefox and Chromium extension that keeps the current state of a project alongside AI conversations and ordinary web research. Conversations remain the place for exploration; Pboard stores the goals, ideas, decisions, constraints, questions, risks, references, and notes that still matter.

Version 0.1 captures selected text and links from ordinary web pages, with a dedicated ChatGPT adapter where needed. It deliberately includes no account, backend, telemetry, AI API, or collaboration features. Captured content never leaves the browser.

The implemented product baseline and current limitations are recorded in [`SPECIFICATION.md`](SPECIFICATION.md).

## What works

- Create, select, and delete local projects.
- Create and rename projects from compact icons in the current-project title row.
- Open the project dropdown and drag its entries to persist a custom project order; use arrows, Enter, and Escape for keyboard selection.
- Choose Brainstorming, Idea, Project, or SW Project structure when creating a board, and change it later without losing card content.
- Use SW Project cards for Issues, Features, Decisions, Tasks, the Main Goal, and the Main Description.
- Press Escape to leave project creation without creating or changing a project.
- After creating a project, immediately type its first point in the automatically focused Add Card editor.
- Add, edit, type, status, delete, and drag cards to reorder them.
- Confirm deletion of protected cards and projects in an inline panel beside the affected item.
- Preview the exact insertion position with a placeholder while dragging a card.
- Press or release Shift at any time while dragging a text card to switch dynamically between reorder and merge; Escape cancels the drag.
- Select cards with Up/Down, edit the selected card with Enter, and reorder it with Ctrl+Shift+Up/Down (Command+Shift on macOS).
- On a focused card, Left/Right step its status through Candidate → Confirmed → Started → To validate → Done → Trashed → Rejected (wrapping), matching the status-menu order. Ctrl+Left/Ctrl+Right (Command+ on macOS) steps its category through the board template's categories.
- Use the `─`, `▫`, and `□` controls in a card header to show compact, standard, or expanded text. Press V on a focused, non-editing card to cycle those modes.
- Delete always moves a focused, non-editing card to its project's Trash, matching the trash icon; each project has its own Trash, and emptying the Trash (trash-can icon in the section title row) or deleting a trash card removes it permanently, with a confirmation.
- Done, Rejected, and Trash appear as collapsible containers in that visual order. Done and Rejected each have a copy button (copies all cards of that section in the same format as "Copy board") and a trash icon (trashes all cards of the section at once). This presentation order is independent from the unchanged keyboard status cycle.
- Middle-click a card to compose and insert a new card directly beneath it.
- Ctrl+middle-click a card to duplicate it directly beneath the original as a Candidate; Command+middle-click provides the same behavior on macOS.
- After saving an edited or middle-click-created card, press Enter again to open the next draft directly below it.
- Double-click a card to edit it; save with Enter or another double-click, and copy its text (tagged by category and status, e.g., `[issue] [confirmed]`) with the overlapping-sheets copy action.
- Use Ctrl+Enter while editing to save without arming the follow-up Enter shortcut that creates a card below; Command+Enter is the macOS equivalent.
- While editing a card, Tab and Shift+Tab cycle through its controls and text fields without leaving the card.
- Cancel card editing with Escape while keeping that card selected for continued keyboard navigation.
- Add a new card with Enter or a double-click; use Shift+Enter for multiline text.
- Keep entering points continuously: after each save the empty Add Card editor retains focus for the next card.
- Keep the active Add Card editor fully visible when working with long boards.
- Adjust and persist the board's text and control size with the −/+ buttons beside the Pboard heading.
- Optionally connect Google Drive from the top toolbar and asynchronously sync one versioned project snapshot per project to Drive's private app-data folder; local storage remains the immediate source of truth.
- Read a compact three-row project-status grid beneath the project title: Candidate/Confirmed, Started/To validate, and Done/Rejected. Cards keep deterministic hand-drawn cells using the existing status colors and symbols while a row fits; an overflowing row independently switches to ordered numeric status counts and expands again when space returns.
- Read the current board scale as a percentage between the size buttons; 100% is the default.
- Open web addresses in card titles, content, and source metadata as native browser links.
- Render simple card Markdown: `*`/`-` bullet lists, numbered lists, `**bold**`, `*italic*`, inline code, and `[label](url)` links.
- Turn `- [ ]` and `- [x]` task lines into clickable checkboxes whose state is persisted back into the card text.
- Scan semantic card types by accessible, template-specific colors while status remains a separate icon/pill treatment.
- Hide done, rejected, and trash cards in lightweight collapsed containers.
- Select text on any HTTP/HTTPS page and use **Pin selection to Pboard** from Firefox's context menu; the new card is added as **Uncategorized** and receives focus in the sidebar.
- Right-click an image on any HTTP/HTTPS page and choose **Pin image to Pboard** to save the visible image as a local image card with its source URL and page metadata.
- Pin selected text with `Alt+Shift+C` (**Capture**), or pin the current web page with `Alt+Shift+W`; both are left-hand shortcuts.
- Discover both shortcuts from the corresponding action labels in Firefox's context menu.
- Right-click a web link to pin its URL and visible label as a reference.
- Right-click an ordinary page area or use the pin icon in Firefox's address bar to pin the current page.
- Keep the source page URL on pinned cards.
- Use the board capture toolbar to create a new card, pin the current page, pin selected text, pin a selected or focused link, or capture a page region. Selection and link buttons are disabled when no matching page target is available. For region capture, drag a rectangle on the page or press Escape to cancel.
- Drop an image file anywhere on the board to add it as an image card.
- Image cards render the stored image above the card text; captures keep the source page URL and title.
- Copy the current board as a clean, structured prompt: ongoing cards in their board order, then Done cards, then Rejected cards. Trash is excluded; every exported card carries its category and status tags (e.g., `[issue] [confirmed]`).
- Persist all state in `browser.storage.local` across Firefox restarts.
- Reopen the Pboard sidebar from Firefox's toolbar button or `Alt+Shift+P`, even after it has been closed or replaced by another sidebar such as Bookmarks.

## Architecture

```text
Any HTTP/HTTPS page
  └─ Browser menu metadata (selection, link, image, or page URL)
ChatGPT page
  └─ isolated content script and ChatGptAdapter
            ⇅ WebExtension messaging
background/service worker (context menus, page action/action, and region capture)
            ⇅ browser.storage.local
React sidebar ─ project/card repository
```

Provider-specific page access lives in `src/providers`. The rest of the board knows only the shared `ChatProviderAdapter` contract, so another provider can be added without changing storage or sidebar code.

State is stored as one versioned object. Projects are application-owned; a conversation URL is optional source metadata on a card, never the owner of a project.

## Browser permissions

- `storage`: persist projects, cards, order, and the selected project locally.
- `menus` (Firefox) / `contextMenus` (Chromium): expose pin actions for selected text, links, images, and pages.
- `clipboardWrite`: copy the board prompt after an explicit button click.
- `activeTab`: temporarily access only the current tab after an explicit Pboard shortcut or menu action.
- `scripting`: read the current selection through a one-off script triggered by `Alt+Shift+C`, inspect selected text and focused links for the capture toolbar, and inject the short-lived region-capture overlay when region capture is used. The toolbar asks for optional page access if it cannot inspect selected text or links through `activeTab`; Chromium also needs optional access for region screenshots from the side panel.
- `identity`: run the optional Google OAuth authorization-code flow after an explicit **Connect Drive** action.
- `alarms`: schedule an optional dirty-project Drive sync after roughly 25 seconds of inactivity.
- Host access to `https://chatgpt.com/*` and `https://chat.openai.com/*`: load the selection adapter only on supported ChatGPT origins. Firefox region capture uses temporary `activeTab` access; Chromium `<all_urls>` access remains optional and is requested only when the camera is used.
- Host access to Google OAuth and Drive API endpoints: exchange/refresh the optional OAuth token and persist snapshots in `appDataFolder`; Pboard requests `drive.appdata` for private sync and the full `drive` scope for boards shared by other users (discovery and collaboration on files this account does not own; `drive.file` cannot reliably find incoming invitations).

No browsing-history permission or remote code is used. Unless the user explicitly connects Google Drive, pboard makes no cloud-sync requests. Generic pages receive no persistent content script; the selection shortcut runs only a one-off reader after the user's explicit keypress. The ChatGPT selection-capture content script still loads only on the two supported ChatGPT origins.

## Optional Google Drive sync

Google Drive support requires separate OAuth clients for Chromium and Firefox. Their public client IDs are set in `src/sync/googleDriveConfig.ts` (per browser, per stage); the Chromium production client ID and the `drive.appdata` and `drive` scopes are also declared in `manifest.chromium.json` for Chrome's native `identity.getAuthToken()` flow. Keep those two Chromium client-ID values identical. Firefox uses authorization-code PKCE with the loopback redirect derived from its fixed add-on ID (`http://127.0.0.1/mozoauth2/...`). If Google's Desktop OAuth client requires a client secret for Firefox token exchange, copy `.env.example` to the git-ignored `.env.local` and set `VITE_GOOGLE_DRIVE_FIREFOX_CLIENT_SECRET`; Vite embeds it in the extension bundle, so it must not be treated as a confidential server-side secret. `<stage>` is `dev` under `npm run dev` and `production` under `npm run build` / `build:chromium`.

The integration requests `https://www.googleapis.com/auth/drive.appdata` for private snapshots and the full `https://www.googleapis.com/auth/drive` scope for boards shared by other users, and explicitly shows Google's account selector. After upgrading from a build that requested only private sync access, reconnect Drive to grant sharing access. Access/refresh token state stays in extension-local storage. Project content continues to save locally first; Drive writes run asynchronously after manual sync, project switching, a debounced visibility loss, or about 25 seconds of dirty idle time. A Drive failure never rolls back local data.

Sharing searches explicitly use Drive's `drive` space; private sync searches use `appDataFolder`. If sharing reports `insufficientScopes`, reload the rebuilt extension, disconnect Drive with the cloud button, then use **Connect Drive** and allow both requested permissions. Chrome checks the granted scopes when available and reports incomplete authorization before using that token.

Firefox reconnects with fresh consent and replaces the refresh token for the new grant. It checks the token response's scopes when provided and rejects incomplete sharing authorization or a missing new refresh token, rather than reusing an older grant.

To use live collaboration between Firefox and Chrome on the same Google account, connect Drive in both browsers and open the same project. In **Share project**, choose **Enable live collaboration** once if the board is still private. This creates the shared Drive layout without inviting another email. Keep both sidebars open; the dialog shows whether it is waiting for another browser, connected, or encountering an error. Private Drive snapshot sync alone does not enable WebRTC. Connecting Drive or enabling sharing starts collaboration on the current board without requiring a project switch; another open browser discovers newly enabled sharing during its next access check (about ten seconds).

Project list reordering syncs over WebRTC between open sidebars connected to the same Google account, even when they display different or private projects. Each account has its own order; collaborators' orders and the selected project stay independent. Viewers can reorder their own project list. Account rendezvous records stay in private Drive app data, separate from shared project folders.

Shared image cards send their references over WebRTC and their image files through the shared Drive folder. Owners and editors upload images; viewers download them. Open boards fetch missing images and refresh cards automatically, including images added after the browsers connect. Image arrival may lag behind card text by a few seconds. Snapshot sync also restores missing images whose hashes match the current cards while preserving newer card text.

The Firefox build uses the native `sidebar_action`, a toolbar `action` that opens the Pboard sidebar, and the Firefox page action. The Chromium build uses the MV3 `side_panel` and `action` APIs. Shared code goes through `src/platform/browser.ts`, which normalizes the runtime namespace and context-menu namespace.

## Develop and build

Requirements: Node.js 20 or newer and npm. Firefox 126+ and Chromium-based browsers with Side Panel support (Chrome/Chromium 114+, including current releases) are supported.

```bash
npm install
npm run check
npm run build:all
```

`npm run check` runs strict TypeScript checking, the shared test suite, both production builds, and a lightweight verification of both generated manifests and bundles. `npm run build` writes the Firefox package to `dist/`; `npm run build:chromium` writes the Chromium package to `dist/chromium/`; `npm run build:all` creates both. The tests and build verification are development-only and add no runtime code to the extension. The background and content entries are separately bundled as classic IIFEs so they work as Firefox background scripts or a Chromium MV3 service worker.

Build verification also starts each production background bundle with mocked browser APIs and without Node globals, checking that its event handlers register successfully. This catches browser-incompatible dependency imports that can pass unit tests and still prevent the extension from starting.

For a single verified build, use `npm run release:firefox` or `npm run release:chromium`. These commands run typechecking and tests first, then build and verify only the selected browser package. `npm run release:all` does the same for both.

For sidebar-only visual development:

```bash
npm run dev
```

The development page can render the UI, but WebExtension storage APIs are available only when loaded as an extension.

## Install temporarily in Firefox

1. Run `npm install` and `npm run build`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Choose **Load Temporary Add-on…**.
4. Select `dist/manifest.json`.
5. Open the extension sidebar from **View → Sidebar → Pboard** (or Firefox's sidebar picker).
6. Create a project, open any web page, select text, right-click, and choose **Pin selection to Pboard**.

The default shortcuts are `Alt+Shift+C` for capturing selected text, `Alt+Shift+W` for the current page, and `Alt+Shift+P` to open the Pboard sidebar. They can be reassigned from Firefox's **Manage Extension Shortcuts** screen.

Temporary add-ons are removed when Firefox restarts. Reload the add-on from the same debugging page after rebuilding.

## Load temporarily in Chrome/Chromium

1. Run `npm run build:chromium`.
2. Open `chrome://extensions` (or the equivalent `*-extensions` page).
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `dist/chromium/`.
5. Pin/open Pboard from the browser's side-panel toolbar button. On supported Chromium versions, the extension action opens the Pboard side panel.

The Chromium package intentionally has a separate manifest: Chrome uses `side_panel`, `action`, `contextMenus`, and a service worker, while Firefox uses `sidebar_action`, `page_action`, `menus`, and background scripts. No Chrome-specific code is required in the sidebar or storage layer.

## Tests

```bash
npm test
npm run typecheck
npm run build
npm run build:chromium
npm run verify:build
```

Tests cover project creation/deletion and persistence, card creation/editing/deletion/reordering, image persistence and sizing, capture-region cropping, prompt serialization, selection messaging, generic web selections and links, source metadata, missing projects, unsupported hosts, and missing provider selections. Generic capture uses Firefox's context-menu metadata; ChatGPT selection capture uses the standard browser Selection API rather than provider-specific message selectors.

## Repository map

```text
src/background/   context-menu orchestration
src/content/      content-script message handling
src/images/       image decoding, cropping, and scaling
src/messaging/    typed message contracts
src/providers/    isolated provider adapters
src/sidebar/      React board UI and prompt serialization
src/storage/      browser storage adapter and domain repository
src/types/        extensible project and board item types
tests/            domain, serialization, messaging, and adapter tests
```

## Privacy

All project and card data is written to local extension storage first. If the user explicitly connects Google Drive, versioned per-project snapshots are also sent asynchronously to that account's private app-data folder. Pboard has no telemetry. Text and URLs are stored only after the user explicitly invokes a pin action from the toolbar, context menu, shortcut, or address bar.
