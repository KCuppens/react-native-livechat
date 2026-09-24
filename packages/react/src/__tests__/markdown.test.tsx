import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../web/markdown";

afterEach(cleanup);

function md(source: string) {
  return render(<Markdown source={source} />).container.querySelector(".lc-md")!;
}

describe("Markdown", () => {
  it("renders inline strong, em, code and line breaks", () => {
    const root = md("Hello **bold** and *it* with `x()`\nnext");
    const p = root.querySelector("p")!;
    expect(p.querySelector("strong")!.textContent).toBe("bold");
    expect(p.querySelector("em")!.textContent).toBe("it");
    expect(p.querySelector("code")!.textContent).toBe("x()");
    expect(p.querySelector("br")).not.toBeNull();
    expect(p.textContent).toBe("Hello bold and it with x()next");
  });

  it("renders nested inline formatting", () => {
    const root = md("**bold _inner_ end**");
    expect(root.querySelector("strong em")!.textContent).toBe("inner");
  });

  it("renders images lazily with alt text when images are enabled (help articles)", () => {
    const img = render(<Markdown source="![A cat](https://img.test/cat.png)" images />).container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://img.test/cat.png");
    expect(img.getAttribute("alt")).toBe("A cat");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("renders safe links opening in a new tab with hardened rel", () => {
    const a = md("See [the **docs**](https://docs.test/a)").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://docs.test/a");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(a.querySelector("strong")!.textContent).toBe("docs");
  });

  it("renders unsafe javascript: links as plain text only", () => {
    const root = md("[click me](javascript:alert(1))");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("click me");
    expect(root.innerHTML).not.toContain("javascript:");
  });

  it("maps heading levels down one and caps at h4", () => {
    const root = md("# One\n\n## Two\n\n### Three\n\n#### Four");
    expect(root.querySelector("h1")).toBeNull();
    expect(root.querySelector("h2")!.textContent).toBe("One");
    expect(root.querySelector("h3")!.textContent).toBe("Two");
    const h4s = Array.from(root.querySelectorAll("h4")).map((h) => h.textContent);
    expect(h4s).toEqual(["Three", "Four"]);
  });

  it("renders unordered and ordered lists", () => {
    const root = md("- a\n- **b**\n\n1. first\n2. second");
    const ul = root.querySelector("ul")!;
    expect(Array.from(ul.querySelectorAll("li")).map((l) => l.textContent)).toEqual(["a", "b"]);
    expect(ul.querySelector("li strong")!.textContent).toBe("b");
    const ol = root.querySelector("ol")!;
    expect(Array.from(ol.querySelectorAll("li")).map((l) => l.textContent)).toEqual(["first", "second"]);
  });

  it("renders blockquotes with nested block content", () => {
    const root = md("> quoted *text*");
    const p = root.querySelector("blockquote > p")!;
    expect(p.textContent).toBe("quoted text");
    expect(p.querySelector("em")).not.toBeNull();
  });

  it("renders fenced code blocks verbatim as pre > code", () => {
    const root = md("```\nconst a = **1**;\n<b>x</b>\n```");
    const code = root.querySelector("pre > code")!;
    expect(code.textContent).toBe("const a = **1**;\n<b>x</b>");
    expect(root.querySelector("strong")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
  });

  it("renders horizontal rules", () => {
    const root = md("above\n\n---\n\nbelow");
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.querySelectorAll("p")).toHaveLength(2);
  });

  it("never interprets raw HTML", () => {
    const root = md('<img src=x onerror="alert(1)"> <script>bad()</script>');
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("<script>");
  });

  it("renders an empty container for empty source", () => {
    expect(md("").childElementCount).toBe(0);
  });
});

describe("markdown images (bulletproof regression)", () => {
  it("renders chat images as a plain link by default, so they can't act as tracking pixels", () => {
    const el = md("![A cat](https://img.test/cat.png)");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a")!.getAttribute("href")).toBe("https://img.test/cat.png");
    expect(el.textContent).toBe("A cat");
  });
});

describe("loading state accessibility (regression)", () => {
  it("labels the web spinner for screen readers", async () => {
    const { Loading } = await import("../web/screens/shared");
    const { LiveChatProvider } = await import("../hooks/context");
    const { LiveChatClient, createMemoryStorage } = await import("@kobecuppens/livechat-core");
    const client = new LiveChatClient({ apiUrl: "https://x", workspaceKey: "pk", storage: createMemoryStorage(), fetch: (async () => new Response("{}")) as unknown as typeof fetch });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Loading />
      </LiveChatProvider>,
    );
    expect(screen.getByRole("status", { name: "Loading…" })).toBeTruthy();
  });
});
