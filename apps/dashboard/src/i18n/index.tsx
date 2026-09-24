import { negotiateLocale } from "@kobecuppens/livechat-core";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { de } from "./de";
import { type Catalog, type DashKey, en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import { nl } from "./nl";

export type { DashKey };

/** The languages the mobile apps ship; the dashboard offers the same set. */
export const LOCALES = ["en", "de", "es", "fr", "ja", "ko", "nl"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own name, so anyone can find theirs in the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  nl: "Nederlands",
};

const CATALOGS: Record<Locale, Catalog> = { en, de, es, fr, ja, ko, nl };
const STORAGE_KEY = "lc-dashboard-locale";

export type Vars = Record<string, string | number>;

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function translate(locale: Locale, key: DashKey, vars?: Vars): string {
  const catalog = CATALOGS[locale] as Record<string, string>;
  let text = catalog[key] ?? en[key];
  if (typeof vars?.count === "number") {
    const form = catalog[`${key}.${new Intl.PluralRules(locale).select(vars.count)}`];
    if (form !== undefined) text = form;
  }
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

/** A saved choice, else the first browser language we support, else English. */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage blocked: fall through to the browser language.
  }
  const preferred = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const p of preferred) {
    const hit = negotiateLocale(p, [...LOCALES], "");
    if (isLocale(hit)) return hit;
  }
  return "en";
}

// Module-level copy for code outside React (toasts, confirm dialogs, list helpers). The provider
// keeps it in step with its state; without a provider (tests) it stays English.
let current: Locale = "en";

/** Translate in the current dashboard language. Components use `useI18n().t` so they re-render on a switch. */
export function t(key: DashKey, vars?: Vars): string {
  return translate(current, key, vars);
}

export function currentLocale(): Locale {
  return current;
}

export function formatDate(ts: number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(current, options).format(ts);
}

/** "5 minutes ago", "gestern", "3日前"… */
export function relativeTime(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(current, { numeric: "auto" });
  if (Math.abs(s) < 60) return rtf.format(0, "second");
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

/** Fills `{token}` placeholders with elements, e.g. `<code>` inside a translated sentence. */
export function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed sentence never reorder
    return <Fragment key={i}>{name && name in nodes ? nodes[name] : part}</Fragment>;
  });
}

const I18nContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({ locale: "en", setLocale: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setState] = useState<Locale>(() => {
    current = initialLocale();
    return current;
  });
  const setLocale = useCallback((next: Locale) => {
    current = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
    setState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const { locale, setLocale } = useContext(I18nContext);
  const tr = useCallback((key: DashKey, vars?: Vars) => translate(locale, key, vars), [locale]);
  return { t: tr, locale, setLocale };
}

export function LanguageSelect({ className = "select" }: { className?: string }) {
  const { t: tr, locale, setLocale } = useI18n();
  return (
    <select className={className} value={locale} aria-label={tr("common.language")} onChange={(e) => isLocale(e.target.value) && setLocale(e.target.value)}>
      {LOCALES.map((l) => (
        <option key={l} value={l} lang={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
