// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Card } from "../src/sidebar/components/Card";
import type { BoardItem } from "../src/types";

const item: BoardItem = {
  id: "card-1",
  projectId: "project-1",
  type: "task",
  title: "Long card",
  content: "First line\nSecond line\nThird line\nFull editable content",
  status: "started",
  displayMode: "standard",
  order: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("card display controls", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onUpdate = vi.fn(async () => undefined);

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onUpdate.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderCard() {
    act(() => root.render(
      <Card
        item={item}
        pendingStatus={item.status}
        template="project"
        onUpdate={onUpdate}
        onStatusChange={vi.fn()}
        onDelete={vi.fn(async () => undefined)}
        onDiscardEmpty={vi.fn(async () => undefined)}
        onDragStart={vi.fn()}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        onDragEnd={vi.fn()}
        isDragging={false}
        isMergeTarget={false}
        isMergeSource={false}
        onInsertAfter={vi.fn()}
        onDuplicate={vi.fn()}
        selected
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
        onKeyboardMove={vi.fn()}
        focusRequested={false}
        startEditingOnFocus={false}
        onFocusHandled={vi.fn()}
      />
    ));
  }

  it("renders direct accessible controls and marks the active mode", () => {
    renderCard();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".display-mode-button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["─", "▫", "□"]);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Compact", "Standard", "Expanded"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });

  it("cycles mode with V and supports direct one-click selection", () => {
    renderCard();
    const card = container.querySelector<HTMLElement>("article")!;

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
    expect(onUpdate).toHaveBeenCalledWith(item.id, { displayMode: "expanded" });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Compact"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith(item.id, { displayMode: "compact" });
  });

  it("opens the complete content in edit mode regardless of display mode", () => {
    renderCard();
    act(() => container.querySelector<HTMLElement>("article")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(item.content);
  });
});
