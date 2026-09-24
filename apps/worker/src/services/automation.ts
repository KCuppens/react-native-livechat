import { isWithinOfficeHours, type OfficeHours } from "@kobecuppens/livechat-protocol";
import type { Env } from "../env";
import { publishToConversation } from "../realtime/publish";
import { insertMessage } from "./conversations";
import type { WorkspaceRow } from "./workspaces";

const AUTO_REPLY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/** Outside office hours, answer the first contact message with the workspace's away message. */
export async function maybeAutoReply(
  env: Env,
  ws: WorkspaceRow,
  conversationId: string,
  /** Loaded lazily: during office hours (most traffic) no lookup is needed at all. */
  getContactLocale: () => Promise<string | null>,
): Promise<void> {
  if (isWithinOfficeHours(JSON.parse(ws.office_hours) as OfficeHours)) return;
  const texts = JSON.parse(ws.auto_reply) as Record<string, string>;
  if (Object.keys(texts).length === 0) return;
  const contactLocale = await getContactLocale();
  const body = (contactLocale && texts[contactLocale]) || texts[ws.default_locale] || Object.values(texts)[0];
  if (!body) return;

  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE conversations SET auto_replied_at = ? WHERE id = ? AND (auto_replied_at IS NULL OR auto_replied_at < ?)",
  )
    .bind(now, conversationId, now - AUTO_REPLY_COOLDOWN_MS)
    .run();
  if (claim.meta.changes === 0) return;

  let message: Awaited<ReturnType<typeof insertMessage>>["message"];
  try {
    ({ message } = await insertMessage(env.DB, {
      conversationId, workspaceId: ws.id, authorType: "system", authorId: null, clientId: null, body, systemEvent: "auto_reply",
    }));
  } catch (err) {
    // Give the claim back, or a failed insert would silence the away message for 12 hours.
    await env.DB.prepare("UPDATE conversations SET auto_replied_at = NULL WHERE id = ? AND auto_replied_at = ?")
      .bind(conversationId, now)
      .run()
      .catch((e) => console.error({ msg: "auto-reply claim release failed", conversationId, error: String(e) }));
    throw err;
  }
  await publishToConversation(env, conversationId, { type: "message.created", message });
}
