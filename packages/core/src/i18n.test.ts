import { describe, expect, it } from "vitest";
import { createTranslator, negotiateLocale } from "./i18n";

describe("i18n", () => {
  it("every built-in language keeps the English placeholders", async () => {
    const { en } = await import("./locales/en");
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of ["de", "es", "fr", "ja", "ko", "nl"]) {
      const t = createTranslator(locale);
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        if (key.includes(".one") || key.includes(".other")) continue;
        const text = t(key);
        expect(placeholders(text), `${locale} ${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it("translates with variables and falls back from region to base locale", () => {
    const t = createTranslator("nl-BE");
    expect(t("chat.typing", { name: "Sam" })).toBe("Sam is aan het typen…");
  });

  it("falls back to English for unknown locales", () => {
    expect(createTranslator("pt")("chat.send")).toBe("Send");
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

  it("works without Intl.PluralRules (Hermes on React Native)", () => {
    const original = Intl.PluralRules;
    // @ts-expect-error simulate an engine without PluralRules
    delete Intl.PluralRules;
    try {
      const en = createTranslator("en");
      expect(en("faq.articlesCount", { count: 1 })).toBe("1 article");
      expect(en("faq.articlesCount", { count: 0 })).toBe("0 articles");
      expect(en("faq.articlesCount", { count: 3 })).toBe("3 articles");
      const fr = createTranslator("fr");
      expect(fr("faq.articlesCount", { count: 0 })).toBe("0 article");
      expect(fr("faq.articlesCount", { count: 2 })).toBe("2 articles");
      expect(createTranslator("nl-BE")("faq.articlesCount", { count: 1 })).toBe("1 artikel");
      expect(createTranslator("de")("faq.helpful")).toBe("War dieser Artikel hilfreich?");
      expect(createTranslator("es")("faq.articlesCount", { count: 1 })).toBe("1 artículo");
      expect(createTranslator("ja")("faq.articlesCount", { count: 1 })).toBe("1件の記事");
      expect(createTranslator("ko-KR")("faq.articlesCount", { count: 1 })).toBe("문서 1개");
    } finally {
      Object.defineProperty(Intl, "PluralRules", { value: original, configurable: true, writable: true });
    }
  });
});
