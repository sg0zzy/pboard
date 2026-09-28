// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureToolbar } from "../src/sidebar/components/CaptureToolbar";
import type { ToolbarPinContext } from "../src/messaging/messages";

describe("capture toolbar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const onNewCard = vi.fn();
  const onPin = vi.fn();
  const onCaptureRegion = vi.fn();
  const context: ToolbarPinContext = { page: true, selection: true, link: true, accessible: true };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(pinContext = context) {
    act(() => root.render(<CaptureToolbar context={pinContext} busy={false} onNewCard={onNewCard} onPin={onPin} onCaptureRegion={onCaptureRegion} />));
    return container.querySelector<HTMLElement>("[role=toolbar]")!;
  }

  it("places the separator directly after New card and orders the pin actions", () => {
    const toolbar = render();
    expect([...toolbar.children].map((child) => child.getAttribute("aria-label") ?? child.getAttribute("role"))).toEqual([
      "New card", "separator", "Pin current page", "Pin selected text", "Pin link", "Capture region"
    ]);
    expect(toolbar.querySelector('[role="separator"]')?.getAttribute("aria-orientation")).toBe("vertical");
    for (const button of toolbar.querySelectorAll("button")) {
      expect(button.title).toBe(button.getAttribute("aria-label"));
    }
  });

  it("dispatches each action to its existing flow", () => {
    const toolbar = render();
    for (const button of toolbar.querySelectorAll("button")) act(() => button.click());
    expect(onNewCard).toHaveBeenCalledOnce();
    expect(onPin.mock.calls).toEqual([["page"], ["selection"], ["link"]]);
    expect(onCaptureRegion).toHaveBeenCalledOnce();
  });

  it("disables selected text and link when the page exposes neither", () => {
    const toolbar = render({ page: true, selection: false, link: false, accessible: true });
    expect(toolbar.querySelector<HTMLButtonElement>('[aria-label="Pin selected text"]')?.disabled).toBe(true);
    expect(toolbar.querySelector<HTMLButtonElement>('[aria-label="Pin link"]')?.disabled).toBe(true);
    expect(toolbar.querySelector<HTMLButtonElement>('[aria-label="Pin current page"]')?.disabled).toBe(false);
  });
});
