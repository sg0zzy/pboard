// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Card } from "../src/sidebar/components/Card";
import { WORD_HOLD_MS } from "../src/sidebar/wordRange";
import type { BoardItem } from "../src/types";

const item: BoardItem = {
  id: "card-1",
  projectId: "project-1",
  type: "task",
  title: "Release checklist",
  content: "verify the build",
  status: "started",
  displayMode: "standard",
  order: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("hold to select a word in the card editor", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onUpdate = vi.fn(async () => undefined);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onUpdate.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function renderCard(extra: Partial<ComponentProps<typeof Card>> = {}) {
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
        {...extra}
      />
    ));
  }

  function startEditing() {
    act(() => container.querySelector<HTMLElement>("article")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  }

  function press(field: HTMLInputElement | HTMLTextAreaElement, options: { clientX?: number; clientY?: number; detail?: number } = {}) {
    act(() => field.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      detail: options.detail ?? 1,
      clientX: options.clientX ?? 10,
      clientY: options.clientY ?? 10
    })));
  }

  function move(clientX: number, clientY: number) {
    act(() => window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY })));
  }

  function release() {
    act(() => window.dispatchEvent(new MouseEvent("mouseup")));
  }

  function advance(ms: number) {
    act(() => { vi.advanceTimersByTime(ms); });
  }

  it("selects the word under the held pointer in the content field", () => {
    renderCard();
    startEditing();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(13, 13);

    press(textarea);
    advance(WORD_HOLD_MS);
    release();

    expect(textarea.selectionStart).toBe(11);
    expect(textarea.selectionEnd).toBe(16);
    expect(textarea.value.slice(textarea.selectionStart ?? 0, textarea.selectionEnd ?? 0)).toBe("build");
  });

  it("selects the word under the held pointer in the title field", () => {
    renderCard();
    startEditing();
    const input = container.querySelector<HTMLInputElement>("input")!;
    input.focus();
    input.setSelectionRange(9, 9);

    press(input);
    advance(WORD_HOLD_MS);
    release();

    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe("checklist");
  });

  it("cancels the hold when the pointer moves away", () => {
    renderCard();
    startEditing();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(9, 9);

    press(textarea, { clientX: 10, clientY: 10 });
    move(60, 60);
    advance(WORD_HOLD_MS);
    release();

    expect(textarea.selectionStart).toBe(9);
    expect(textarea.selectionEnd).toBe(9);
  });

  it("cancels the hold when the button is released before the delay", () => {
    renderCard();
    startEditing();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(9, 9);

    press(textarea);
    advance(WORD_HOLD_MS - 1);
    release();
    advance(WORD_HOLD_MS);

    expect(textarea.selectionStart).toBe(9);
    expect(textarea.selectionEnd).toBe(9);
  });

  it("leaves the double-click that saves the card working", () => {
    renderCard();
    startEditing();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;

    // The second click of a double-click must not start a hold.
    press(textarea, { detail: 2 });
    advance(WORD_HOLD_MS);
    release();

    expect(onUpdate).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLElement>(".edit-form")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onUpdate).toHaveBeenCalledWith(item.id, { title: item.title, content: item.content }, undefined);
  });
});
