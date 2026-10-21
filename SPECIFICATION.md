# Pboard — Product Specification

**Package version at review:** 0.9.4

**Reviewed:** 2026-10-14

**Status:** Implemented local-first extension with optional Drive sync and collaboration

This document records the behavior currently implemented in the repository. It is a baseline for development and debugging, not a description of unbuilt future features.

## 1. Product purpose

Pboard is a local-first Firefox and Chromium extension that keeps structured project state beside AI conversations and ordinary web research.

The product separates two concepts:

- **Conversation history** is the process used to explore a problem.
- **Project state** is the set of points the user currently wants to retain.

The current workflow is:

```text
Discuss in ChatGPT → Pin selected text → Refine and reorder cards → Copy board as a prompt
```

## 2. Supported environment

- Firefox and Chromium WebExtensions using Manifest V3.
- Minimum declared Firefox version: 142; minimum Chromium version: 114.
- Firefox uses `sidebar_action` and background scripts; Chromium uses `side_panel` and an MV3 service worker.
- Sidebar UI implemented with React and TypeScript.
- Chat selection capture supported on:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- `.nvmrc` selects Node.js major version 24 for local builds.

### 2.1 Board display size

- Compact − and + controls appear to the right of the **Pboard** heading.
- The current ratio is displayed between the controls as 80%, 90%, 100%, 110%, 120%, or 130%; 100% is the default.
- Six size steps are available, from 80% through 130% of the default.
- Text, headings, card labels, status controls, drag handles, and action icons scale together.
- The controls are disabled at their minimum and maximum values.
- The selected size is stored in `browser.storage.local` under `projectBoardUiScale` and is restored when the sidebar reopens.

## 3. Projects

The sidebar supports multiple independent projects.

Implemented behavior:

- The initial state contains no projects.
- A user can create a project with a non-empty name.
- Project creation requires choosing one of the four board templates.
- Pressing Escape anywhere in the New Project form closes it, discards its temporary name/template selection, and leaves stored project data unchanged.
- After successful project creation, the Add Card editor opens automatically and receives focus so the next typed text can be submitted as the first card with Enter.
- A newly created project becomes the current project.
- A user can switch projects with a custom dropdown selector styled like the previous compact project control.
- Projects can be dragged directly inside the open dropdown to change their persistent order; an insertion line previews the destination.
- The dropdown supports Up/Down and Home/End navigation, Enter selection, Escape dismissal, and closing by clicking outside it.
- Reordering does not change the current project or board content. The RxDB repository stores an account-specific project-order preference, synchronized through private Drive app data and a dedicated WebRTC settings pool when connected. Selection stays local.
- A folder-plus icon in the project-title row opens and closes the New Project form, replacing the previous separate text action.
- A pencil icon replaces the project selector with a focused inline name field; Enter persists a non-empty trimmed name and Escape cancels without changes.
- The selected project is global to the extension; it is not tied to the current ChatGPT conversation.
- A user can delete the current project after confirming the destructive action in a panel directly beneath the project row.
- The project confirmation panel participates in layout and never covers the project selector.
- Confirming closes the panel immediately: the account removal marker and the current-project switch commit before Drive ownership is verified, so the board disappears without waiting for network work.
- Owners delete project content and tombstone its cards. Editors and viewers can remove shared projects from their own account list without deleting the owner's content. If ownership of a known shared project cannot be verified, removal affects only the account list.
- When the selected project is deleted, the first remaining project becomes current; otherwise no project is selected.
- Ownership verification and the per-card tombstone pass continue in the background; a failure there is reported as a notice and does not undo the committed account removal.
- A project's template can be changed after creation without deleting any cards.
- Changing a template remaps cards whose type the new template does not support to `note`.

Project data:

```typescript
type Project = {
  id: string;
  name: string;
  template: "brainstorming" | "idea" | "project" | "software_project";
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

### 3.1 Board templates

Templates are configuration-driven through `src/templates/boardTemplates.ts`. Each definition supplies its display name, description, supported card types, default card type, prompt behavior, labels, and semantic colors.

The original three templates represent increasing structure, with SW Project as a specialized operational variant:

```text
Brainstorming → no semantic structure
Idea          → exploratory semantic structure
Project       → decision and execution structure
SW Project    → software product and implementation structure
```

#### Brainstorming

- Description: **Free-form notes, no categories.**
- Every card uses the generic `note` type.
- The card-type selector is hidden.
- Cards use a neutral gray treatment.
- Prompt output does not add repetitive `NOTE` headings.

#### Idea

- Description: **Light structure for exploring and refining ideas.**
- Available semantic types: Core Idea, Opportunity, Question, Risk, Constraint, and Reference.
- Uncategorized is also available as a safe, non-forced fallback and is the default for new or pinned cards.
- Types use restrained blue, green, yellow, red, purple, and blue-gray accents.

#### Project

- Description: **Structured board for goals, decisions, risks and next steps.**
- Available semantic types: Goal, Decision, Task / Next Step, Constraint, Open Question, Risk / Blocker, and Reference.
- Uncategorized is also available as a safe fallback and is the default for new or pinned cards.
- Types use restrained blue, green, teal, purple, yellow, red, and blue-gray accents.

#### SW Project

- Description: **Software goals, product work, issues and implementation tasks.**
- Available semantic types: Issue, Feature, Decision, Task, Main Goal, and Main Description.
- New manually added and pinned cards default to Task; Uncategorized remains available as a safe fallback when changing templates.
- Types use restrained red, green, purple, teal, blue, and blue-gray accents, while status remains visually independent.

#### Changing templates

- The sidebar exposes a board-type selector for the current project.
- Types supported by both the old and new template are preserved.
- Unsupported types are converted to `note`, displayed as **Uncategorized**.
- Before remapping, the user sees how many cards are affected and may cancel.
- Card content, title, status, source metadata, and order are never discarded.
- Legacy version-1 projects are presented as Project boards; legacy card types remain intact until the user explicitly remaps them.

## 4. Board cards

A project can contain any number of ordered cards.

Implemented behavior:

- Cards can be created manually from the sidebar.
- The primary manual action is labelled **Add card** rather than Add point.
- In the Add Card editor, Enter or a double-click creates the card, Shift+Enter inserts a newline, and Escape cancels; the visible Add button remains available.
- After a card is created, the Add Card editor stays open, clears only the saved draft, and restores focus so the user can immediately type and submit another card.
- On long boards, opening the Add Card editor or inserting a card scrolls the minimum necessary distance to keep the complete active form inside the sidebar viewport.
- Middle-clicking a card surface opens a focused inline draft directly below that card.
- Ctrl+middle-click duplicates the card directly below it; Command+middle-click is the macOS equivalent.
- Duplication preserves title, content, template type, and source metadata while assigning a new ID and timestamps; the duplicate always starts with Candidate status regardless of the original status.
- Modifier-middle-clicks on native links retain Firefox's link behavior and never duplicate a card.
- The inline draft uses Enter or double-click to save, Shift+Enter for a newline, and Escape to cancel.
- After saving an inline draft, the resulting card receives keyboard focus; a second Enter opens another inline draft directly below it.
- The saved card receives the next order position immediately after the clicked card; later cards are shifted without being rewritten.
- Middle-clicking a native link retains Firefox's open-in-new-tab behavior and does not open an inline draft.
- Cards inserted in the Rejected section inherit rejected status so they remain directly below their target; other inserted cards default to Candidate.
- Manually created cards default to type `note` and status `candidate`.
- Cards enter inline editing when the user double-clicks their title or content area.
- While editing, Enter saves, Shift+Enter inserts a newline, Escape cancels, and another double-click saves.
- While editing, keeping the left mouse button pressed on a word selects that word in the title or content field. The selection stays after the button is released.
- The word under the pointer is the one the browser caret rests on, so a press just after a word still selects that word.
- Moving the pointer while the button is held cancels the word selection and leaves the ordinary drag-selection behavior untouched.
- The second click of a double-click never starts a word selection, so the double-click that saves the card keeps working.
- While editing, Tab and Shift+Tab cycle through the card's controls and text fields, wrapping within the card.
- Ctrl+Enter saves without arming creation of a new card below; Command+Enter is the macOS equivalent. The next Enter therefore edits the same selected card again.
- Cancelling an edit with Escape restores focus to the same selected card, allowing immediate arrow navigation or Enter-to-edit without selecting it again.
- After an existing card is saved, focus returns to that card and a second Enter opens a new inline draft directly beneath it.
- No persistent Edit or Save button is shown on a card.
- A card may have an optional title.
- A card may carry an optional image, added by page region capture or by dropping an image file onto the board. The processed WebP is scaled so its longest side is at most 1400 px, stored as a hash-addressed Blob in the default backend, and rendered above the card text. Legacy storage and Drive snapshots use data URLs at the compatibility boundary.
- Dropped image files larger than 20 MB or files that are not images are rejected with a visible notice and do not change the board.
- Card content must not be empty.
- A user with editing rights can change a card's type and status.
- The card-type selector is a custom dropdown menu in the card's top line rather than a native select. The open menu shows every category with a color swatch in that category's semantic color, and the current category is marked bold with a check. Up/Down and Home/End navigate the open menu, Enter selects, and Escape or clicking outside closes it and returns focus to the selector.
- Cards can be deleted.
- Deleting any card always moves it to its project's Trash without confirmation; the card is recoverable by changing its status back, and each project has its own Trash.
- Removing a card that is already in Trash, or emptying the Trash, permanently removes it after a confirmation panel.
- Confirmation panels focus Cancel by default and may be dismissed with Escape.
- A trash-can icon replaces the textual Delete action and retains an accessible label and tooltip.
- A conventional overlapping-sheets icon copies the card's optional title and content prefixed by its category and status tags (for example, `[issue] [confirmed]`), without order or source metadata.
- The copy icon temporarily becomes a check mark after a successful copy.
- Copy buttons in the **Rejected** and **Done** section title rows copy all cards of that section to the clipboard in the same format as the full board copy.
- Card content and its compact action row use minimal vertical spacing so short cards remain easy to scan in long boards.
- Card display supports a deliberately small Markdown subset: lines beginning with `* ` or `- ` become bullet lists; numbered lines such as `1. ` become ordered lists; `**text**`, `*text*`, and backticks render bold, italic, and inline code; `[text](url)` renders a labelled link.
- Lines beginning with `- [ ]` or `- [x]` render as unchecked or checked task boxes. Clicking a checkbox updates that exact marker in the stored card content, so its state persists and is preserved by card/board copying; completed task text is visually struck through.
- Markdown is presentation-only. Editing always exposes and preserves the original plain-text syntax, and no HTML input is interpreted.
- HTTP, HTTPS, and `www.` addresses in card titles and content are rendered as native links.
- Stored source-conversation badges are links when they contain a valid HTTP or HTTPS address.
- Links open in a browser tab and retain Firefox's native middle-click and context-menu actions.
- Non-web protocols are not converted into links.
- Cards can be reordered with native drag-and-drop.
- While dragging, the original card is visually subdued and a dashed card-shaped placeholder previews whether it will be inserted before or after the card under the pointer.
- The placeholder updates as the pointer crosses the vertical midpoint of a target card.
- The visible placeholder remains a live drop target, so releasing the pointer over the preview completes the reorder.
- The active, Rejected, and Done sections each accept reorder previews only from their own section, preventing a misleading cross-section placement.
- Card sorting and merging use a custom Pointer Events layer rather than native HTML card dragging. This keeps behavior consistent across browsers and permits dynamic feedback while dragging; native file drag-and-drop remains separate for adding images.
- Pressing Shift before or during a card drag switches from reorder to merge mode; releasing it switches back to reorder. The floating preview and destination card become orange, gray reorder placeholders disappear, the destination grows slightly and displays **MERGE HERE**. Escape cancels an active drag.
- On merge, the dragged card is the source. Its optional title and content are appended to the destination content after a blank line, then the source card is tombstoned in the default backend and hidden from the visible order.
- The destination retains its ID, title, type, status, image, source metadata, position, and creation timestamp; only its content and update timestamp change.
- Consuming a Confirmed source requires confirmation in an inline panel beneath that source card.
- A source card containing an image cannot be merged in this version because the destination model supports only one image; the board shows a notice and leaves both cards unchanged.
- A focused card is visibly selected. Up and Down move selection through cards in the same active, rejected, or done section.
- Enter starts editing the selected card. Immediately after saving a card, the existing second-Enter shortcut retains its special behavior and opens a draft below it.
- Ctrl+Shift+Up and Ctrl+Shift+Down reorder the selected card by one position; Command+Shift+Up/Down provides the macOS equivalent.
- Left and Right cycle the card status in the same order shown by the menu: Candidate, Confirmed, Started, To validate, Done, Trashed, and Rejected. Right moves forward, Left moves backward, and both wrap at the ends.
- Ctrl+Left and Ctrl+Right step the card type through the categories supported by the board template in order, Command+Left/Right providing the macOS equivalent; single-category templates such as Brainstorming have no effect.
- V cycles the focused, non-editing card through Compact, Standard, and Expanded display modes. The same modes are directly selectable from the `─`, `▫`, and `□` header controls.
- Status changes made through the status menu or the Left/Right arrow keys are visually staged: the card's status chip and pill update immediately, but the card moves to its new section after a short pause (~800ms).
- Moving a card out of the visible section into the Rejected, Done, or Trash section moves focus to the next visible card in the list, or clears focus if there is no successor; moving back into the visible section keeps focus on the moved card. Sections are uncontrolled, so a status change never opens or closes one.
- Clicking the trash icon (or pressing Delete on a focused, non-editing card) always moves the card to that project's Trash immediately, without the staged pause, cancelling any still-pending staged status change for that card; the move is undoable by changing its status back. Emptying the trash and removing a card from Trash require the confirmation panel.
- Deleting a card that is already in Trash removes it permanently.
- Deleting a card normalizes the remaining order values.
- Done cards are placed in a collapsed **Done** container.
- Rejected cards are placed in a collapsed **Rejected** container.
- Each **Rejected** and **Done** section title row also holds a trash button that moves every card of the section to the project's Trash at once.
- Trash cards are placed in a collapsed **Trash** container, unique per project; a trash-can icon in the section title row opens the empty-trash confirmation panel, which permanently removes all trash cards of that project.
- The terminal containers are presented as **Done**, **Rejected**, then **Trash**. This visual order is independent from the canonical status-menu and keyboard-cycling order.
- Card changes update the card's `updatedAt` timestamp.
- Card creation, deletion, status and category changes replicate live between two sessions of the same account over WebRTC, in both directions; see `docs/collaboration.md`.

Supported card types are supplied by the selected board template rather than a global UI list. The storage union includes the current template types plus the legacy `idea` value so older data can be preserved.

Supported statuses:

- `candidate`
- `confirmed`
- `started`
- `to validate`
- `done`
- `trash`
- `rejected`

Status semantics:

- Status is board metadata controlled by users with editing rights, synchronized when connected, and independent from card type.
- Candidate is proposed, Confirmed is accepted and ready, Started is active work, To validate is implementation-complete but awaiting review or acceptance, Done is validated, and Rejected is discarded.
- The status selector presents the states compactly in the canonical order Candidate, Confirmed, Started, To validate, Done, Trashed, Rejected; the same order drives Left/Right cycling.
- Semantic type is shown with a subtle colored top border and label chip.
- Status is shown separately with `○`, `●`, `▶`, `◐`, `✓`, `–` (Trashed), or `×` and its own pill/border treatment; semantic card color does not encode status.
- **Confirmed does not send the card to ChatGPT.**
- Changing status does not start an AI operation or modify a conversation.
- Rejected and trash cards remain stored and editable for users with editing rights. Rejected cards are included in the copied board's Rejected section; Trash is excluded. Trash cards can be restored by changing their status.

Card data:

```typescript
type BoardItem = {
  id: string;
  projectId: string;
  type:
    | "note"
    | "core_idea"
    | "opportunity"
    | "idea"
    | "goal"
    | "decision"
    | "task"
    | "issue"
    | "feature"
    | "main_goal"
    | "main_description"
    | "constraint"
    | "question"
    | "risk"
    | "reference";
  title?: string;
  content: string;
  image?: {
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
  };
  status: "candidate" | "confirmed" | "started" | "to validate" | "done" | "rejected" | "trash";
  displayMode?: "compact" | "standard" | "expanded";
  order: number;
  source?: {
    provider?: string;
    conversationUrl?: string;
    sourceText?: string;
  };
  createdAt: string;
  updatedAt: string;
};
```

## 5. Pinning from web pages

The extension provides a one-way capture flow from any ordinary HTTP/HTTPS page to the current board. Generic sites receive no persistent content script; shortcut capture uses a one-off selection reader only after an explicit keypress.

User flow:

1. Select text on an HTTP/HTTPS page.
2. Open Firefox's context menu.
3. Choose **Pin selection to Pboard**.
4. The text is added to the currently selected project.

Keyboard flow:

- `Alt+Shift+C` (**Capture**) pins the selected text from the active page without conflicting with Firefox's existing `Alt+Shift+S` binding.
- `Alt+Shift+W` pins the active page URL and title.
- Both combinations use only left-hand letter keys and can be reassigned in Firefox's Manage Extension Shortcuts screen.
- The context-menu labels show the corresponding default shortcuts in parentheses so the keyboard actions are discoverable.
- The selection shortcut reads accessible frames and uses the first non-empty selection. Restricted browser pages fail safely without changing the board.

Pinned-card behavior:

- The card uses the `note` type, shown as **Uncategorized** (as **Note** on Brainstorming boards).
- The card status is `candidate`.
- After a successful pin, the sidebar focuses the newly created card and scrolls it into view.
- The selected text becomes both the card content and `source.sourceText`.
- The provider is stored as `chatgpt`.
- On non-ChatGPT pages, the provider is stored as `web`.
- The active tab URL is stored as `source.conversationUrl` when available.
- The card is appended after existing cards in the project.
- A current project must exist before text can be pinned.

Robustness behavior:

- Selection is read through the standard browser Selection API rather than ChatGPT message selectors.
- Selected text inside an active input or textarea is also supported.
- If content-script capture fails, Firefox's context-menu `selectionText` and tab URL are used as a fallback.
- Unsupported pages and empty selections fail without changing stored board data.
- Provider-specific behavior is isolated in `src/providers/chatgpt.ts`.

Link and page behavior:

- Right-clicking a link exposes **Pin link to Pboard**.
- A pinned link stores its URL as content, its visible link text as an optional title, and the containing page as source metadata.
- Right-clicking an image exposes **Pin image to Pboard**. Pboard captures the visible image rectangle through temporary active-tab access, stores it locally as a resized image card, and keeps the image URL, page URL, and alt text when available.
- **Pin current page to Pboard** appears for ordinary page, selection, and link context menus, so a page can be captured without dismissing the current context.
- A pin page-action icon is shown inside Firefox's address bar on HTTP/HTTPS pages and stores the loaded page URL and title.
- Link and page cards request the `reference` type; Brainstorming safely converts this to its generic `note` type.
- Only HTTP and HTTPS resources are accepted.
- Firefox does not expose selected or uncommitted text inside its privileged address bar to WebExtension context menus. The address-bar button therefore pins the currently loaded page, not arbitrary text typed into the URL bar.

### Page region capture

The board capture toolbar presents **New card**, a vertical separator, **Pin current page**, **Pin selected text**, **Pin link**, and **Capture region**, in that order. Each action has an icon, an accessible label, and a tooltip. Selected text and link buttons are disabled when the page has no matching target; a link target is a selected or focused hyperlink. The pin buttons use the same background pin handlers as context menus and shortcuts.

Implemented behavior:

- Clicking **Capture region** injects a short-lived overlay into the active tab. The user drags a rectangle over the page; the rectangle is previewed live and Escape cancels.
- On release, the visible tab is screenshotted, the selected rectangle is cropped and scaled (longest side at most 1400 px, encoded as WebP), and an image card is created in the current project.
- The captured page URL and title are stored as the card's source metadata and optional title; the card content is **Page capture**.
- Drag distances under 8 px are treated as a cancellation. Pointer cancellation removes the overlay and resolves the capture as cancelled, so the sidebar never stays in a capturing state.
- If the active tab navigates or changes between the drag and the screenshot, the capture is rejected with a visible notice instead of storing a misaligned image.
- Pages that cannot be scripted (browser UI, PDF viewer, and similar privileged pages) fail with a page-specific notice and do not change the board.
- A current project must exist before a capture can be stored.

## 6. Copy board as prompt

The sidebar provides a prominent **Copy board** button, with the same overlapping-sheets icon used by card copy actions, for the current project, paired with a **Download board** button directly to its right. Its clipboard output is a structured prompt in which every card is prefixed by a `[category]` tag.

Implemented behavior:

- Both buttons are disabled when there are no non-trash cards.
- Ongoing cards (candidate, confirmed, started, and to-validate) are serialized in their current board order, followed by Done cards and then Rejected cards. Each section retains its own board order.
- Trash cards are excluded.
- Every card is prefixed with its category id and status tags in square brackets (for example, `[issue] [confirmed]`); legacy `idea` types are exported as `[core_idea]`.
- An optional card title appears after the status tag and before the content.
- The resulting text is written to the clipboard.
- The sidebar displays a temporary success notice.

Example:

```text
PROJECT: AI brainstorming SaaS

[goal] [candidate] Create a lightweight tool for developing ideas with AI.

[decision] [confirmed] Use a browser sidebar.
```

### Download board as zip

The **Download board** button (arrow-into-tray icon) exports the current project as a zip archive:

- `board.txt` contains exactly the same prompt text the **Copy board** button writes to the clipboard.
- `board.json` contains versioned card metadata for importing the board, including template, titles, display modes, order, source references and image associations. It excludes collaboration credentials and signatures.
- `images/` contains one file per card image the board displays (the same pictures the cards render), named after the card id with an extension derived from the stored mime type. Trash cards are excluded, and an image shared by several cards is stored once. A card whose image data is missing is skipped so the text export never fails.
- The archive is named after the project (its name slugged for the filesystem, falling back to `board.zip`).
- The browser download starts only once the whole zip is complete in memory, so the downloaded file always contains the txt and every image that was loaded in the cards.
- The sidebar displays a temporary success notice; a failure is reported as a notice and starts no download.

**Import pboard** opens a ZIP file picker, including when no board exists. It validates the archive before writing and creates a new local board with fresh board/card identities. Existing boards and collaboration authority are preserved. Current archives restore structured cards and images; older `board.txt`/`images/` archives restore combined title/text and attach images as separate cards because those files did not record associations or the board template. Legacy category tags are used to infer a template; card-looking text inside old prompts can be ambiguous. Trash and unavailable image bytes cannot be recovered from an export that omitted them. Imports are limited to 25 MB compressed, 64 MB expanded and 1,000 cards. RxDB is required; the legacy fallback backend reports an error without importing. A storage failure may leave a partial new board, which is retained and reported rather than automatically deleted. Imports restore content, not synchronization history, conflict variants or authority keys.

Copying is currently the only implemented board-to-chat workflow. The user must paste the generated prompt into ChatGPT or another AI application manually.


## 7. Persistence and synchronization

The default repository stores projects, cards, and settings in RxDB using the free Dexie/IndexedDB backend. Images are hash-addressed Blobs in the separate `pboard-images-v1` IndexedDB database. The sidebar subscribes to project lists, current selection, and the active project's cards rather than reloading the entire application state.

The legacy `browser.storage.local` repository remains available for fallback and rollback. Its `projectBoardState` key contains AppState version 3 (`projects`, `boardItems`, and `currentProjectId`). First opening RxDB imports and verifies that state without deleting the original. Migration failure falls back to legacy storage. See [local storage architecture](docs/rxdb-storage-refactor.md) for migration, ordering, rollback, and retained deletion records.

Projects belong to Pboard; conversation URLs are optional source metadata. Local writes complete before Drive requests, and synchronization failures preserve dirty local data. Private projects use versioned per-project snapshots in Drive's hidden `appDataFolder`, with whole-project timestamp conflict resolution. Dirty projects sync manually, when leaving a project, after debounced visibility loss, or after roughly 25 seconds of inactivity.

Shared boards use a visible owner-managed Drive folder with `project.json`, image assets, and signaling records. Drive folder permissions define owner/editor/viewer roles. Invited boards are discovered and imported while connected. Owners and editors back up pending shared changes without importing a whole remote snapshot over existing live documents; viewers can restore matching image bytes. A newer remote shared backup is reported as a conflict instead of overwritten.

Live collaboration replicates project and card documents through separate WebRTC pools for the active shared board. Document conflicts use last write wins on `max(updatedAt, deletedAt)`, with master state winning ties. Account project order and permanent removal markers synchronize separately, both over WebRTC and private Drive preferences; current selection stays local. See [collaboration architecture](docs/collaboration.md) for scoping, role enforcement, signaling, and security limits.

## 8. Extension architecture

```text
Page capture / ChatGPT selection adapter
  └─ WebExtension messaging → background capture handlers
                              ⇅ repository selector
React sidebar subscriptions ⇄ RxDB + IndexedDB image Blobs (default)
                              └─ browser.storage.local AppState (legacy fallback)
                              ├─ private Drive snapshots + account preferences
                              └─ shared Drive folders + WebRTC document replication
```

Code boundaries:

- `src/background/`: context-menu orchestration and pin handler.
- `src/content/`: content-script message handling and selection capture.
- `src/images/`: image decoding, region cropping, and scaling.
- `src/messaging/`: typed WebExtension message contracts.
- `src/providers/`: provider-specific page access behind a shared adapter.
- `src/sidebar/`: React UI, card component, styling, and prompt serialization.
- `src/storage/`: RxDB repository, legacy adapter, migration, ordering, and image Blob store.
- `src/collab/`: WebRTC lifecycle, signaling, project scoping, and shared image sync.
- `src/sync/`: Google OAuth/PKCE, Drive transport, snapshot serialization, and sync state.
- `src/templates/`: declarative template, type-label, and semantic-color configuration.
- `src/types/`: shared domain types.

## 9. Permissions and privacy

Declared permissions:

- `storage`: save projects, cards, order, and current-project selection.
- `menus`: add selection, link, and page pin actions.
- `clipboardWrite`: copy either a serialized board or one card's text after a user action.
- `scripting`: read the current selection through a one-off script and inject the short-lived region-capture overlay on demand.
- `activeTab`: temporary current-tab access after an explicit Pboard shortcut or menu action.
- `identity`: optional Google OAuth after an explicit toolbar action.
- `alarms`: background scheduling for dirty-project Drive snapshots.
- Host access covers the two supported ChatGPT origins plus the Google OAuth token and Drive API endpoints used only by optional sync. Firefox page-region capture uses temporary `activeTab` permission. Chromium requests optional `<all_urls>` access when the camera is first used because side-panel clicks do not grant the `activeTab` access required by `captureVisibleTab()`.
- Generic sites receive no content script; their selected text and URLs come from Firefox's user-invoked menu event or the user-invoked capture overlay.

Privacy properties:

- Google authentication and Drive synchronization are optional and user-initiated.
- Google scopes are `drive.appdata` for private backups/preferences and full `drive` for incoming shared-board discovery, shared files, and permissions. Shared content lives in visible Drive folders.
- WebRTC connection setup uses Drive signaling and Google/Twilio STUN services. See the [privacy policy](docs/privacy.md) for data handling and deletion controls.
- No telemetry.
- No AI API request.
- No conversation scraping.
- No entire-conversation upload.
- Pinned content, including captured and dropped images, is persisted locally before cloud synchronization.
- If Drive is connected, captured image data contained in a project snapshot is included in that project's asynchronous backup.

## 10. Build and verification

Development commands:

```bash
nvm use
npm install
npm run check
```

`npm run check` performs:

1. strict TypeScript checking;
2. the Vitest test suite;
3. both Firefox and Chromium production builds;
4. verification of generated manifests and browser-safe background bundles.

Firefox artifacts are written to `dist/`; Chromium artifacts are written to `dist/chromium/`. See [BUILD.md](BUILD.md) for packaging and release steps. The sidebar is built as a normal web entry. Background and content scripts are separately bundled as classic IIFEs for Firefox compatibility.

Current automated coverage includes:

- project creation, selection, reordering, persistence, and deletion;
- cascading card deletion with a project;
- card creation, editing, deletion, and reordering;
- press-and-hold word selection in the card editor, including its interaction with the double-click that saves the card;
- status and category stepping from a focused card;
- text-card merging, source removal, destination preservation, and image-source rejection;
- before/after insertion calculations used by the drag placeholder;
- repository insertion directly after a selected card;
- individual card-text formatting for clipboard copy, including category tags;
- safe card-link detection, punctuation handling, and `www.` normalization;
- simple Markdown inline tokenization and paragraph, bullet-list, numbered-list, and persistent task-list parsing;
- board-template creation, configuration, and safe template changes;
- note-only enforcement for Brainstorming;
- version-1 storage migration without card-data loss;
- board prompt serialization with category/status tags, Done and Rejected sections, and Trash exclusion;
- RxDB migration, rollback, subscriptions, image storage, and document conflict resolution;
- shared-board discovery, Drive permissions/signaling, shared image transfer, account order/removal preferences, and viewer mutation restrictions;
- runtime message validation;
- capture-region cropping, scaling, and out-of-bounds clamping;
- content selection capture and source metadata;
- generic-page selections, web-link references, page sources, and unsafe-protocol rejection;
- behavior with no selected project;
- behavior with missing selections or provider DOM data;
- rejection of unsupported and lookalike hosts.

## 11. Current limitations and non-features

The current extension does not implement:

- automatic board context injection into ChatGPT;
- direct ChatGPT access to extension storage;
- ChatGPT-created or ChatGPT-edited cards;
- AI-proposed changes or approval previews;
- provider composer automation;
- Claude, Gemini, Perplexity, or other provider adapters;
- a general-purpose user-facing file import/export workflow beyond clipboard copy and Drive snapshot restore;
- automatic summarization;
- custom user-defined templates or card types;
- comments or a publisher-operated synchronization server;
- character-level collaborative text editing, automatic TURN relay configuration, or cryptographically authenticated per-peer writes (see [collaboration limits](docs/collaboration.md#authorization-and-security-limits));
- AI APIs, billing, or telemetry.

Any future ChatGPT-to-board writing flow should preserve the safety rule:

> AI proposes. Human commits.

Proposed AI changes should be previewed and explicitly accepted or rejected before confirmed project state is modified.
