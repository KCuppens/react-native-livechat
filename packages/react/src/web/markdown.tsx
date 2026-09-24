import { parseMarkdown, type Block, type Inline } from "@kobecuppens/livechat-core";
import { Fragment, useMemo, type ReactNode } from "react";

function renderInline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case "text":
        return <Fragment key={k}>{n.text}</Fragment>;
      case "strong":
        return <strong key={k}>{renderInline(n.children, k)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.children, k)}</em>;
      case "code":
        return <code key={k}>{n.text}</code>;
      case "break":
        return <br key={k} />;
      case "image":
        return <img key={k} src={n.src} alt={n.alt} loading="lazy" />;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {renderInline(n.children, k)}
          </a>
        );
    }
  });
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.type) {
    case "heading": {
      const H = `h${Math.min(b.level + 1, 4)}` as "h2" | "h3" | "h4";
      return <H key={i}>{renderInline(b.children)}</H>;
    }
    case "paragraph":
      return <p key={i}>{renderInline(b.children)}</p>;
    case "list": {
      const L = b.ordered ? "ol" : "ul";
      return (
        <L key={i}>
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </L>
      );
    }
    case "quote":
      return <blockquote key={i}>{b.children.map(renderBlock)}</blockquote>;
    case "codeblock":
      return (
        <pre key={i}>
          <code>{b.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={i} />;
  }
}

/**
 * Renders markdown from the safe AST: raw HTML is never interpreted. Images are off unless
 * `images` is set (help articles): in chat they'd be tracking pixels.
 */
export function Markdown({ source, images = false }: { source: string; images?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(source, { images }), [source, images]);
  return <div className="lc-md">{blocks.map(renderBlock)}</div>;
}
