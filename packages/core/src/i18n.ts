import { en, type StringKey, type Strings } from "./locales/en";
import { fr } from "./locales/fr";
import { nl } from "./locales/nl";

export type { StringKey, Strings };

const BUILT_IN: Record<string, Strings> = { en, nl, fr };

export type StringOverrides = Record<string, Partial<Strings>>;

/** "nl-BE" → ["nl-BE", "nl"], always ending with "en". */
export function localeChain(locale: string): string[] {
  const chain = [locale];
  const base = locale.split("-")[0]!;
  if (base !== locale) chain.push(base);
  if (!chain.includes("en")) chain.push("en");
  return chain;
}

/** Picks the best supported locale for `preferred` (e.g. device locale) from `supported`. */
export function negotiateLocale(preferred: string | undefined, supported: string[], fallback: string): string {
  if (!preferred) return fallback;
  // Only the preferred locale and its base language: not localeChain's trailing "en" fallback
  // (which is also the base for English devices, so slicing it off dropped "en" itself).
  const base = preferred.split("-")[0]!;
  for (const candidate of base === preferred ? [preferred] : [preferred, base]) {
    if (supported.includes(candidate)) return candidate;
  }
  return fallback;
}

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

export function createTranslator(locale: string, overrides: StringOverrides = {}): Translate {
  const chain = localeChain(locale);
  const plurals = new Intl.PluralRules(locale);
  const lookup = (key: string): string | undefined => {
    for (const l of chain) {
      const hit = (overrides[l] as Record<string, string> | undefined)?.[key] ?? (BUILT_IN[l] as Record<string, string> | undefined)?.[key];
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return (key, vars) => {
    // Plural forms live under "<key>.one" / "<key>.other" (CLDR categories) when a numeric count is given.
    const pluralKey = typeof vars?.count === "number" ? `${key}.${plurals.select(vars.count)}` : null;
    const text: string = (pluralKey && lookup(pluralKey)) ?? lookup(key) ?? en[key];
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
  };
}
