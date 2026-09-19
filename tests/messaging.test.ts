import { describe, expect, it, vi } from "vitest";
import { pinSelection, pinWebResource } from "../src/background/handlers";
import { captureSelection } from "../src/content/selection";
import { isCaptureRegionMessage, isRuntimeMessage } from "../src/messaging/messages";
import type { ChatProviderAdapter } from "../src/providers/provider";

describe("selection messaging", () => {
  it("recognizes only supported runtime messages", () => {
    expect(isRuntimeMessage({ type: "CAPTURE_SELECTION" })).toBe(true);
    expect(isRuntimeMessage({ type: "UNKNOWN" })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isCaptureRegionMessage({ type: "CAPTURE_PAGE_REGION" })).toBe(true);
    expect(isCaptureRegionMessage({ type: "CAPTURE_SELECTION" })).toBe(false);
  });

  it("captures selected text and source metadata through an adapter", () => {
    const adapter: ChatProviderAdapter = {
      isSupportedPage: () => true,
      getConversationUrl: () => "https://chatgpt.com/c/example",
      getSelectedText: () => "A useful decision"
    };
    expect(captureSelection(adapter)).toEqual({
      ok: true,
      selection: {
        provider: "chatgpt",
        sourceText: "A useful decision",
        conversationUrl: "https://chatgpt.com/c/example"
      }
    });
  });

  it("fails gracefully when provider DOM selection is unavailable", () => {
    const adapter: ChatProviderAdapter = {
      isSupportedPage: () => true,
      getConversationUrl: () => "https://chatgpt.com/",
      getSelectedText: () => null
    };
    expect(captureSelection(adapter)).toEqual({ ok: false, reason: "No text is selected" });
    expect(captureSelection(null)).toEqual({ ok: false, reason: "Unsupported page" });
  });

  it("adds a card to the selected project and retains the source URL", async () => {
    const addItem = vi.fn(async (item) => ({ ...item, id: "i1", order: 0, createdAt: "", updatedAt: "" }));
    const repository = { load: vi.fn(async () => ({ currentProjectId: "p1" })), addItem };
    const result = await pinSelection(repository, {
      ok: true,
      selection: { provider: "chatgpt", sourceText: "Pinned", conversationUrl: "https://chatgpt.com/c/1" }
    });
    expect(result).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      content: "Pinned",
      source: expect.objectContaining({ conversationUrl: "https://chatgpt.com/c/1" })
    }));
  });

  it("does not pin without a current project", async () => {
    const repository = { load: vi.fn(async () => ({ currentProjectId: null })), addItem: vi.fn() };
    expect(await pinSelection(repository, undefined, { text: "Pinned" })).toEqual({
      ok: false,
      reason: "Create or select a project in the sidebar first."
    });
    expect(repository.addItem).not.toHaveBeenCalled();
  });

  it("pins Firefox-provided selections from ordinary web pages", async () => {
    const addItem = vi.fn(async (item) => ({ ...item, id: "i1", type: "note", status: "candidate", order: 0, createdAt: "", updatedAt: "" }));
    const repository = { load: vi.fn(async () => ({ currentProjectId: "p1" })), addItem };
    expect(await pinSelection(repository, undefined, {
      text: "Selected article text",
      url: "https://example.com/article",
      provider: "web"
    })).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({
      content: "Selected article text",
      source: {
        provider: "web",
        conversationUrl: "https://example.com/article",
        sourceText: "Selected article text"
      }
    }));
  });

  it("pins web links as references with link text and source page", async () => {
    const addItem = vi.fn(async (item) => ({ ...item, id: "i1", order: 0, createdAt: "", updatedAt: "" }));
    const repository = { load: vi.fn(async () => ({ currentProjectId: "p1" })), addItem };
    expect(await pinWebResource(repository, {
      url: "https://example.com/reference",
      pageUrl: "https://news.example.org/story",
      title: "Useful reference"
    })).toEqual({ ok: true });
    expect(addItem).toHaveBeenCalledWith(expect.objectContaining({
      content: "https://example.com/reference",
      title: "Useful reference",
      type: "reference",
      source: expect.objectContaining({ conversationUrl: "https://news.example.org/story" })
    }));
  });

  it("rejects non-web link protocols", async () => {
    const repository = { load: vi.fn(async () => ({ currentProjectId: "p1" })), addItem: vi.fn() };
    expect(await pinWebResource(repository, { url: "javascript:alert(1)" })).toEqual({
      ok: false,
      reason: "Only HTTP and HTTPS links can be pinned."
    });
    expect(repository.addItem).not.toHaveBeenCalled();
  });
});
