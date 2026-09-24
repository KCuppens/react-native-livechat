import { AgentReplyRequest, InboxFilter, UpdateConversationRequest, type ConversationStatus, type Message } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { parseJson } from "../../lib/validate";
import { inboxStub, publishToConversation, roomStub } from "../../realtime/publish";
import { getAgentConversation, getAgentConversationRow, listInbox } from "../../services/agent-conversations";
import { getMembership, sessionTag } from "../../services/agents";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../../middleware/agent";
import { claimCsatRequest, getMessageByClientId, insertMessage, listMessages, LAST_MESSAGE_RESYNC_SQL, reopenWithNotice, undoReopen } from "../../services/conversations";
import { afterResponse, bestEffort, conversationChanged } from "../../services/events";
import { presentMessage, presentMessages, storeAttachment } from "../../services/attachments";
import { EMAIL_DELAY_SECONDS } from "../../notifications/consumer";

export const agentConversationRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const parsed = InboxFilter.safeParse(c.req.query());
    if (!parsed.success) throw new ApiException(400, "invalid_request", "Invalid filter");
    return c.json(await listInbox(c.env.DB, c.get("membership").workspaceId, c.get("agent").id, parsed.data));
  })

  .get("/:id", async (c) => {
    const { dto } = await getAgentConversation(c.env.DB, c.get("membership").workspaceId, c.req.param("id"));
    return c.json(dto);
  })

  .get("/:id/messages", async (c) => {
    const row = await getAgentConversationRow(c.env.DB, c.get("membership").workspaceId, c.req.param("id"));
    const page = await listMessages(c.env.DB, row.id, c.req.query("before") ?? null, 50);
    return c.json({ ...page, items: await presentMessages(c.env, page.items) });
  })

  .post("/:id/messages", async (c) => {
    const { workspaceId } = c.get("membership");
    const agent = c.get("agent");
    const row = await getAgentConversationRow(c.env.DB, workspaceId, c.req.param("id"));
    const body = await parseJson(c, AgentReplyRequest);

    // Replying to a resolved conversation reopens it. Do it (and write the "Reopened" notice)
    // before inserting the reply, so the thread reads notice → reply and the reply is the
    // conversation's last message (the inbox preview). Retries skip this.
    const reopenedNotice =
      row.status === "resolved" && !(await getMessageByClientId(c.env.DB, row.id, body.clientId))
        ? await reopenWithNotice(c.env.DB, row.id, workspaceId)
        : null;

    let inserted: Awaited<ReturnType<typeof insertMessage>>;
    try {
      inserted = await insertMessage(c.env.DB, {
        conversationId: row.id,
        workspaceId,
        authorType: "agent",
        authorId: agent.id,
        clientId: body.clientId,
        body: body.body,
        attachmentIds: body.attachmentIds,
        // Replying claims an unassigned conversation and counts as reading it (atomic with the
        // reply). RETURNING gives the stored status/assignee for the events below.
        extra: [
          c.env.DB.prepare(
            "UPDATE conversations SET assignee_id = COALESCE(assignee_id, ?), agent_last_read_at = MAX(agent_last_read_at, ?) WHERE id = ? RETURNING status, assignee_id",
          ).bind(agent.id, Date.now(), row.id),
        ],
      });
    } catch (err) {
      // The reply wasn't saved (e.g. a bad attachment): undo the reopen, or the conversation would
      // stay open with an orphan notice that no client was ever told about.
      if (reopenedNotice) {
        const undone = await undoReopen(c.env.DB, row.id, reopenedNotice.id).catch((e) => {
          console.error({ msg: "undo reopen failed", conversationId: row.id, error: String(e) });
          return false;
        });
        // The reopen stands (something happened after it): tell clients, or they'd keep showing
        // the conversation as resolved.
        if (!undone) {
          await afterResponse(c, async () => {
            await bestEffort("realtime", async () => {
              await publishToConversation(c.env, row.id, { type: "message.created", message: reopenedNotice });
              await publishToConversation(c.env, row.id, { type: "status.changed", status: "open", assigneeId: row.assignee_id });
            });
            await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, row.id));
          });
        }
      }
      throw err;
    }
    const { message, created, extraResults } = inserted;
    if (created) {
      // Publish what's stored, not what was read before the insert: another agent may have
      // assigned it or a concurrent reply may have reopened it meanwhile.
      const stored = (extraResults[0]?.results[0] as { status: ConversationStatus; assignee_id: string | null } | undefined) ?? {
        status: reopenedNotice ? "open" : row.status,
        assignee_id: row.assignee_id ?? agent.id,
      };
      // Everything below is best-effort and runs after the response: the reply is saved, and a
      // client retry (created: false) would skip it, so a failure here must not turn into a 500.
      await afterResponse(c, async () => {
        await bestEffort("notifications", () =>
          c.env.NOTIFICATIONS.sendBatch([
            { body: { type: "agent_reply", workspaceId, conversationId: row.id, messageId: message.id } },
            {
              body: { type: "email_digest", workspaceId, conversationId: row.id, since: message.createdAt },
              delaySeconds: EMAIL_DELAY_SECONDS,
            },
          ]),
        );
        await bestEffort("realtime", async () => {
          if (reopenedNotice) await publishToConversation(c.env, row.id, { type: "message.created", message: reopenedNotice });
          await publishToConversation(c.env, row.id, { type: "message.created", message });
          if (stored.status !== row.status || stored.assignee_id !== row.assignee_id) {
            await publishToConversation(c.env, row.id, { type: "status.changed", status: stored.status, assigneeId: stored.assignee_id });
          }
        });
        await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, row.id));
      });
    }
    return c.json(await presentMessage(c.env, message), created ? 201 : 200);
  })

  .patch("/:id", async (c) => {
    const { workspaceId } = c.get("membership");
    const row = await getAgentConversationRow(c.env.DB, workspaceId, c.req.param("id"));
    const body = await parseJson(c, UpdateConversationRequest);

    // Phase 1: all database writes. Phase 2 (below) only fans out, so a Durable Object
    // hiccup can't leave half-applied changes or skip a system message (e.g. the CSAT request).
    const systemMessages: Message[] = [];
    const addSystem = async (systemEvent: "assigned" | "resolved" | "reopened" | "csat_request", text = "") => {
      const { message } = await insertMessage(c.env.DB, {
        conversationId: row.id, workspaceId, authorType: "system", authorId: null, clientId: null, body: text, systemEvent,
      });
      systemMessages.push(message);
    };

    if (body.assigneeId !== undefined && body.assigneeId !== row.assignee_id) {
      let assigneeName: string | null = null;
      if (body.assigneeId !== null) {
        if (!(await getMembership(c.env.DB, workspaceId, body.assigneeId))) {
          throw new ApiException(400, "invalid_assignee", "Assignee is not a member of this workspace");
        }
        assigneeName = (await c.env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(body.assigneeId).first<{ name: string }>())!.name;
      }
      await c.env.DB.prepare("UPDATE conversations SET assignee_id = ? WHERE id = ?").bind(body.assigneeId, row.id).run();
      if (assigneeName) await addSystem("assigned", assigneeName);
    }

    let status = row.status;
    if (body.status && body.status !== row.status) {
      // Conditional: only the request that actually moves the status emits its events, so a
      // double-click or two agents resolving at once can't post "resolved" twice.
      const changed = await c.env.DB.prepare("UPDATE conversations SET status = ? WHERE id = ? AND status = ? RETURNING status")
        .bind(body.status, row.id, row.status)
        .first<{ status: ConversationStatus }>();
      if (changed) {
        status = changed.status;
        let csatClaimed = false;
        const firstNotice = systemMessages.length;
        try {
          if (body.status === "resolved") {
            await addSystem("resolved");
            if (row.csat_score === null) {
              const ws = await c.env.DB.prepare("SELECT csat_enabled FROM workspaces WHERE id = ?").bind(workspaceId).first<{ csat_enabled: number }>();
              csatClaimed = !!ws?.csat_enabled && (await claimCsatRequest(c.env.DB, row.id));
              if (csatClaimed) await addSystem("csat_request");
            }
          } else if (row.status === "resolved") {
            await addSystem("reopened");
          }
        } catch (err) {
          // Undo the transition so a retry redoes it with its notices (and the rating request):
          // otherwise the retry sees the status already set and skips them for good.
          await c.env.DB.batch([
            c.env.DB.prepare("UPDATE conversations SET status = ? WHERE id = ? AND status = ?").bind(row.status, row.id, body.status),
            ...(csatClaimed ? [c.env.DB.prepare("UPDATE conversations SET csat_requested_at = NULL WHERE id = ?").bind(row.id)] : []),
            ...systemMessages.slice(firstNotice).map((m) => c.env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(m.id)),
            c.env.DB.prepare(LAST_MESSAGE_RESYNC_SQL).bind(row.id),
          ]).catch((e) => console.error({ msg: "status revert failed", conversationId: row.id, error: String(e) }));
          throw err;
        }
      } else {
        status = (await getAgentConversationRow(c.env.DB, workspaceId, row.id)).status;
      }
    }
    const assigneeId = body.assigneeId !== undefined ? body.assigneeId : row.assignee_id;

    await afterResponse(c, async () => {
      await bestEffort("realtime", async () => {
        for (const message of systemMessages) await publishToConversation(c.env, row.id, { type: "message.created", message });
        await publishToConversation(c.env, row.id, { type: "status.changed", status, assigneeId });
      });
      await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, row.id));
    });
    return c.json((await getAgentConversation(c.env.DB, workspaceId, row.id)).dto);
  })

  .post("/:id/read", async (c) => {
    const { workspaceId } = c.get("membership");
    const row = await getAgentConversationRow(c.env.DB, workspaceId, c.req.param("id"));
    const now = Date.now();
    await c.env.DB.prepare("UPDATE conversations SET agent_last_read_at = MAX(agent_last_read_at, ?) WHERE id = ?").bind(now, row.id).run();
    await afterResponse(c, async () => {
      await bestEffort("realtime", () => publishToConversation(c.env, row.id, { type: "read", authorType: "agent", at: now }));
      await bestEffort("inbox update", () => conversationChanged(c.env, workspaceId, row.id));
    });
    return c.body(null, 204);
  })

  .get("/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") throw new ApiException(426, "upgrade_required", "Expected WebSocket upgrade");
    const { workspaceId } = c.get("membership");
    const agent = c.get("agent");
    const row = await getAgentConversationRow(c.env.DB, workspaceId, c.req.param("id"));
    // Remember which rooms this agent joined so removing them from the workspace can disconnect them.
    await inboxStub(c.env, workspaceId).trackRoom(agent.id, row.id);
    const headers = new Headers({
      Upgrade: "websocket",
      "X-Participant-Role": "agent",
      "X-Participant-Name": agent.name,
      "X-Agent-Id": agent.id,
      "X-Session-Tag": await sessionTag(getCookie(c, SESSION_COOKIE)!),
    });
    return roomStub(c.env, row.id).fetch(new Request("https://room/ws", { headers }));
  });

export const inboxSocketRoute = new Hono<AppBindings>().get("/", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") throw new ApiException(426, "upgrade_required", "Expected WebSocket upgrade");
  const headers = new Headers({ Upgrade: "websocket", "X-Agent-Id": c.get("agent").id, "X-Session-Tag": await sessionTag(getCookie(c, SESSION_COOKIE)!) });
  return inboxStub(c.env, c.get("membership").workspaceId).fetch(new Request("https://inbox/ws", { headers }));
});

export const agentAttachmentRoute = new Hono<AppBindings>().post("/", async (c) => {
  const attachment = await storeAttachment(c.env, c.req.raw, c.get("membership").workspaceId, { type: "agent", id: c.get("agent").id });
  return c.json(attachment, 201);
});
