// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
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
  const onStatusChange = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onUpdate.mockClear();
    onStatusChange.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderCard(extra: Partial<ComponentProps<typeof Card>> = {}) {
    act(() => root.render(
      <Card
        item={item}
        pendingStatus={item.status}
        template="project"
        onUpdate={onUpdate}
        onStatusChange={onStatusChange}
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
        {...extra}
      />
    ));
  }

  it("renders an image that arrives after its card was already displayed as unavailable", async () => {
    const createObjectURL = vi.fn(() => "blob:downloaded-image");
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    let available = false;
    let notify: (() => void) | undefined;
    const stop = vi.fn();
    const getImage = vi.fn(async () => available ? {
      imageId: "image-id", blob: new Blob(["image"], { type: "image/png" }), mimeType: "image/png", width: 1, height: 1, size: 5
    } : null);
    try {
      await act(async () => renderCard({ item: { ...item, imageId: "image-id" }, getImage,
        subscribeImage: async (_id, listener) => { notify = listener; return stop; }
      }));
      expect(container.textContent).toContain("Image unavailable");
      available = true;
      await act(async () => { notify!(); });
      expect(container.querySelector<HTMLImageElement>(".card-image")?.getAttribute("src")).toBe("blob:downloaded-image");
      expect(container.textContent).not.toContain("Image unavailable");
      act(() => root.unmount());
      expect(stop).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:downloaded-image");
    } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
  });

  it("renders direct accessible controls and marks the active mode", () => {
    renderCard();

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".display-mode-button")];
    expect(buttons.map((button) => button.querySelector("svg"))).not.toContain(null);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Compact view", "Standard view", "Expanded view"]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
  });

  it("cycles mode with V and supports direct one-click selection", () => {
    renderCard();
    const card = container.querySelector<HTMLElement>("article")!;

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
    expect(onUpdate).toHaveBeenCalledWith(item.id, { displayMode: "expanded" });

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Compact view"]')!.click());
    expect(onUpdate).toHaveBeenLastCalledWith(item.id, { displayMode: "compact" });
  });

  it("cycles status with unmodified Left and Right arrows", () => {
    renderCard();
    const card = container.querySelector<HTMLElement>("article")!;

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onStatusChange).toHaveBeenLastCalledWith(item.id, "to validate");

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(onStatusChange).toHaveBeenLastCalledWith(item.id, "confirmed");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("cycles category with Ctrl+Left and Ctrl+Right without changing status", () => {
    renderCard();
    const card = container.querySelector<HTMLElement>("article")!;

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true })));
    expect(onUpdate).toHaveBeenLastCalledWith(item.id, { type: "constraint" });

    act(() => card.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true })));
    expect(onUpdate).toHaveBeenLastCalledWith(item.id, { type: "decision" });
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("opens the complete content in edit mode regardless of display mode", () => {
    renderCard();
    act(() => container.querySelector<HTMLElement>("article")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(item.content);
  });

  it("cycles Tab and Shift+Tab through controls and fields while editing", () => {
    renderCard();
    act(() => container.querySelector<HTMLElement>("article")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    const focusable = [...container.querySelectorAll<HTMLElement>("article button, article input, article textarea")];
    const pressTab = (shiftKey = false) => {
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
      act(() => document.activeElement!.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };

    focusable.at(-1)!.focus();
    for (const target of focusable) {
      pressTab();
      expect(document.activeElement).toBe(target);
    }

    focusable[0].focus();
    for (const target of [...focusable].reverse()) {
      pressTab(true);
      expect(document.activeElement).toBe(target);
    }
  });

  it("leaves normal Tab handling intact outside edit mode", () => {
    renderCard();
    const card = container.querySelector<HTMLElement>("article")!;
    card.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => card.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
