export type LinkifiedPart =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

const URL_PATTERN = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?\)\]\}]$/;

export function toSafeWebHref(value: string): string | null {
  const candidate = value.toLowerCase().startsWith("www.") ? `https://${value}` : value;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

export function tokenizeLinks(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    if (start > cursor) parts.push({ type: "text", text: text.slice(cursor, start) });

    const candidate = match[0];
    let linkText = candidate;
    while (linkText && TRAILING_PUNCTUATION.test(linkText)) linkText = linkText.slice(0, -1);

    const href = linkText ? toSafeWebHref(linkText) : null;
    if (href) {
      parts.push({
        type: "link",
        text: linkText,
        href
      });
    }

    const trailing = candidate.slice(linkText.length);
    if (trailing) parts.push({ type: "text", text: trailing });
    cursor = start + candidate.length;
  }

  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text }];
}
