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
- On a focused card, Left/Right step its status through the non-trash statuses (Candidate → Confirmed → Rejected → Started → Done, wrapping), and Ctrl+Left/Ctrl+Right (Command+ on macOS) steps its category through the board template's categories.
- Delete always moves a focused, non-editing card to its project's Trash, matching the trash icon; each project has its own Trash, and emptying the Trash (trash-can icon in the section title row) or deleting a trash card removes it permanently, with a confirmation.
- The Rejected and Done section title rows each have a copy button (copies all cards of that section in the same format as "Copy board") and a trash icon (trashes all cards of the section at once).
- Middle-click a card to compose and insert a new card directly beneath it.
- Ctrl+middle-click a card to duplicate it directly beneath the original as a Candidate; Command+middle-click provides the same behavior on macOS.
- After saving an edited or middle-click-created card, press Enter again to open the next draft directly below it.
- Double-click a card to edit it; save with Enter or another double-click, and copy its text (tagged by category and status, e.g., `[issue] [confirmed]`) with the overlapping-sheets copy action.
- Use Ctrl+Enter while editing to save without arming the follow-up Enter shortcut that creates a card below; Command+Enter is the macOS equivalent.
- Cancel card editing with Escape while keeping that card selected for continued keyboard navigation.
- Add a new card with Enter or a double-click; use Shift+Enter for multiline text.
- Keep entering points continuously: after each save the empty Add Card editor retains focus for the next card.
- Keep the active Add Card editor fully visible when working with long boards.
- Adjust and persist the board's text and control size with the −/+ buttons beside the Pboard heading.
- Read the current board scale as a percentage between the size buttons; 100% is the default.
- Open web addresses in card titles, content, and source metadata as native browser links.
- Render simple card Markdown: `*`/`-` bullet lists, numbered lists, `**bold**`, `*italic*`, inline code, and `[label](url)` links.
- Turn `- [ ]` and `- [x]` task lines into clickable checkboxes whose state is persisted back into the card text.
- Scan semantic card types by accessible, template-specific colors while status remains a separate icon/pill treatment.
- Hide rejected and done cards in collapsed sections.
- Select text on any HTTP/HTTPS page and use **Pin selection to Pboard** from Firefox's context menu; the new card is added as **Uncategorized** and receives focus in the sidebar.
- Right-click an image on any HTTP/HTTPS page and choose **Pin image to Pboard** to save the visible image as a local image card with its source URL and page metadata.
- Pin selected text with `Alt+Shift+C` (**Capture**), or pin the current web page with `Alt+Shift+W`; both are left-hand shortcuts.
- Discover both shortcuts from the corresponding action labels in Firefox's context menu.
- Right-click a web link to pin its URL and visible label as a reference.
- Right-click an ordinary page area or use the pin icon in Firefox's address bar to pin the current page.
- Keep the source page URL on pinned cards.
- Capture part of the current page as an image card with the camera button beside **Add card**: drag a rectangle on the page, or press Escape to cancel.
- Drop an image file anywhere on the board to add it as an image card.
- Image cards render the stored image above the card text; captures keep the source page URL and title.
- Copy the current non-rejected, non-trash board as a clean, structured prompt; every card carries its category and status tags (e.g., `[issue] [confirmed]`).
- Persist all state in `browser.storage.local` across Firefox restarts.

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
- `scripting`: read the current selection through a one-off script triggered by `Alt+Shift+C`, and inject the short-lived region-capture overlay when the camera button is used.
- Host access to `https://chatgpt.com/*` and `https://chat.openai.com/*`: load the selection adapter only on supported ChatGPT origins. Region capture uses temporary `activeTab` access instead of broad host access.

No browsing-history permission, remote code, or network endpoint is used. Generic pages receive no persistent content script; the selection shortcut runs only a one-off reader after the user's explicit keypress. The ChatGPT selection-capture content script still loads only on the two supported ChatGPT origins.

The Firefox build uses the native `sidebar_action` and Firefox page action. The Chromium build uses the MV3 `side_panel` and `action` APIs. Shared code goes through `src/platform/browser.ts`, which normalizes the runtime namespace and context-menu namespace.

## Develop and build

Requirements: Node.js 20 or newer and npm. Firefox 126+ and Chromium-based browsers with Side Panel support (Chrome/Chromium 114+, including current releases) are supported.

```bash
npm install
npm run check
npm run build:all
```

`npm run check` runs strict TypeScript checking, the test suite, and the Firefox production build. `npm run build` writes the Firefox package to `dist/`; `npm run build:chromium` writes the Chromium package to `dist/chromium/`; `npm run build:all` creates both. The background and content entries are separately bundled as classic IIFEs so they work as Firefox background scripts or a Chromium MV3 service worker.

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

The default shortcuts are `Alt+Shift+C` for capturing selected text and `Alt+Shift+W` for the current page. They can be reassigned from Firefox's **Manage Extension Shortcuts** screen.

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

All project and card data stays in Firefox's local extension storage. Version 0.1 makes no external requests and has no telemetry. Text and URLs are captured only after the user explicitly invokes a context-menu or address-bar pin action.
