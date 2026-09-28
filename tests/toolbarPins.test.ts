// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { getToolbarPinContext, pinFromToolbar, readPagePinTarget, type PinApi } from "../src/background/toolbarPins";

const tab = { id: 4, url: "https://example.com/article", title: "Example article" };

function setup(target: { selectionText?: string; linkUrl?: string; linkText?: string } = {}) {
  const api: PinApi = {
    tabs: { query: vi.fn(async () => [tab]) },
    scripting: { executeScript: vi.fn(async () => [{ result: target }]) }
  };
  const addItem = vi.fn(async (item) => ({ ...item, id: "card-1", order: 0, createdAt: "", updatedAt: "" }));
  const repository = { load: vi.fn(async () => ({ currentProjectId: "project-1" })), addItem };
  return { api, repository, addItem };
}

describe("toolbar pin actions", () => {
  afterEach(() => { document.body.innerHTML = ""; window.getSelection()?.removeAllRanges(); });

  it("pins the active page through the shared web resource handler", async () => {
    const { api, repository, addItem } = setup();
    expect(await pinFromToolbar(api, repository, "page")).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({ content: tab.url, title: tab.title, type: "reference" }));
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("pins selected text and a focused link through the existing handlers", async () => {
    const { api, repository, addItem } = setup({ selectionText: "Useful point", linkUrl: "https://example.com/next", linkText: "Next" });
    expect(await getToolbarPinContext(api)).toEqual({ page: true, selection: true, link: true, accessible: true });
    expect(await pinFromToolbar(api, repository, "selection")).toEqual({ ok: true, cardId: "card-1" });
    expect(await pinFromToolbar(api, repository, "link")).toEqual({ ok: true });
    expect(addItem.mock.calls[0][0]).toEqual(expect.objectContaining({ content: "Useful point", type: "note" }));
    expect(addItem.mock.calls[1][0]).toEqual(expect.objectContaining({ content: "https://example.com/next", title: "Next", type: "reference" }));
  });

  it("reports absent selection and link without creating a card", async () => {
    const { api, repository, addItem } = setup();
    expect(await getToolbarPinContext(api)).toEqual({ page: true, selection: false, link: false, accessible: true });
    expect((await pinFromToolbar(api, repository, "selection")).ok).toBe(false);
    expect((await pinFromToolbar(api, repository, "link")).ok).toBe(false);
    expect(addItem).not.toHaveBeenCalled();
  });

  it("reads selected text and a selected link from the page", () => {
    document.body.innerHTML = '<a href="https://example.com/next">Next page</a>';
    const link = document.querySelector("a")!;
    const range = document.createRange();
    range.selectNodeContents(link);
    window.getSelection()?.addRange(range);
    expect(readPagePinTarget()).toEqual({ selectionText: "Next page", linkUrl: link.href, linkText: "Next page" });
  });
});
