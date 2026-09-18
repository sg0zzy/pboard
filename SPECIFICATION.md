# Pboard — Product Specification

**Version:** 0.1.0  
**Baseline date:** 2026-09-16  
**Status:** Implemented MVP

This document records the behavior currently implemented in the repository. It is a baseline for development and debugging, not a description of unbuilt future features.

## 1. Product purpose

Pboard is a local-first Firefox extension that keeps structured project state beside AI conversations and ordinary web research.

The product separates two concepts:

- **Conversation history** is the process used to explore a problem.
- **Project state** is the set of points the user currently wants to retain.

The current workflow is:

```text
Discuss in ChatGPT → Pin selected text → Refine and reorder cards → Copy board as a prompt
```

## 2. Supported environment

- Firefox WebExtension using Manifest V3.
- Minimum declared Firefox version: 121.
- Sidebar UI implemented with React and TypeScript.
- Chat selection capture supported on:
  - `https://chatgpt.com/*`
  - `https://chat.openai.com/*`
- Node.js 24.17.0 is recorded in `.nvmrc` for local builds.

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
- Project creation requires choosing one of the three board templates.
- Pressing Escape anywhere in the New Project form closes it, discards its temporary name/template selection, and leaves stored project data unchanged.
- After successful project creation, the Add Point editor opens automatically and receives focus so the next typed text can be submitted as the first card with Enter.
- A newly created project becomes the current project.
- A user can switch projects with the project selector.
- A folder-plus icon in the project-title row opens and closes the New Project form, replacing the previous separate text action.
- A pencil icon replaces the project selector with a focused inline name field; Enter persists a non-empty trimmed name and Escape cancels without changes.
- The selected project is global to the extension; it is not tied to the current ChatGPT conversation.
- A user can delete the current project after confirming the destructive action in a panel directly beneath the project row.
- The project confirmation panel participates in layout and never covers the project selector.
- Deleting a project also deletes all cards belonging to it.
- When the selected project is deleted, the first remaining project becomes current; otherwise no project is selected.
- A project's template can be changed after creation without deleting any cards.

Project data:

```typescript
type Project = {
  id: string;
  name: string;
  template: "brainstorming" | "idea" | "project";
  createdAt: string;
  updatedAt: string;
};
```

### 3.1 Board templates

Templates are configuration-driven through `src/templates/boardTemplates.ts`. Each definition supplies its display name, description, supported card types, default card type, prompt behavior, labels, and semantic colors.

The three templates represent increasing structure:

```text
Brainstorming → no semantic structure
Idea          → exploratory semantic structure
Project       → decision and execution structure
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
- In the Add Point editor, Enter or a double-click creates the card, Shift+Enter inserts a newline, and Escape cancels; the visible Add button remains available.
- After a card is created, the Add Point editor stays open, clears only the saved draft, and restores focus so the user can immediately type and submit another card.
- On long boards, opening the Add Point editor or inserting a card scrolls the minimum necessary distance to keep the complete active form inside the sidebar viewport.
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
- After an existing card is saved, focus returns to that card and a second Enter opens a new inline draft directly beneath it.
- No persistent Edit or Save button is shown on a card.
- A card may have an optional title.
- Card content must not be empty.
- A user can change a card's type and status at any time.
- Cards can be deleted.
- Deleting a Confirmed card requires approval in a panel directly beneath that card; the panel pushes neighboring content rather than overlapping the card.
- Candidate and Rejected cards retain immediate deletion.
- Confirmation panels focus Cancel by default and may be dismissed with Escape.
- A trash-can icon replaces the textual Delete action and retains an accessible label and tooltip.
- A conventional overlapping-sheets icon copies the optional title and card content to the clipboard without type, status, or source metadata.
- The copy icon temporarily becomes a check mark after a successful copy.
- Card content and its compact action row use minimal vertical spacing so short cards remain easy to scan in long boards.
- HTTP, HTTPS, and `www.` addresses in card titles and content are rendered as native links.
- Stored source-conversation badges are links when they contain a valid HTTP or HTTPS address.
- Links open in a browser tab and retain Firefox's native middle-click and context-menu actions.
- Non-web protocols are not converted into links.
- Cards can be reordered with native drag-and-drop.
- While dragging, the original card is visually subdued and a dashed card-shaped placeholder previews whether it will be inserted before or after the card under the pointer.
- The placeholder updates as the pointer crosses the vertical midpoint of a target card.
- Rejected and non-rejected sections only accept reorder previews from their own section, preventing a misleading cross-section placement.
- Deleting a card normalizes the remaining order values.
- Rejected cards are placed in a collapsed **Rejected** section.
- Card changes update the card's `updatedAt` timestamp.

Supported card types are supplied by the selected board template rather than a global UI list. The storage union includes the current template types plus the legacy `idea` value so older data can be preserved.

Supported statuses:

- `candidate`
- `confirmed`
- `rejected`

Status semantics in version 0.1:

- Status is local board metadata controlled by the user and remains independent from card type.
- Semantic type is shown with a subtle colored top border and label chip.
- Status is shown separately with `○`, `●`, or `×` and its own pill/border treatment; semantic card color does not encode status.
- **Confirmed does not send the card to ChatGPT.**
- Changing status does not start an AI operation or modify a conversation.
- Rejected cards remain stored and editable but are excluded from copied prompts.

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
    | "constraint"
    | "question"
    | "risk"
    | "reference";
  title?: string;
  content: string;
  status: "candidate" | "confirmed" | "rejected";
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

The extension provides a one-way capture flow from any ordinary HTTP/HTTPS page to the current board without injecting a content script into generic sites.

User flow:

1. Select text on an HTTP/HTTPS page.
2. Open Firefox's context menu.
3. Choose **Pin selection to Pboard**.
4. The text is added to the currently selected project.

Pinned-card behavior:

- The card type is `note`.
- The card status is `candidate`.
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
- **Pin current page to Pboard** appears for ordinary page, selection, and link context menus, so a page can be captured without dismissing the current context.
- A pin page-action icon is shown inside Firefox's address bar on HTTP/HTTPS pages and stores the loaded page URL and title.
- Link and page cards request the `reference` type; Brainstorming safely converts this to its generic `note` type.
- Only HTTP and HTTPS resources are accepted.
- Firefox does not expose selected or uncommitted text inside its privileged address bar to WebExtension context menus. The address-bar button therefore pins the currently loaded page, not arbitrary text typed into the URL bar.

## 6. Copy board as prompt

The sidebar provides a prominent **Copy board** button, with the same overlapping-sheets icon used by card copy actions, for the current project. Its clipboard output remains a structured prompt.

Implemented behavior:

- The button is disabled when there are no non-rejected cards.
- Cards are serialized in their current board order.
- Rejected cards are excluded.
- Candidate and confirmed cards are included.
- Idea and Project type names are converted to readable uppercase section labels; Brainstorming omits category headings.
- An optional card title appears between its type and content.
- The resulting text is written to the clipboard.
- The sidebar displays a temporary success notice.

Example:

```text
PROJECT: AI brainstorming SaaS

GOAL
Create a lightweight tool for developing ideas with AI.

DECISION
Use a browser sidebar.
```

Copying is currently the only implemented board-to-chat workflow. The user must paste the generated prompt into ChatGPT or another AI application manually.

## 7. Persistence and synchronization

- All state is stored in `browser.storage.local` under the key `projectBoardState`.
- State is stored as one versioned object with schema version `2`.
- Version-1 projects without a template are migrated in memory to the `project` template without rewriting or deleting their cards.
- Data persists across browser restarts.
- The sidebar listens for storage changes and reloads when the background script pins a new card.
- Projects belong to Pboard, not to provider conversation IDs.
- Conversation URLs are optional source metadata only.

Application state:

```typescript
type AppState = {
  version: 2;
  projects: Project[];
  boardItems: BoardItem[];
  currentProjectId: string | null;
};
```

## 8. Extension architecture

```text
ChatGPT page
  │
  ├─ ChatGPT provider adapter
  │    └─ reads selected text and conversation URL
  │
  └─ content script
       │ WebExtension message: CAPTURE_SELECTION
       ▼
background script
  ├─ owns selection, link, and page context-menu actions
  ├─ owns the address-bar page action
  └─ writes pinned cards through the repository
       │
       ▼
browser.storage.local
       ▲
       │
React sidebar
  ├─ project and card controls
  ├─ drag-and-drop ordering
  └─ prompt serialization and clipboard copy
```

Code boundaries:

- `src/background/`: context-menu orchestration and pin handler.
- `src/content/`: content-script message handling and selection capture.
- `src/messaging/`: typed WebExtension message contracts.
- `src/providers/`: provider-specific page access behind a shared adapter.
- `src/sidebar/`: React UI, card component, styling, and prompt serialization.
- `src/storage/`: storage adapter and project/card repository.
- `src/templates/`: declarative template, type-label, and semantic-color configuration.
- `src/types/`: shared domain types.

## 9. Permissions and privacy

Declared permissions:

- `storage`: save projects, cards, order, and current-project selection.
- `menus`: add selection, link, and page pin actions.
- `clipboardWrite`: copy either a serialized board or one card's text after a user action.
- Host permissions for the two supported ChatGPT origins only.
- Generic sites require no host permission and receive no content script; their selected text and URLs come from Firefox's user-invoked menu event.

Privacy properties:

- No account or authentication.
- No backend or cloud synchronization.
- No telemetry.
- No external API or AI request.
- No conversation scraping.
- No entire-conversation upload.
- Pinned content remains in local Firefox extension storage.

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
3. the production build.

Production artifacts are written to `dist/`. The sidebar is built as a normal web entry. Background and content scripts are separately bundled as classic IIFEs for Firefox compatibility.

Current automated coverage includes:

- project creation, selection, persistence, and deletion;
- cascading card deletion with a project;
- card creation, editing, deletion, and reordering;
- before/after insertion calculations used by the drag placeholder;
- repository insertion directly after a selected card;
- individual card-text formatting for clipboard copy;
- safe card-link detection, punctuation handling, and `www.` normalization;
- board-template creation, configuration, and safe template changes;
- note-only enforcement for Brainstorming;
- version-1 storage migration without card-data loss;
- board prompt serialization and rejected-card exclusion;
- runtime message validation;
- content selection capture and source metadata;
- generic-page selections, web-link references, page sources, and unsafe-protocol rejection;
- behavior with no selected project;
- behavior with missing selections or provider DOM data;
- rejection of unsupported and lookalike hosts.

## 11. Current limitations and non-features

Version 0.1 does not implement:

- automatic board context injection into ChatGPT;
- direct ChatGPT access to extension storage;
- ChatGPT-created or ChatGPT-edited cards;
- AI-proposed changes or approval previews;
- opening source conversations from cards;
- provider composer automation;
- Claude, Gemini, Perplexity, or other provider adapters;
- import or export;
- keyboard shortcuts;
- automatic summarization;
- custom user-defined templates or card types;
- accounts, server sync, collaboration, comments, or permissions;
- AI APIs, billing, or telemetry.

Any future ChatGPT-to-board writing flow should preserve the safety rule:

> AI proposes. Human commits.

Proposed AI changes should be previewed and explicitly accepted or rejected before confirmed project state is modified.
