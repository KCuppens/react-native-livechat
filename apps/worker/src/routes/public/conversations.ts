import { CsatRequest, SendMessageRequest, StartConversationRequest, type Message } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { pageLimit, parseJson } from "../../lib/validate";
import { requireContact } from "../../middleware/public";
import { inboxStub, publishToConversation, roomStub } from "../../realtime/publish";
import {
  createConversation,
  findConversationByFirstClientId,
  getContactConversation,
  getContactConversationRow,
  getMessageByClientId,
  insertMessage,
  listContactConversations,
  listMessages,
  unreadCountForContact,
} from "../../services/conversations";
import { afterResponse, bestEffort, conversationChanged } from "../../services/events";
import { refreshWorkspace } from "../../services/workspaces";
import { presentMessage, presentMessages } from "../../services/attachments";
import { maybeAutoReply } from "../../services/automation";

async function contactLocale(db: D1Database, contactId: string) {
  return (await db.prepare("SELECT locale FROM contacts WHERE id = ?").bind(contactId).first<{ locale: string | null }>())?.locale ?? null;
}

export const conversationRoutes = new Hono<AppBindings>()
  .use(requireContact)

  .get("/", async (c) => {
    const { contactId } = c.get("contact");
    return c.json(await listContactConversations(c.env.DB, contactId, c.req.query("cursor") ?? null, pageLimit(c.req.query("limit"), 20, 50)));
  })

  .get("/unread", async (c) => {
    return c.json({ count: await unreadCountForContact(c.env.DB, c.get("contact").contactId) });
  })

  .post("/", async (c) => {
    const { contactId, workspaceId } = c.get("contact");
    const { success } = await c.env.MESSAGE_LIMITER.limit({ key: contactId });
    if (!success) throw new ApiException(429, "rate_limited", "You are sending messages too quickly");
    const body = await parseJson(c, StartConversationRequest);

    const existingId = await findConversationByFirstClientId(c.env.DB, contactId, body.clientId);
    const first = existingId && (await getMessageByClientId(c.env.DB, existingId, body.clientId));
    if (existingId && first) {
      // Retry: answer with the contact's own first message, not whatever came after it.
      const { dto } = await getContactConversation(c.env.DB, contactId, existingId);
      return c.json({ conversation: dto, message: await presentMessage(c.env, first) }, 200);
    }
    // The conversation may exist without its first message (the first attempt died between the
    // two writes, or is still running): fall through; both steps below are idempotent.

    const { id: conversationId, created: newConversation } = await createConversation(c.env.DB, workspaceId, contactId, body.clientId);
    let message: Message;
    let messageCreated: boolean;
    try {
      // Idempotent on clientId: a concurrent retry that lost the conversation race lands here too
      // and gets the same message instead of creating a second conversation.
      ({ message, created: messageCreated } = await insertMessage(c.env.DB, {
        conversationId,
        workspaceId,
        authorType: "contact",
        authorId: contactId,
        clientId: body.clientId,
        body: body.body,
        attachmentIds: body.attachmentIds,
      }));
    } catch (err) {
      // Don't leave an empty conversation behind (e.g. invalid attachments), but never delete one
      // a concurrent retry has already put its message in.
      if (newConversation) {
        await c.env.DB.prepare("DELETE FROM conversations WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = ?1)")
          .bind(conversationId)
          .run()
          .catch((e) => console.error({ msg: "empty conversation cleanup failed", conversationId, error: String(e) }));
      }
      throw err;
    }
    // Whoever saved the first message owns the new-conversation side effects, even if a
    // concurrent retry created the row: otherwise a race can skip them for both requests.
    if (!messageCreated) {
      const { dto } = await getContactConversation(c.env.DB, contactId, conversationId);
      return c.json({ conversation: dto, message: await presentMessage(c.env, message) }, 200);
    }

    // The message is saved: from here on, failures must not undo it (a retry would take the
    // existingId path above and skip all of this).
    const ws = c.get("workspace");
    await afterResponse(c, async () => {
      await bestEffort("agent alert", () => c.env.NOTIFICATIONS.send({ type: "new_conversation", workspaceId, conversationId }));
      await bestEffort("auto-reply", () => maybeAutoReply(c.env, ws, conversationId, () => contactLocale(c.env.DB, contactId)));
      await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, conversationId));
    });
    const { dto } = await getContactConversation(c.env.DB, contactId, conversationId);
    return c.json({ conversation: dto, message: await presentMessage(c.env, message) }, 201);
  })

  .get("/:id", async (c) => {
    const { dto } = await getContactConversation(c.env.DB, c.get("contact").contactId, c.req.param("id"));
    return c.json(dto);
  })

  .get("/:id/messages", async (c) => {
    const row = await getContactConversationRow(c.env.DB, c.get("contact").contactId, c.req.param("id"));
    const page = await listMessages(c.env.DB, row.id, c.req.query("before") ?? null, pageLimit(c.req.query("limit"), 50, 100));
    return c.json({ ...page, items: await presentMessages(c.env, page.items) });
  })

  .post("/:id/messages", async (c) => {
    const { contactId, workspaceId } = c.get("contact");
    const { success } = await c.env.MESSAGE_LIMITER.limit({ key: contactId });
    if (!success) throw new ApiException(429, "rate_limited", "You are sending messages too quickly");
    const row = await getContactConversationRow(c.env.DB, contactId, c.req.param("id"));
    const body = await parseJson(c, SendMessageRequest);

    const { message, created, extraResults } = await insertMessage(c.env.DB, {
      conversationId: row.id,
      workspaceId,
      authorType: "contact",
      authorId: contactId,
      clientId: body.clientId,
      body: body.body,
      attachmentIds: body.attachmentIds,
      // Atomic with the message: decides "reopened" from the stored status, not the one read
      // before the insert.
      extra: [c.env.DB.prepare("UPDATE conversations SET status = 'open' WHERE id = ? AND status = 'resolved' RETURNING id").bind(row.id)],
    });
    if (created) {
      const reopened = (extraResults[0]?.results.length ?? 0) > 0;
      const ws = c.get("workspace");
      await afterResponse(c, async () => {
        await bestEffort("realtime", async () => {
          await publishToConversation(c.env, row.id, { type: "message.created", message });
          if (reopened) {
            await publishToConversation(c.env, row.id, { type: "status.changed", status: "open", assigneeId: row.assignee_id });
          }
        });
        await bestEffort("auto-reply", () => maybeAutoReply(c.env, ws, row.id, () => contactLocale(c.env.DB, contactId)));
        await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, row.id));
      });
    }
    return c.json(await presentMessage(c.env, message), created ? 201 : 200);
  })

  .post("/:id/read", async (c) => {
    const row = await getContactConversationRow(c.env.DB, c.get("contact").contactId, c.req.param("id"));
    const now = Date.now();
    await c.env.DB.prepare("UPDATE conversations SET contact_last_read_at = MAX(contact_last_read_at, ?) WHERE id = ?")
      .bind(now, row.id)
      .run();
    await afterResponse(c, async () => {
      await bestEffort("realtime", () => publishToConversation(c.env, row.id, { type: "read", authorType: "contact", at: now }, "agent"));
      await bestEffort("inbox update", () => conversationChanged(c.env, row.workspace_id, row.id));
    });
    return c.body(null, 204);
  })

  .post("/:id/csat", async (c) => {
    const row = await getContactConversationRow(c.env.DB, c.get("contact").contactId, c.req.param("id"));
    const body = await parseJson(c, CsatRequest);
    if (row.csat_requested_at === null) throw new ApiException(409, "csat_not_requested", "This conversation hasn't asked for a rating");
    await c.env.DB.prepare("UPDATE conversations SET csat_score = ?, csat_comment = ? WHERE id = ?")
      .bind(body.score, body.comment ?? null, row.id)
      .run();
    // The rating is stored; a failed inbox refresh must not tell the contact it wasn't.
    await afterResponse(c, () => bestEffort("inbox update", () => conversationChanged(c.env, row.workspace_id, row.id)));
    return c.body(null, 204);
  })

  .get("/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") throw new ApiException(426, "upgrade_required", "Expected WebSocket upgrade");
    const row = await getContactConversationRow(c.env.DB, c.get("contact").contactId, c.req.param("id"));
    // Sockets outlive requests, so check the token epoch against the current row, not this
    // isolate's cached copy (which may predate a rotation by up to 30s).
    const contact = c.get("contact");
    const ws = await refreshWorkspace(c.env.DB, c.get("workspace"));
    if (contact.epoch !== ws.contact_token_epoch) throw new ApiException(401, "invalid_token", "Session token is invalid or expired");
    const headers = new Headers({ Upgrade: "websocket", "X-Participant-Role": "contact", "X-Token-Epoch": String(contact.epoch) });
    const res = await roomStub(c.env, row.id).fetch(new Request("https://room/ws", { headers }));
    // So rotating the identity secret can find and close this socket (its token is revoked then).
    if (res.status === 101) await afterResponse(c, () => bestEffort("track contact room", () => inboxStub(c.env, row.workspace_id).trackContactRoom(row.id)));
    return res;
  });
