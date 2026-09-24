import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { de } from "./de";
import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { I18nProvider, LanguageSelect, LOCALES, relativeTime, t, translate, useI18n } from "./index";
import { ja } from "./ja";
import { ko } from "./ko";
import { nl } from "./nl";

const STORAGE_KEY = "lc-dashboard-locale";

afterEach(() => {
  // Mounting a provider with English saved resets the module-level language for the next test.
  localStorage.setItem(STORAGE_KEY, "en");
  render(<I18nProvider>{null}</I18nProvider>);
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalogs", () => {
  it("every language uses the same placeholders as English, and fills every string", () => {
    for (const [name, catalog] of Object.entries({ de, es, fr, ja, ko, nl })) {
      for (const [key, source] of Object.entries(en)) {
        const text = (catalog as Record<string, string>)[key];
        expect(text?.trim(), `${name} ${key}`).toBeTruthy();
        expect(placeholders(text!), `${name} ${key}`).toEqual(placeholders(source));
      }
    }
  });
});

describe("translate", () => {
  it("fills placeholders and leaves unknown ones as written", () => {
    expect(translate("en", "composer.removeFile", { name: "a.png" })).toBe("Remove a.png");
    expect(translate("en", "composer.removeFile")).toBe("Remove {name}");
  });

  it("picks the plural form for the language", () => {
    expect(translate("en", "reports.ratingsCount", { count: 1 })).toBe("1 rating");
    expect(translate("en", "reports.ratingsCount", { count: 0 })).toBe("0 ratings");
    expect(translate("fr", "reports.ratingsCount", { count: 0 })).toBe("0 note");
    expect(translate("de", "reports.ratingsCount", { count: 2 })).toBe("2 Bewertungen");
    expect(translate("ja", "reports.ratingsCount", { count: 1 })).toBe("1件の評価");
  });

  it("formats relative times in the current language", () => {
    const now = Date.now();
    expect(relativeTime(now - 2 * 60_000)).toBe("2 minutes ago");
    expect(relativeTime(now - 1000)).toBe("now");
  });
});

function Probe() {
  const { t: tr, locale } = useI18n();
  return (
    <p>
      {locale}:{tr("nav.settings")}
    </p>
  );
}

describe("I18nProvider", () => {
  it("starts in the first supported browser language, down to its base language", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["pt-BR", "nl-BE", "en"]);
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("nl:Instellingen")).toBeTruthy();
    expect(document.documentElement.lang).toBe("nl");
  });

  it("falls back to English when no browser language is supported", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["pt-BR"]);
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("en:Settings")).toBeTruthy();
  });

  it("switches from the language menu, re-renders, and remembers the choice", () => {
    render(
      <I18nProvider>
        <Probe />
        <LanguageSelect />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual([...LOCALES]);
    act(() => {
      fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "ja" } });
    });
    expect(screen.getByText("ja:設定")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "言語" })).toBeTruthy();
    // Code outside React (toasts, confirm dialogs) follows the switch too.
    expect(t("common.saved")).toBe("保存しました");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("ja");
  });

  it("prefers a saved choice over the browser language, and ignores a bad saved value", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    localStorage.setItem(STORAGE_KEY, "ko");
    const { unmount } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("ko:설정")).toBeTruthy();
    unmount();
    localStorage.setItem(STORAGE_KEY, "xx");
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByText("de:Einstellungen")).toBeTruthy();
  });
});
