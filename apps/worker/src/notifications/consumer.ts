import type { Env } from "../env";
import { emailLayout, sendEmail } from "../lib/mailer";
import { inboxStub, roomStub } from "../realtime/publish";
import { getMessage, unreadCountForContact } from "../services/conversations";
import { findWorkspaceById } from "../services/workspaces";
import { sendApns } from "./apns";
import { loadPushCredentials } from "./credentials";
import { sendFcm } from "./fcm";
import { InvalidPushToken, type NotificationJob, type PushPayload } from "./types";

/** Wait before emailing about an unread reply, so people chatting live don't get emails. */
export const EMAIL_DELAY_SECONDS = 10 * 60;
/** At most one digest email per conversation in this window. */
const EMAIL_COOLDOWN_MS = 60 * 60 * 1000;

/** Push delivery attempts per device (first send + follow-ups). */
const MAX_PUSH_ATTEMPTS = 3;
/** Upper bound for queue retry backoff. */
const MAX_RETRY_DELAY_SECONDS = 15 * 60;

/** Contact-supplied text going into an email subject/heading: no control chars or line breaks, short. */
function mailSafe(value: string, max = 60): string {
  const clean = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function preview(body: string, attachments: number): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return attachments > 0 ? "📎 Attachment" : "";
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

async function pushAgentReply(env: Env, job: Extract<NotificationJob, { type: "agent_reply" }>) {
  const [conv, message] = await Promise.all([
    env.DB.prepare("SELECT contact_id FROM conversations WHERE id = ? AND workspace_id = ?")
      .bind(job.conversationId, job.workspaceId)
      .first<{ contact_id: string }>(),
    getMessage(env.DB, job.messageId),
  ]);
  if (!conv || !message) return;

  // The contact is looking at the conversation: the socket already delivered it.
  if (await roomStub(env, job.conversationId).isContactConnected()) return;

  const { results: allDevices } = await env.DB.prepare("SELECT token, platform, app_id, sandbox FROM push_devices WHERE contact_id = ?")
    .bind(conv.contact_id)
    .all<{ token: string; platform: "ios" | "android"; app_id: string; sandbox: number }>();
  const devices = job.onlyTokens ? allDevices.filter((d) => job.onlyTokens!.includes(d.token)) : allDevices;
  if (devices.length === 0) return;

  const [creds, ws, badge] = await Promise.all([
    // Undecryptable credentials (e.g. after an ENCRYPTION_KEY rotation) won't fix themselves on retry.
    loadPushCredentials(env, job.workspaceId).catch((err: unknown) => {
      logError("push credentials unreadable", err, job);
      return null;
    }),
    findWorkspaceById(env.DB, job.workspaceId),
    unreadCountForContact(env.DB, conv.contact_id),
  ]);
  if (!creds || !ws) return;
  const payload: PushPayload = {
    title: message.author?.name ?? ws.name,
    body: preview(message.body, message.attachments.length),
    badge,
    data: { type: "livechat", workspaceId: job.workspaceId, conversationId: job.conversationId, messageId: message.id },
  };

  const failures: unknown[] = [];
  const retryTokens: string[] = [];
  await Promise.all(
    devices.map(async (d) => {
      try {
        if (d.platform === "android" && creds.fcm) await sendFcm(creds.fcm, d.token, payload);
        else if (d.platform === "ios" && creds.apns) await sendApns(creds.apns, { token: d.token, appId: d.app_id, sandbox: d.sandbox === 1 }, payload);
      } catch (err) {
        if (!(err instanceof InvalidPushToken)) {
          failures.push(err);
          retryTokens.push(d.token);
          return;
        }
        // Cleanup is best-effort: failing it must not fail (and re-push) the whole job.
        await env.DB.prepare("DELETE FROM push_devices WHERE token = ?")
          .bind(d.token)
          .run()
          .catch((e: unknown) => logError("push device cleanup failed", e, job));
      }
    }),
  );
  if (failures.length > 0) logError("push failures", failures, job);

  // Retry transient failures (5xx, timeouts) for just those devices, so devices that already
  // got the push don't get it twice. Rejecting the whole job would re-push to everyone.
  const attempt = job.pushAttempt ?? 1;
  if (retryTokens.length > 0 && attempt < MAX_PUSH_ATTEMPTS) {
    // Never reject after some devices got the push: a whole-job retry would push them again.
    await env.NOTIFICATIONS.send({ ...job, onlyTokens: retryTokens, pushAttempt: attempt + 1 }, { delaySeconds: retryDelaySeconds(attempt) })
      .catch((e: unknown) => logError("push retry enqueue failed", e, job));
  }
}

async function emailDigest(env: Env, job: Extract<NotificationJob, { type: "email_digest" }>) {
  const row = await env.DB.prepare(
    // Only verified contacts: an anonymous visitor could type anyone's address and make us email them.
    `SELECT c.contact_last_read_at, c.last_emailed_at, ct.email
     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = ? AND c.workspace_id = ? AND ct.verified = 1`,
  )
    .bind(job.conversationId, job.workspaceId)
    .first<{ contact_last_read_at: number; last_emailed_at: number | null; email: string | null }>();
  if (!row?.email || row.contact_last_read_at >= job.since) return;
  if (row.last_emailed_at && Date.now() - row.last_emailed_at < EMAIL_COOLDOWN_MS) return;

  const { results } = await env.DB.prepare(
    `SELECT m.body, a.name AS author FROM messages m LEFT JOIN agents a ON a.id = m.author_id
     WHERE m.conversation_id = ? AND m.author_type = 'agent' AND m.created_at > ? ORDER BY m.id LIMIT 10`,
  )
    .bind(job.conversationId, row.contact_last_read_at)
    .all<{ body: string; author: string | null }>();
  if (results.length === 0) return;

  const ws = await findWorkspaceById(env.DB, job.workspaceId);
  if (!ws) return;
  const lines = results.map((m) => `${m.author ?? ws.name}: ${preview(m.body, 0) || "📎"}`);
  // Claim the cooldown first so a concurrent or retried job can't double-send...
  const claimedAt = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE conversations SET last_emailed_at = ? WHERE id = ? AND (last_emailed_at IS NULL OR last_emailed_at < ?)",
  )
    .bind(claimedAt, job.conversationId, claimedAt - EMAIL_COOLDOWN_MS)
    .run();
  if (claim.meta.changes === 0) return;

  const mail = {
    to: row.email,
    fromName: ws.name,
    subject: `New reply from ${ws.name}`,
    // No contact-supplied name in the greeting: it's user input going into our branded mail.
    text: `Hi,\n\nYou have unread replies:\n\n${lines.join("\n")}\n\nOpen the app to continue the conversation.`,
    html: emailLayout({
      heading: `New reply from ${ws.name}`,
      paragraphs: ["Hi, you have unread replies:", ...lines, "Open the app to continue the conversation."],
    }),
  };
  try {
    await sendEmail(env, mail);
  } catch (err) {
    // ...but give the claim back if the send failed, or the queue retry would find it taken.
    await env.DB.prepare("UPDATE conversations SET last_emailed_at = ? WHERE id = ? AND last_emailed_at = ?")
      .bind(row.last_emailed_at, job.conversationId, claimedAt)
      .run();
    throw err;
  }
}

async function notifyAgents(env: Env, job: Extract<NotificationJob, { type: "new_conversation" }>) {
  if ((await inboxStub(env, job.workspaceId).onlineAgentIds()).length > 0) return;
  const { results: agents } = await env.DB.prepare(
    "SELECT a.email FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.workspace_id = ?",
  )
    .bind(job.workspaceId)
    .all<{ email: string }>();
  const first = await env.DB.prepare(
    `SELECT m.body, ct.name, ct.email FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN contacts ct ON ct.id = c.contact_id WHERE m.conversation_id = ? ORDER BY m.id LIMIT 1`,
  )
    .bind(job.conversationId)
    .first<{ body: string; name: string | null; email: string | null }>();
  const ws = await findWorkspaceById(env.DB, job.workspaceId);
  if (!ws) return;
  const who = mailSafe(first?.name ?? first?.email ?? "") || "A customer";
  const url = `${env.PUBLIC_URL}/w/${job.workspaceId}/inbox/${job.conversationId}`;
  // allSettled: one bad address must not make the queue retry (and re-email) everyone else.
  const results = await Promise.allSettled(
    agents.map((a) =>
      sendEmail(env, {
        to: a.email,
        subject: `[${ws.name}] New conversation from ${who}`,
        text: `${who} wrote:\n\n${preview(first?.body ?? "", 0)}\n\nReply: ${url}`,
        html: emailLayout({
          heading: `New conversation from ${who}`,
          paragraphs: [preview(first?.body ?? "", 0) || "📎 Attachment"],
          button: { label: "Open in inbox", url },
        }),
      }),
    ),
  );
  for (const r of results) if (r.status === "rejected") logError("agent alert email failed", r.reason, job);
}

export async function handleNotification(env: Env, job: NotificationJob): Promise<void> {
  switch (job.type) {
    case "agent_reply":
      return pushAgentReply(env, job);
    case "email_digest":
      return emailDigest(env, job);
    case "new_conversation":
      return notifyAgents(env, job);
  }
}

/** Structured log line: Workers Logs indexes the fields, so failures can be filtered by job type/workspace. */
function logError(msg: string, err: unknown, job?: NotificationJob, attempts?: number) {
  const errors = (Array.isArray(err) ? err : [err]).map((e) =>
    e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
  );
  console.error({ msg, job: job && { type: job.type, workspaceId: job.workspaceId, conversationId: job.conversationId }, attempts, errors });
}

/** Capped exponential backoff with jitter, so a burst that failed together doesn't retry together. */
export function retryDelaySeconds(attempts: number): number {
  const base = Math.min(MAX_RETRY_DELAY_SECONDS, 30 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export async function consumeNotifications(batch: MessageBatch<NotificationJob>, env: Env): Promise<void> {
  // Jobs are independent: run the batch concurrently, acking/retrying each one on its own.
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        await handleNotification(env, msg.body);
        msg.ack();
      } catch (err) {
        logError("notification failed", err, msg.body, msg.attempts);
        msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
      }
    }),
  );
}
