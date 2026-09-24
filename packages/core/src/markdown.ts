/**
 * Tiny markdown → AST parser for help articles and chat messages. The AST is rendered
 * natively by each UI package, so raw HTML is never interpreted (sanitized by design).
 * Supports: headings, paragraphs, bold, italic, inline code, code blocks, links, images,
 * ordered/unordered lists, blockquotes and horizontal rules.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "break" };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Block[] }
  | { type: "codeblock"; text: string }
  | { type: "rule" };

const SAFE_URL = /^(https?:\/\/|mailto:|tel:)/i;

export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return SAFE_URL.test(trimmed) ? trimmed : null;
}

export interface MarkdownOptions {
  /**
   * Render `![alt](url)` as an image. Off by default: remote images load automatically, so in
   * chat they'd act as tracking pixels (reader IP and read time). Help articles turn it on.
   */
  images?: boolean;
}

export function parseInline(src: string, opts: MarkdownOptions = {}): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;

    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_[\]()!#>-]/.test(rest[1]!)) {
      text += rest[1];
      i += 2;
      continue;
    }
    if (rest[0] === "\n") {
      flush();
      out.push({ type: "break" });
      i++;
      continue;
    }
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ type: "code", text: m[1]! });
      i += m[0].length;
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      const src = safeUrl(m[2]!);
      if (src && /^https?:/i.test(src)) {
        flush();
        // Without images, keep it reachable as a plain link the reader chooses to open.
        out.push(opts.images ? { type: "image", src, alt: m[1]! } : { type: "link", href: src, children: [{ type: "text", text: m[1] || src }] });
      } else {
        text += m[1];
      }
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = safeUrl(m[2]!);
      flush();
      if (href) out.push({ type: "link", href, children: parseInline(m[1]!, opts) });
      else out.push(...parseInline(m[1]!, opts));
      i += m[0].length;
      continue;
    }
    if ((m = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.exec(rest)) && (i === 0 || /\s/.test(src[i - 1]!))) {
      flush();
      out.push({ type: "link", href: m[1]!, children: [{ type: "text", text: m[1]! }] });
      i += m[0].length;
      continue;
    }
    // The closing delimiter may not be followed by the same marker: in "**bold *inner***"
    // the first "**" belongs to the "***" run, so bold must close on the last two stars.
    if ((m = /^(?:\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)|__(?=\S)([\s\S]*?\S)__(?!_))/.exec(rest))) {
      flush();
      out.push({ type: "strong", children: parseInline((m[1] ?? m[2])!, opts) });
      i += m[0].length;
      continue;
    }
    if ((m = /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![*_])/.exec(rest)) && (m[1] === "*" || i === 0 || /\W/.test(src[i - 1]!))) {
      flush();
      out.push({ type: "em", children: parseInline(m[2]!, opts) });
      i += m[0].length;
      continue;
    }
    text += rest[0];
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(md: string, opts: MarkdownOptions = {}): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const isBlockStart = (line: string) =>
    /^(#{1,4})\s/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^\s*([-*+]|\d+[.)])\s+/.test(line) || /^(\*{3,}|-{3,}|_{3,})\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;

    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence
      blocks.push({ type: "codeblock", text: body.join("\n") });
      continue;
    }
    if ((m = /^(#{1,4})\s+(.*?)\s*#*$/.exec(line))) {
      blocks.push({ type: "heading", level: m[1]!.length as 1 | 2 | 3 | 4, children: parseInline(m[2]!, opts) });
      i++;
      continue;
    }
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n"), opts) });
      continue;
    }
    if ((m = /^\s*([-*+]|\d+[.)])\s+/.exec(line))) {
      const ordered = /\d/.test(m[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (item && /\d/.test(item[1]!) === ordered) {
          items.push(item[2]!);
        } else if (items.length && /^\s{2,}\S/.test(lines[i]!)) {
          items[items.length - 1] += `\n${lines[i]!.trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ type: "list", ordered, items: items.map((item) => parseInline(item, opts)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!);
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n"), opts) });
  }
  return blocks;
}
