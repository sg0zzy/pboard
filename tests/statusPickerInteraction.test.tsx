// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPicker } from "../src/sidebar/components/StatusPicker";

describe("status picker interaction", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders the canonical status order and navigates it consistently", () => {
    const onChange = vi.fn();
    act(() => root.render(<StatusPicker value="candidate" onChange={onChange} />));
    act(() => container.querySelector<HTMLButtonElement>(".status-picker-trigger")!.click());

    const options = [...container.querySelectorAll<HTMLButtonElement>(".status-picker-option")];
    expect(options.map((option) => option.children[1]?.textContent?.trim())).toEqual([
      "○ Candidate",
      "● Confirmed",
      "▶ Started",
      "◐ To validate",
      "✓ Done",
      "– Trashed",
      "× Rejected"
    ]);

    act(() => options[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("confirmed");
    act(() => root.render(<StatusPicker value="confirmed" onChange={onChange} />));
    const updatedOptions = [...container.querySelectorAll<HTMLButtonElement>(".status-picker-option")];
    act(() => updatedOptions[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith("candidate");
  });
});
