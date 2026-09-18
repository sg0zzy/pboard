import { Fragment } from "react";
import { toSafeWebHref, tokenizeLinks } from "./linkify";

export type InlineMarkdownToken =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[]; start: number }
  | { type: "task-list"; items: Array<{ text: string; checked: boolean; lineIndex: number }> };

const INLINE_MARKDOWN = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)\n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
const UNORDERED_ITEM = /^\s*[-*]\s+(.+)$/;
const ORDERED_ITEM = /^\s*(\d+)\.\s+(.+)$/;
const TASK_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;

export function tokenizeInlineMarkdown(text: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = [];
  let cursor = 0;

  function appendPlain(value: string) {
    tokenizeLinks(value).forEach((part) => tokens.push(part));
  }

  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    const start = match.index;
    if (start > cursor) appendPlain(text.slice(cursor, start));
    const source = match[0];

    if (source.startsWith("`")) {
      tokens.push({ type: "code", text: source.slice(1, -1) });
    } else if (source.startsWith("[")) {
      const separator = source.lastIndexOf("](");
      const label = source.slice(1, separator);
      const href = toSafeWebHref(source.slice(separator + 2, -1));
      if (href) tokens.push({ type: "link", text: label, href });
      else appendPlain(source);
    } else if (source.startsWith("**")) {
      tokens.push({ type: "bold", text: source.slice(2, -2) });
    } else {
      tokens.push({ type: "italic", text: source.slice(1, -1) });
    }
    cursor = start + source.length;
  }

  if (cursor < text.length) appendPlain(text.slice(cursor));
  return tokens.length ? tokens : [{ type: "text", text }];
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  }

  for (const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    const task = line.match(TASK_ITEM);
    const unordered = line.match(UNORDERED_ITEM);
    const ordered = line.match(ORDERED_ITEM);

    if (task) {
      flushParagraph();
      const previous = blocks.at(-1);
      const item = { text: task[2], checked: task[1].toLowerCase() === "x", lineIndex };
      if (previous?.type === "task-list") previous.items.push(item);
      else blocks.push({ type: "task-list", items: [item] });
    } else if (unordered) {
      flushParagraph();
      const previous = blocks.at(-1);
      if (previous?.type === "unordered-list") previous.items.push(unordered[1]);
      else blocks.push({ type: "unordered-list", items: [unordered[1]] });
    } else if (ordered) {
      flushParagraph();
      const previous = blocks.at(-1);
      if (previous?.type === "ordered-list") previous.items.push(ordered[2]);
      else blocks.push({ type: "ordered-list", items: [ordered[2]], start: Number(ordered[1]) });
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return blocks;
}

export function setTaskCheckedAtLine(text: string, lineIndex: number, checked: boolean): string {
  const lines = text.split(/\r?\n/);
  const line = lines[lineIndex];
  if (line === undefined || !TASK_ITEM.test(line)) return text;
  lines[lineIndex] = line.replace(
    /^(\s*[-*]\s+\[)[ xX](\])/, (_match, prefix: string, suffix: string) =>
      `${prefix}${checked ? "x" : " "}${suffix}`
  );
  return lines.join("\n");
}

export function MarkdownInline({ text }: { text: string }) {
  return tokenizeInlineMarkdown(text).map((token, index) => {
    const key = `${index}-${token.type}`;
    switch (token.type) {
      case "bold": return <strong key={key}>{token.text}</strong>;
      case "italic": return <em key={key}>{token.text}</em>;
      case "code": return <code key={key}>{token.text}</code>;
      case "link": return (
        <a key={key} className="card-link" href={token.href} target="_blank" rel="noreferrer" onDoubleClick={(event) => event.stopPropagation()}>
          {token.text}
        </a>
      );
      default: return <Fragment key={key}>{token.text}</Fragment>;
    }
  });
}

export function MarkdownContent({
  text,
  onTaskToggle
}: {
  text: string;
  onTaskToggle?: (lineIndex: number, checked: boolean) => void;
}) {
  return (
    <div className="card-content">
      {parseMarkdownBlocks(text).map((block, index) => {
        if (block.type === "unordered-list") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} /></li>)}</ul>;
        }
        if (block.type === "ordered-list") {
          return <ol key={index} start={block.start}>{block.items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} /></li>)}</ol>;
        }
        if (block.type === "task-list") {
          return (
            <ul className="task-list" key={index}>
              {block.items.map((item) => (
                <li key={item.lineIndex}>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    aria-label={`${item.checked ? "Mark incomplete" : "Mark complete"}: ${item.text}`}
                    onChange={(event) => onTaskToggle?.(item.lineIndex, event.currentTarget.checked)}
                    onDoubleClick={(event) => event.stopPropagation()}
                  />
                  <span className={item.checked ? "task-complete" : undefined}><MarkdownInline text={item.text} /></span>
                </li>
              ))}
            </ul>
          );
        }
        return <p key={index}><MarkdownInline text={block.text} /></p>;
      })}
    </div>
  );
}
