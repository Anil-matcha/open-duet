// A small Markdown reader for assistant replies. It understands what models actually write: headings,
// paragraphs, bold, italic, inline code, code blocks, bullet and numbered lists, quotes and links.
// Anything else is shown as the plain text it is. There is no HTML: nothing in a reply can run or load.

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export type Block =
  | { type: 'paragraph'; spans: Span[] }
  | { type: 'heading'; level: number; spans: Span[] }
  | { type: 'code'; text: string }
  | { type: 'quote'; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] };

const INLINE =
  /`([^`\n]+)`|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![A-Za-z0-9])_(?=[^\s_])([\s\S]*?[^\s_])_(?![A-Za-z0-9])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Only web links are followed. `javascript:`, `intent:`, `file:` and the rest stay plain text. */
export function isSafeLink(href: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(href);
}

export function parseInline(source: string, inherited: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = [];
  let last = 0;
  const push = (text: string, extra: Omit<Span, 'text'> = {}) => {
    if (!text) return;
    const style = { ...inherited, ...extra };
    const previous = spans[spans.length - 1];
    // Neighbouring pieces with the same look are one run of text.
    if (previous && !extra.href && JSON.stringify({ ...previous, text: '' }) === JSON.stringify({ text: '', ...style })) previous.text += text;
    else spans.push({ text, ...style });
  };
  for (const match of source.matchAll(INLINE)) {
    const index = match.index ?? 0;
    push(source.slice(last, index));
    last = index + match[0].length;
    const [, code, bold, bold2, italic, italic2, label, href] = match;
    if (code !== undefined) push(code, { code: true });
    else if (bold !== undefined || bold2 !== undefined) spans.push(...parseInline(bold ?? bold2, { ...inherited, bold: true }));
    else if (italic !== undefined || italic2 !== undefined) spans.push(...parseInline(italic ?? italic2, { ...inherited, italic: true }));
    else if (label !== undefined && href !== undefined) {
      if (isSafeLink(href)) spans.push(...parseInline(label, { ...inherited, href }).map((span) => ({ ...span, href })));
      else push(match[0]);
    }
  }
  push(source.slice(last));
  return spans;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      // A block that is never closed (a reply still being cut off) runs to the end.
      for (i++; i < lines.length && !lines[i].trim().startsWith(marker); i++) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const text = [quote[1]];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) text.push(QUOTE.exec(lines[++i])![1]);
      blocks.push({ type: 'quote', spans: parseInline(text.join('\n')) });
      continue;
    }
    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      flush();
      const pattern = ordered ? NUMBERED : BULLET;
      const items: Span[][] = [];
      let current = pattern.exec(line)![1];
      // A line that is not a new item continues the previous one only when it is indented.
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const item = pattern.exec(next);
        if (item) {
          items.push(parseInline(current));
          current = item[1];
        } else if (/^\s{2,}\S/.test(next) && !BULLET.test(next) && !NUMBERED.test(next)) {
          current += `\n${next.trim()}`;
        } else break;
        i++;
      }
      items.push(parseInline(current));
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
