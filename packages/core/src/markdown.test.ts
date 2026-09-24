import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("markdown", () => {
  it("parses blocks", () => {
    const md = "# Title\n\nSome **bold** and *em* text.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```\ncode\n```\n\n---";
    expect(parseMarkdown(md).map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "codeblock", "rule"]);
  });

  it("parses inline formatting and links", () => {
    expect(parseInline("Go to **Settings → Billing** and [read more](https://x.com/a)")).toEqual([
      { type: "text", text: "Go to " },
      { type: "strong", children: [{ type: "text", text: "Settings → Billing" }] },
      { type: "text", text: " and " },
      { type: "link", href: "https://x.com/a", children: [{ type: "text", text: "read more" }] },
    ]);
  });

  it("drops unsafe link and image protocols", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ type: "text", text: "click" }, { type: "text", text: ")" }]);
    expect(parseInline("![x](data:image/png;base64,AAAA)")).toEqual([{ type: "text", text: "x" }]);
  });

  it("treats html as plain text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "<script>alert(1)</script>" }] },
    ]);
  });

  it("autolinks bare urls and keeps snake_case words intact", () => {
    expect(parseInline("see https://acme.com/help. my_var_name")).toEqual([
      { type: "text", text: "see " },
      { type: "link", href: "https://acme.com/help", children: [{ type: "text", text: "https://acme.com/help" }] },
      { type: "text", text: ". my_var_name" },
    ]);
  });
});

describe("markdown regressions", () => {
  it("nests italic at the end of bold (***)", () => {
    expect(parseInline("**bold *inner***")).toEqual([
      { type: "strong", children: [{ type: "text", text: "bold " }, { type: "em", children: [{ type: "text", text: "inner" }] }] },
    ]);
  });

  it("parses ***both*** as bold around italic", () => {
    expect(parseInline("***both***")).toEqual([{ type: "strong", children: [{ type: "em", children: [{ type: "text", text: "both" }] }] }]);
  });

  it("still closes bold before following text and separate emphasis", () => {
    expect(parseInline("**a** and *b*")).toEqual([
      { type: "strong", children: [{ type: "text", text: "a" }] },
      { type: "text", text: " and " },
      { type: "em", children: [{ type: "text", text: "b" }] },
    ]);
    expect(parseInline("__x__ y")).toEqual([{ type: "strong", children: [{ type: "text", text: "x" }] }, { type: "text", text: " y" }]);
  });
});

describe("markdown images (opt-in)", () => {
  it("renders images only when enabled; otherwise a plain link", () => {
    expect(parseInline("![pixel](https://evil.test/p.gif)")).toEqual([
      { type: "link", href: "https://evil.test/p.gif", children: [{ type: "text", text: "pixel" }] },
    ]);
    expect(parseInline("![pixel](https://evil.test/p.gif)", { images: true })).toEqual([{ type: "image", src: "https://evil.test/p.gif", alt: "pixel" }]);
    expect(parseMarkdown("> ![a](https://x.test/a.png)", { images: true })[0]).toMatchObject({ type: "quote", children: [{ children: [{ type: "image" }] }] });
  });
});
