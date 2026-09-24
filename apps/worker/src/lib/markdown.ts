/** A horizontal rule ("---", "* * *") or a table divider row ("|---|:---:|"): no words to keep. */
const RULE_LINE = /^\s*(([-*_]\s*){3,}|\|?(\s*:?-{3,}:?\s*\|?)+)$/;
/** An opening `*` or `_` emphasis marker (keeps the character before it). */
const OPEN_EMPHASIS = /(^|[^\w*])[*_](?=\S)/g;
/** A closing `*` or `_` emphasis marker. Leaves snake_case and a lone "2 * 3" alone. */
const CLOSE_EMPHASIS = /(?<=\S)[*_](?=[^\w*]|$)/g;

/** Plain-text excerpt from markdown for list views (not a renderer). */
export function markdownExcerpt(md: string, max = 160): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n");
  const parts: string[] = [];
  for (const raw of lines) {
    if (RULE_LINE.test(raw)) continue;
    // A heading or list item is its own sentence; a plain line continues its paragraph.
    const block = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(raw);
    let line = raw
      .replace(/^\s*(>\s*)+/, "")
      .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/, "")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(OPEN_EMPHASIS, "$1")
      .replace(CLOSE_EMPHASIS, "")
      .replace(/\|/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (block && !/[.!?:;,…]$/.test(line)) line += ".";
    parts.push(line);
  }
  const text = parts.join(" ");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "article"
  );
}
