// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ChatGptAdapter } from "../src/providers/chatgpt";

describe("ChatGptAdapter", () => {
  it("returns null rather than depending on ChatGPT DOM structure", () => {
    const pageWindow = {
      location: { protocol: "https:", hostname: "chatgpt.com", href: "https://chatgpt.com/c/1" },
      getSelection: vi.fn(() => null)
    } as unknown as Window;
    const adapter = new ChatGptAdapter(pageWindow, document);
    expect(adapter.isSupportedPage()).toBe(true);
    expect(adapter.getSelectedText()).toBeNull();
  });

  it("rejects lookalike and unsupported hosts", () => {
    const pageWindow = {
      location: { protocol: "https:", hostname: "chatgpt.com.example.org", href: "https://chatgpt.com.example.org" },
      getSelection: vi.fn(() => ({ toString: () => "text" }))
    } as unknown as Window;
    expect(new ChatGptAdapter(pageWindow, document).isSupportedPage()).toBe(false);
  });
});
