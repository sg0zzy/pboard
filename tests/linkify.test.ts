import { describe, expect, it } from "vitest";
import { toSafeWebHref, tokenizeLinks } from "../src/sidebar/linkify";

describe("tokenizeLinks", () => {
  it("turns HTTP and HTTPS addresses into links while preserving text", () => {
    expect(tokenizeLinks("Read https://example.com/docs and http://localhost:3000/test"))
      .toEqual([
        { type: "text", text: "Read " },
        { type: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
        { type: "text", text: " and " },
        { type: "link", text: "http://localhost:3000/test", href: "http://localhost:3000/test" }
      ]);
  });

  it("adds a safe protocol to www addresses", () => {
    expect(tokenizeLinks("Visit www.example.com now")).toEqual([
      { type: "text", text: "Visit " },
      { type: "link", text: "www.example.com", href: "https://www.example.com" },
      { type: "text", text: " now" }
    ]);
  });

  it("keeps sentence punctuation outside the link", () => {
    expect(tokenizeLinks("See https://example.com/path)." )).toEqual([
      { type: "text", text: "See " },
      { type: "link", text: "https://example.com/path", href: "https://example.com/path" },
      { type: "text", text: ")." }
    ]);
  });

  it("does not link non-web protocols", () => {
    expect(tokenizeLinks("javascript:alert(1) and mailto:test@example.com")).toEqual([
      { type: "text", text: "javascript:alert(1) and mailto:test@example.com" }
    ]);
    expect(toSafeWebHref("javascript:alert(1)")).toBeNull();
  });
});
