import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import { ApiError } from "../api";

export function initials(name: string | null | undefined) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1]![0] : "")).toUpperCase();
}

export function Avatar({ name, url }: { name: string | null | undefined; url?: string | null }) {
  return <span className="avatar">{url ? <img src={url} alt="" /> : initials(name)}</span>;
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

let showToast: (msg: string) => void = () => {};
export const toast = (msg: string) => showToast(msg);

/**
 * Runs a user action and reports failure as a toast instead of an unhandled rejection.
 * Resolves true on success so callers can skip follow-up steps after a failure.
 */
export async function attempt(action: () => Promise<unknown>, fallback = "Something went wrong"): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : fallback);
    return false;
  }
}

/**
 * In-flight state for an action button: `run` ignores clicks while one is pending (no double
 * submits) and `busy` drives the disabled state and "Saving…" label.
 */
export function useBusy(): [boolean, (action: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    showToast = (m) => {
      setMsg(m);
      clearTimeout(t);
      // Long enough to read: longer messages (e.g. what to tell an invitee) stay longer.
      t = setTimeout(() => setMsg(null), Math.max(3000, m.length * 70));
    };
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as `children` (wrapping label)
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

const icon = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", viewBox: "0 0 24 24", "aria-hidden": true } as const;
export const InboxIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...icon} {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" /></svg>
);
export const BookIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...icon} {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z" /><path d="M20 22H6.5A2.5 2.5 0 0 1 4 19.5" /></svg>
);
export const ChartIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...icon} {...p}><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg>
);
export const GearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...icon} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
);
