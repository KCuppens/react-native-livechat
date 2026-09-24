import type { Env } from "../env";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  fromName?: string;
}

/** Emails captured when DEV_EMAIL_LOG=true (local dev and tests). */
export const devOutbox: OutgoingEmail[] = [];

export async function sendEmail(env: Env, email: OutgoingEmail): Promise<void> {
  if (env.DEV_EMAIL_LOG === "true") {
    devOutbox.push(email);
    console.log(`[email] to=${email.to} subject=${email.subject}\n${email.text}`);
    return;
  }
  if (!env.EMAIL) {
    // Never log the body: sign-in emails carry login tokens.
    throw new Error(`EMAIL binding is not configured; cannot send "${email.subject}"`);
  }
  await env.EMAIL.send({
    to: email.to,
    from: { email: env.EMAIL_FROM!, name: email.fromName ?? "Support" },
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal, client-safe layout: one column, one optional button. */
export function emailLayout(opts: { heading: string; paragraphs: string[]; button?: { label: string; url: string } }): string {
  const body = opts.paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(p)}</p>`).join("");
  const button = opts.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.button.url)}" style="background:#111827;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(opts.button.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;background:#f9fafb;padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(opts.heading)}</h1>${body}${button}</div></body></html>`;
}
