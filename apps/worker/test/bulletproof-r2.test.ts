import { env } from "cloudflare:test";
import type { Conversation, FaqArticleSummary, Message, SessionResponse } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import * as mailer from "../src/lib/mailer";
import * as conversations from "../src/services/conversations";
import { devOutbox } from "../src/lib/mailer";
import { setupAgentWorkspace } from "./agent-helpers";
import { json } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function addAttachment(workspaceId: string, uploader: { type: "contact" | "agent"; id: string }, messageId: string | null = null) {
  const id = `att_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO attachments (id, workspace_id, uploader_type, uploader_id, message_id, r2_key, name, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, 'a.png', 'image/png', 10, ?)",
  )
    .bind(id, workspaceId, uploader.type, uploader.id, messageId, `k/${id}`, Date.now())
    .run();
  return id;
}

async function withConversation() {
  const ctx = await setupAgentWorkspace();
  const started = (await (
    await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "Help" }) })
  ).json()) as { conversation: Conversation };
  return { ...ctx, base: `/agent/w/${ctx.ws.id}`, conversationId: started.conversation.id };
}

describe("bulletproof round 2 regressions", () => {
  it("a failed agent reply to a resolved conversation undoes the reopen", async () => {
    const { admin, base, conversationId, publicCall, contactToken } = await withConversation();
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const bad = await admin.call(`${base}/conversations/${conversationId}/messages`, {
      method: "POST",
      body: json({ clientId: "agent-client-1", body: "Hi", attachmentIds: ["att_missing"] }),
    });
    expect(bad.status).toBe(400);
    const row = await env.DB.prepare("SELECT status FROM conversations WHERE id = ?").bind(conversationId).first<{ status: string }>();
    expect(row?.status).toBe("resolved");
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.some((m) => m.systemEvent === "reopened")).toBe(false);
  });

  it("a failed start with a bad attachment leaves no empty conversation", async () => {
    const { publicCall, contactToken, contactId } = await setupAgentWorkspace();
    const res = await publicCall("/v1/conversations", {
      method: "POST",
      token: contactToken,
      body: json({ clientId: "client-bad-1", body: "Hi", attachmentIds: ["att_missing"] }),
    });
    expect(res.status).toBe(400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations WHERE contact_id = ?").bind(contactId).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("takes over an attachment claimed for a message that was never saved", async () => {
    const { ws, publicCall, contactToken, contactId, conversationId } = await withConversation();
    const att = await addAttachment(ws.id, { type: "contact", id: contactId }, "msg_never_saved");
    const res = await publicCall(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      token: contactToken,
      body: json({ clientId: "client-0002", body: "photo", attachmentIds: [att] }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Message).attachments.map((a) => a.id)).toEqual([att]);
  });

  it("still refuses an attachment that belongs to a saved message", async () => {
    const { ws, publicCall, contactToken, contactId, conversationId } = await withConversation();
    const first = (await (
      await publicCall(`/v1/conversations/${conversationId}/messages`, { method: "POST", token: contactToken, body: json({ clientId: "client-0003", body: "x" }) })
    ).json()) as Message;
    const att = await addAttachment(ws.id, { type: "contact", id: contactId }, first.id);
    const res = await publicCall(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      token: contactToken,
      body: json({ clientId: "client-0004", body: "again", attachmentIds: [att] }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a token from a newer epoch than the cached workspace row", async () => {
    const { ws, publicCall, contactToken } = await setupAgentWorkspace();
    // Warm this isolate's cache, then rotate "elsewhere" (straight in D1, no invalidation here).
    expect((await publicCall("/v1/conversations", { token: contactToken })).status).toBe(200);
    await env.DB.prepare("UPDATE workspaces SET contact_token_epoch = contact_token_epoch + 1 WHERE id = ?").bind(ws.id).run();
    // Sessions are signed from a fresh read, so the new token carries the new epoch...
    const fresh = (await (await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0002-0123456789ab" }) })).json()) as SessionResponse;
    // ...and it works, while the old token is revoked.
    expect((await publicCall("/v1/conversations", { token: fresh.token })).status).toBe(200);
    expect((await publicCall("/v1/conversations", { token: contactToken })).status).toBe(401);
  });

  it("a magic link that failed to send does not count toward the per-email cap", async () => {
    await setupAgentWorkspace(); // creates owner@acme.com
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.spyOn(mailer, "sendEmail").mockRejectedValue(new Error("email down"));
    const request = () =>
      app.request(
        "/agent/auth/magic-link",
        { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ email: "owner@acme.com" }) },
        env,
      );
    for (let i = 0; i < 3; i++) await request();
    send.mockRestore();
    const before = devOutbox.length;
    expect((await request()).status).toBe(204);
    expect(devOutbox.slice(before).some((m) => m.to === "owner@acme.com" && m.text.includes("#token="))).toBe(true);
  });

  it("/health fails when the latest migration's columns are missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = {
      prepare: (sql: string) => ({
        first: () => (sql.includes("contact_token_epoch") ? Promise.reject(new Error("no such column: contact_token_epoch")) : Promise.resolve(null)),
      }),
    };
    const res = await app.request("http://localhost/health", {}, { ...env, DB: partial as unknown as D1Database });
    expect(res.status).toBe(503);
  });

  it("search stays inside the workspace and the user's terms can't match the tenant column", async () => {
    const a = await setupAgentWorkspace();
    const b = await setupAgentWorkspace();
    const add = (ctx: typeof a, title: string) =>
      ctx.admin.call(`/agent/w/${ctx.ws.id}/faq/articles`, {
        method: "POST",
        body: json({ translations: { en: { title, bodyMd: "Tap the refund button.", published: true } } }),
      });
    await add(a, "Refunds at A");
    await add(b, "Refunds at B");
    const hits = (await (await a.publicCall("/v1/faq/articles?q=refund")).json()) as FaqArticleSummary[];
    expect(hits.map((h) => h.title)).toEqual(["Refunds at A"]);
    expect(hits[0]!.excerpt).toContain("refund");
    // "ws" is a token of every workspace id; it must not turn into a match-everything query.
    expect(((await (await a.publicCall("/v1/faq/articles?q=ws")).json()) as unknown[]).length).toBe(0);
  });

  it("lists articles in the best locale, limited in SQL, with an excerpt", async () => {
    const ctx = await setupAgentWorkspace();
    await ctx.admin.call(`/agent/w/${ctx.ws.id}/settings`, { method: "PATCH", body: json({ locales: ["en", "nl"] }) });
    for (const n of [1, 2, 3]) {
      await ctx.admin.call(`/agent/w/${ctx.ws.id}/faq/articles`, {
        method: "POST",
        body: json({
          translations: {
            en: { title: `Article ${n}`, bodyMd: `English body ${n}`, published: true },
            ...(n === 1 ? { nl: { title: "Artikel 1", bodyMd: "Nederlandse tekst", published: true } } : {}),
          },
        }),
      });
    }
    // One row per article (its nl translation when there is one), ordered by title.
    const nl = (await (await ctx.publicCall("/v1/faq/articles?locale=nl")).json()) as FaqArticleSummary[];
    expect(nl.map((a) => [a.title, a.locale])).toEqual([
      ["Article 2", "en"],
      ["Article 3", "en"],
      ["Artikel 1", "nl"],
    ]);
    expect(nl[2]!.excerpt).toBe("Nederlandse tekst");
    // The limit applies to articles, not translation rows.
    expect(((await (await ctx.publicCall("/v1/faq/articles?locale=nl&limit=2")).json()) as unknown[]).length).toBe(2);
  });

  it("rotating the identity secret closes open contact sockets with 4401", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const contactWs = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    contactWs.accept();
    const closed = new Promise<number>((resolve) => contactWs.addEventListener("close", (e) => resolve(e.code)));
    await admin.call(`/agent/w/${ws.id}/settings/rotate-identity-secret`, { method: "POST" });
    expect(await closed).toBe(4401);
  });
});

describe("bulletproof round 3 regressions", () => {
  it("a start retry saves the message when the first attempt left the conversation empty", async () => {
    const { ws, publicCall, contactToken, contactId } = await setupAgentWorkspace();
    await env.DB.prepare(
      "INSERT INTO conversations (id, workspace_id, contact_id, first_client_id, last_message_at, contact_last_read_at, created_at) VALUES ('cv_empty', ?, ?, 'client-9', 1, 1, 1)",
    )
      .bind(ws.id, contactId)
      .run();
    const res = await publicCall("/v1/conversations", { method: "POST", token: contactToken, body: json({ clientId: "client-9", body: "Hello?" }) });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { conversation: Conversation; message: Message | null };
    expect(out.conversation.id).toBe("cv_empty");
    expect(out.message?.body).toBe("Hello?");
  });

  it("a resolve whose notice fails is undone, so the retry posts the notice and the rating request", async () => {
    const { admin, base, conversationId, publicCall, contactToken } = await withConversation();
    const real = conversations.insertMessage;
    const spy = vi.spyOn(conversations, "insertMessage").mockImplementationOnce(async (db, input) => {
      if (input.systemEvent === "resolved") throw new Error("d1 hiccup");
      return real(db, input);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    expect(failed.status).toBe(500);
    const row = await env.DB.prepare("SELECT status, csat_requested_at FROM conversations WHERE id = ?").bind(conversationId).first<{ status: string; csat_requested_at: number | null }>();
    expect(row).toMatchObject({ status: "open", csat_requested_at: null });
    spy.mockRestore();
    expect((await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) })).status).toBe(200);
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.filter((m) => m.systemEvent === "resolved")).toHaveLength(1);
    expect(msgs.items.filter((m) => m.systemEvent === "csat_request")).toHaveLength(1);
  });

  it("concurrent sign-in requests can't get past the per-email cap", async () => {
    await setupAgentWorkspace();
    const before = devOutbox.length;
    const request = () =>
      app.request(
        "/agent/auth/magic-link",
        { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ email: "owner@acme.com" }) },
        env,
      );
    await Promise.all(Array.from({ length: 6 }, request));
    // The per-IP route limiter may turn some away first; the cap must never be exceeded.
    const sent = devOutbox.slice(before).filter((m) => m.to === "owner@acme.com" && m.text.includes("#token=")).length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(3);
  });
});
