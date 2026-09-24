import { describe, expect, it } from "vitest";
import { markdownExcerpt } from "../src/lib/markdown";

describe("markdownExcerpt", () => {
  it("drops emphasis markers without leaving a space before punctuation", () => {
    expect(markdownExcerpt("Open **Today**, tap *Add*, and pick ~~a~~ `one`.")).toBe("Open Today, tap Add, and pick a one.");
  });

  it("keeps hyphens, snake_case and a lone asterisk", () => {
    expect(markdownExcerpt("A sign-in link runs reset_password. 2 * 3 = 6")).toBe("A sign-in link runs reset_password. 2 * 3 = 6");
  });

  it("ends headings and list items as sentences and joins wrapped lines", () => {
    const md = "Intro line\ncontinues here.\n\n## What counts\n\n- Logging daily\n- Streaks!\n\n> Quoted\n\n---";
    expect(markdownExcerpt(md)).toBe("Intro line continues here. What counts. Logging daily. Streaks! Quoted");
  });

  it("handles ordered lists, underscore emphasis and nested quotes", () => {
    expect(markdownExcerpt("1. First step\n2) Second\n\n_Note_ here\n\n> > Deep")).toBe("First step. Second. Note here Deep");
  });

  it("drops rules, spaced rules and table dividers, and keeps table cells", () => {
    expect(markdownExcerpt("Intro\n\n* * *\n\n- - -\n\n___\n\nNext")).toBe("Intro Next");
    expect(markdownExcerpt("| A | B |\n|---|:---:|\n| 1 | 2 |")).toBe("A B 1 2");
    expect(markdownExcerpt("A | B\n--- | ---\n1 | 2")).toBe("A B 1 2");
  });

  it("drops code blocks and images, keeps link text, and truncates", () => {
    expect(markdownExcerpt("See [the guide](https://x.test) ![pic](a.png)\n```\ncode\n```\nDone")).toBe("See the guide Done");
    expect(markdownExcerpt("word ".repeat(50), 20)).toBe("word word word word…");
  });
});
