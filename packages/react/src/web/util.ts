export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase() || "?";
}

// Intl constructors are expensive; message lists format on every render, so cache per locale.
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();
const clockCache = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, locale: string, make: () => T): T {
  let f = cache.get(locale);
  if (!f) {
    f = make();
    cache.set(locale, f);
  }
  return f;
}

/** "2 min ago" / "yesterday" / date, localized. */
export function relativeTime(ts: number, locale: string, now = Date.now()): string {
  const diff = (ts - now) / 1000;
  const rtf = cached(rtfCache, locale, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }));
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 7 * 86400) return rtf.format(Math.round(diff / 86400), "day");
  return cached(dateCache, locale, () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })).format(ts);
}

export function clockTime(ts: number, locale: string): string {
  return cached(clockCache, locale, () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })).format(ts);
}

export { onColor } from "@kobecuppens/livechat-core";
