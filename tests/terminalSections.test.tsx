// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_ITEM_STATUS_CYCLE } from "../src/types";
import {
  TERMINAL_SECTION_DEFINITIONS,
  TerminalSection
} from "../src/sidebar/components/TerminalSection";

describe("terminal board sections", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderSections(onCopy = vi.fn(), onTrash = vi.fn()) {
    act(() => root.render(
      <>
        {TERMINAL_SECTION_DEFINITIONS.map((definition, index) => (
          <TerminalSection
            key={definition.status}
            definition={definition}
            count={index + 2}
            onCopy={definition.status === "trash" ? undefined : onCopy}
            onTrash={onTrash}
          >
            <p>{definition.label} contents</p>
          </TerminalSection>
        ))}
      </>
    ));
  }

  it("renders Done, Rejected, and Trash with their own counts and contents", () => {
    renderSections();
    const sections = Array.from(container.querySelectorAll<HTMLDetailsElement>("details"));

    expect(sections.map((section) => section.dataset.sectionStatus)).toEqual(["done", "rejected", "trash"]);
    expect(sections.map((section) => section.querySelector("summary")?.textContent?.trim())).toEqual([
      "Done (2)", "Rejected (3)", "Trash (4)"
    ]);
    expect(sections.map((section) => section.querySelector("p")?.textContent)).toEqual([
      "Done contents", "Rejected contents", "Trash contents"
    ]);
  });

  it("keeps visual ordering separate from the canonical keyboard status cycle", () => {
    expect(TERMINAL_SECTION_DEFINITIONS.map(({ status }) => status)).toEqual(["done", "rejected", "trash"]);
    expect(BOARD_ITEM_STATUS_CYCLE).toEqual([
      "candidate", "confirmed", "started", "to validate", "done", "trash", "rejected"
    ]);
  });

  it("toggles when the header is clicked", () => {
    renderSections();
    const section = container.querySelector<HTMLDetailsElement>('details[data-section-status="done"]')!;
    const summary = section.querySelector("summary")!;

    act(() => summary.click());
    expect(section.open).toBe(true);
    act(() => summary.click());
    expect(section.open).toBe(false);
  });

  it("runs header actions without toggling the container", () => {
    const onCopy = vi.fn();
    const onTrash = vi.fn();
    renderSections(onCopy, onTrash);
    const section = container.querySelector<HTMLDetailsElement>('details[data-section-status="done"]')!;

    act(() => section.querySelector<HTMLButtonElement>('[aria-label="Copy done cards"]')!.click());
    expect(onCopy).toHaveBeenCalledOnce();
    expect(section.open).toBe(false);

    act(() => section.querySelector<HTMLButtonElement>('[aria-label="Trash done cards"]')!.click());
    expect(onTrash).toHaveBeenCalledOnce();
    expect(section.open).toBe(false);
  });
});
