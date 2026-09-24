import { describe, expect, it } from "vitest";
import { createTranslator, negotiateLocale } from "./i18n";

describe("i18n", () => {
  it("translates with variables and falls back from region to base locale", () => {
    const t = createTranslator("nl-BE");
    expect(t("chat.typing", { name: "Sam" })).toBe("Sam is aan het typen…");
  });

  it("falls back to English for unknown locales", () => {
    expect(createTranslator("de")("chat.send")).toBe("Send");
  });

  it("prefers overrides over built-ins", () => {
    const t = createTranslator("fr", { fr: { "chat.send": "Go" }, en: { "chat.seen": "Read" } });
    expect(t("chat.send")).toBe("Go");
    expect(t("chat.seen")).toBe("Vu");
  });

  it("negotiates against workspace locales", () => {
    expect(negotiateLocale("nl-BE", ["en", "nl"], "en")).toBe("nl");
    expect(negotiateLocale("de-DE", ["en", "nl"], "nl")).toBe("nl");
    expect(negotiateLocale(undefined, ["en"], "en")).toBe("en");
  });
});
