import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks, setTaskCheckedAtLine, tokenizeInlineMarkdown } from "../src/sidebar/markdown";

describe("tokenizeInlineMarkdown", () => {
  it("recognizes bold, italic, inline code, and markdown links", () => {
    expect(tokenizeInlineMarkdown("**bold** *italic* `code` [Docs](https://example.com)"))
      .toEqual([
        { type: "bold", text: "bold" },
        { type: "text", text: " " },
        { type: "italic", text: "italic" },
        { type: "text", text: " " },
        { type: "code", text: "code" },
        { type: "text", text: " " },
        { type: "link", text: "Docs", href: "https://example.com" }
      ]);
  });

  it("retains automatic web links and refuses unsafe markdown links", () => {
    expect(tokenizeInlineMarkdown("Visit www.example.com")).toContainEqual({
      type: "link", text: "www.example.com", href: "https://www.example.com"
    });
    expect(tokenizeInlineMarkdown("[unsafe](javascript:alert)"))
      .toEqual([{ type: "text", text: "[unsafe](javascript:alert)" }]);
  });
});

describe("parseMarkdownBlocks", () => {
  it("groups asterisk and hyphen bullets into an unordered list", () => {
    expect(parseMarkdownBlocks("* First\n- Second"))
      .toEqual([{ type: "unordered-list", items: ["First", "Second"] }]);
  });

  it("groups numbered lines and preserves the first number", () => {
    expect(parseMarkdownBlocks("3. Third\n4. Fourth"))
      .toEqual([{ type: "ordered-list", start: 3, items: ["Third", "Fourth"] }]);
  });

  it("recognizes persistent checked and unchecked task items", () => {
    expect(parseMarkdownBlocks("Intro\n- [ ] Do this\n- [x] Done"))
      .toEqual([
        { type: "paragraph", text: "Intro" },
        {
          type: "task-list",
          items: [
            { text: "Do this", checked: false, lineIndex: 1 },
            { text: "Done", checked: true, lineIndex: 2 }
          ]
        }
      ]);
  });

  it("toggles only the requested task marker in the source text", () => {
    const source = "- [ ] First\n- [x] Second\nordinary text";
    expect(setTaskCheckedAtLine(source, 0, true)).toBe("- [x] First\n- [x] Second\nordinary text");
    expect(setTaskCheckedAtLine(source, 1, false)).toBe("- [ ] First\n- [ ] Second\nordinary text");
    expect(setTaskCheckedAtLine(source, 2, true)).toBe(source);
  });

  it("keeps ordinary multiline text in paragraph blocks", () => {
    expect(parseMarkdownBlocks("Line one\nLine two\n\nAfter"))
      .toEqual([
        { type: "paragraph", text: "Line one\nLine two" },
        { type: "paragraph", text: "After" }
      ]);
  });
});
