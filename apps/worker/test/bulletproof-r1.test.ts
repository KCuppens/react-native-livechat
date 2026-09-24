import { env } from "cloudflare:test";
import type { Conversation, Message, SessionResponse } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { devOutbox } from "../src/lib/mailer";
import * as mailer from "../src/lib/mailer";
import { handleNotification, retryDelaySeconds } from "../src/notifications/consumer";
import { setupAgentWorkspace } from "./agent-helpers";
import { json, setupWorkspace } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function withConversation() {
  const ctx = await setupAgentWorkspace();
  const started = (await (
    await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "Help" }) })
  ).json()) as { conversation: Conversation };
  return { ...ctx, base: `/agent/w/${ctx.ws.id}`, conversationId: started.conversation.id };
}

describe("bulletproof round 1 regressions", () => {
  it("a failed digest send gives the cooldown claim back so the retry can send", async () => {
    const { admin, base, ws, conversationId } = await withConversation();
    const reply = (await (await admin.call(`${base}/conversations/${conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "Done" }) })).json()) as Message;
    await env.DB.prepare("UPDATE contacts SET email = 'kim@example.com', verified = 1").run();

    const spy = vi.spyOn(mailer, "sendEmail").mockRejectedValueOnce(new Error("smtp down"));
    await expect(handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt })).rejects.toThrow("smtp down");
    const row = await env.DB.prepare("SELECT last_emailed_at FROM conversations WHERE id = ?").bind(conversationId).first<{ last_emailed_at: number | null }>();
    expect(row?.last_emailed_at).toBeNull();

    spy.mockRestore();
    const before = devOutbox.filter((m) => m.to === "kim@example.com").length;
    await handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt });
    expect(devOutbox.filter((m) => m.to === "kim@example.com").length).toBe(before + 1);
  });

  it("two concurrent resolves post one 'resolved' and one rating request", async () => {
    const { admin, base, publicCall, contactToken, conversationId } = await withConversation();
    const resolve = () => admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const results = await Promise.all([resolve(), resolve()]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.filter((m) => m.systemEvent === "resolved")).toHaveLength(1);
    expect(msgs.items.filter((m) => m.systemEvent === "csat_request")).toHaveLength(1);
  });

  it("rejects oversized uploads streamed without a Content-Length", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set([0x89, 0x50, 0x4e, 0x47]);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ < 12) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    const res = await ws.call("/v1/attachments", { method: "POST", token: s.token, body: stream, headers: { "Content-Type": "image/png" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("rejects control characters in contact names", async () => {
    const ws = await setupWorkspace();
    const res = await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", name: "Kim\r\nBcc: x@evil" }) });
    expect(res.status).toBe(400);
  });

  it("validates new workspaces like settings do", async () => {
    const { admin } = await setupAgentWorkspace();
    const bad = await admin.call("/agent/workspaces", { method: "POST", body: json({ name: "X", defaultLocale: "fr", locales: ["en"] }) });
    expect(bad.status).toBe(400);
    const badOrigin = await admin.call("/agent/workspaces", { method: "POST", body: json({ name: "X", allowedOrigins: ["https://a.com/"] }) });
    expect(badOrigin.status).toBe(400);
  });

  it("varies cacheable public responses on the workspace key", async () => {
    const ws = await setupWorkspace();
    const res = await ws.call("/v1/config");
    expect(res.headers.get("Vary")).toContain("X-Livechat-Key");
  });

  it("backs off exponentially with jitter, capped", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([30, 60, 120, 900]);
  });

  it("a deleted workspace makes notification jobs a no-op instead of a retry loop", async () => {
    await expect(handleNotification(env, { type: "new_conversation", workspaceId: "ws_gone", conversationId: "cv_gone" })).resolves.toBeUndefined();
  });

  it("PATCH still succeeds (and saves) when realtime fan-out fails", async () => {
    const { admin, base, conversationId } = await withConversation();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = env.CONVERSATION_ROOM;
    const broken = { ...room, idFromName: room.idFromName.bind(room), get: () => ({ broadcast: () => Promise.reject(new Error("DO down")) }) };
    const cookie = (admin as unknown as { cookie: string }).cookie;
    const res = await app.request(
      `${base}/conversations/${conversationId}`,
      { method: "PATCH", headers: { Cookie: cookie, "X-Livechat-Dashboard": "1", "Content-Type": "application/json" }, body: json({ status: "resolved" }) },
      { ...env, CONVERSATION_ROOM: broken as unknown as typeof room },
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM conversations WHERE id = ?").bind(conversationId).first<{ status: string }>();
    expect(row?.status).toBe("resolved");
  });
});
