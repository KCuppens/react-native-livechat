import { describe, expect, it } from "vitest";
import { clockTime, initials, onColor, relativeTime } from "../web/util";

describe("initials", () => {
  it("returns ? for null, undefined and empty names", () => {
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
    expect(initials("")).toBe("?");
  });

  it("returns ? for whitespace-only names", () => {
    expect(initials("   ")).toBe("?");
  });

  it("uses the first letter of a single name", () => {
    expect(initials("alice")).toBe("A");
  });

  it("uses first and last word for multi-word names", () => {
    expect(initials("  mary jane   watson ")).toBe("MW");
    expect(initials("Bob Smith")).toBe("BS");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

  it("returns 'now' for differences under a minute (past or future)", () => {
    expect(relativeTime(now - 30_000, "en", now)).toBe(rtf.format(0, "second"));
    expect(relativeTime(now + 59_000, "en", now)).toBe("now");
  });

  it("uses minutes under an hour", () => {
    expect(relativeTime(now - 5 * 60_000, "en", now)).toBe(rtf.format(-5, "minute"));
    expect(relativeTime(now - 60_000, "en", now)).toMatch(/1 min/);
  });

  it("uses hours under a day", () => {
    expect(relativeTime(now - 3 * 3600_000, "en", now)).toBe(rtf.format(-3, "hour"));
  });

  it("uses days under a week ('yesterday' for one day)", () => {
    expect(relativeTime(now - 86_400_000, "en", now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, "en", now)).toBe(rtf.format(-3, "day"));
  });

  it("falls back to a short date for a week or older", () => {
    const ts = now - 10 * 86_400_000;
    const expected = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(ts);
    expect(relativeTime(ts, "en", now)).toBe(expected);
    expect(expected).toMatch(/Jan/);
  });

  it("defaults now to Date.now()", () => {
    expect(relativeTime(Date.now(), "en")).toBe("now");
  });
});

describe("clockTime", () => {
  it("formats hour and minute for the locale", () => {
    const ts = Date.UTC(2026, 0, 15, 9, 7, 0);
    expect(clockTime(ts, "en")).toBe(new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(ts));
    expect(clockTime(ts, "en")).toMatch(/\d{2}:07/);
  });
});

describe("onColor", () => {
  it("returns dark text on light backgrounds", () => {
    expect(onColor("#ffffff")).toBe("#111827");
    expect(onColor("#FDE68A")).toBe("#111827");
  });

  it("returns white text on dark backgrounds", () => {
    expect(onColor("#000000")).toBe("#ffffff");
    expect(onColor("#4F46E5")).toBe("#ffffff");
  });

  it("handles very dark channels in the linear segment", () => {
    expect(onColor("#050505")).toBe("#ffffff");
  });
});
