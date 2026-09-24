import { env } from "cloudflare:test";
import type { Conversation, Message, SessionResponse } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { devOutbox } from "../src/lib/mailer";
import { handleNotification } from "../src/notifications/consumer";
import { savePushCredentials } from "../src/notifications/credentials";
import { setupAgentWorkspace, signIn } from "./agent-helpers";
import { json, setupWorkspace } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function contact(ws: Awaited<ReturnType<typeof setupWorkspace>>, deviceId = "device-0001-0123456789ab") {
  return (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId }) })).json()) as SessionResponse;
}

describe("bulletproof high-risk fixes", () => {
  it("concurrent start retries converge on one conversation with one message", async () => {
    const ws = await setupWorkspace();
    const s = await contact(ws);
    const start = () => ws.call("/v1/conversations", { method: "POST", token: s.token, body: json({ clientId: "client-race-1", body: "hi" }) });
    const results = await Promise.all([start(), start(), start()]);
    const ids = new Set(await Promise.all(results.map(async (r) => ((await r.json()) as { conversation: Conversation }).conversation.id)));
    expect(ids.size).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations WHERE contact_id = ?").bind(s.contact.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const m = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id = 'client-race-1'").first<{ n: number }>();
    expect(m!.n).toBe(1);
  });

  it("caps sign-in emails per address (silently, same 204)", async () => {
    await env.DB.prepare("INSERT INTO agents (id, email, name, created_at) VALUES ('ag_cap', 'cap@acme.com', 'Cap', 1)").run();
    const ask = () =>
      app.request("/agent/auth/magic-link", { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1", "CF-Connecting-IP": `10.0.0.${Math.random() * 250 | 0}` }, body: json({ email: "cap@acme.com" }) }, env);
    const before = devOutbox.filter((m) => m.to === "cap@acme.com").length;
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await ask()).status);
    expect(statuses).toEqual([204, 204, 204, 204, 204]);
    expect(devOutbox.filter((m) => m.to === "cap@acme.com").length - before).toBe(3);
  });

  it("logging out closes that session's sockets but not another session's", async () => {
    const { admin, ws } = await setupAgentWorkspace();
    const other = await signIn("owner@acme.com");
    const mine = (await admin.call(`/agent/w/${ws.id}/inbox/ws`, { headers: { Upgrade: "websocket" } })).webSocket!;
    const theirs = (await other.call(`/agent/w/${ws.id}/inbox/ws`, { headers: { Upgrade: "websocket" } })).webSocket!;
    mine.accept();
    theirs.accept();
    const mineClosed = new Promise<number>((r) => mine.addEventListener("close", (e) => r(e.code)));
    let theirsClosed = false;
    theirs.addEventListener("close", () => (theirsClosed = true));
    await admin.call("/agent/auth/logout", { method: "POST" });
    expect(await mineClosed).toBe(4003);
    expect(theirsClosed).toBe(false);
    theirs.close();
  });

  it("rotating the identity secret revokes existing contact tokens", async () => {
    const { admin, ws, publicCall, contactToken } = await setupAgentWorkspace();
    expect((await publicCall("/v1/conversations", { token: contactToken })).status).toBe(200);
    await admin.call(`/agent/w/${ws.id}/settings/rotate-identity-secret`, { method: "POST" });
    const res = await publicCall("/v1/conversations", { token: contactToken });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_token" } });
    // A fresh session works again (the SDK does this automatically on invalid_token).
    const fresh = (await (await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    expect((await publicCall("/v1/conversations", { token: fresh.token })).status).toBe(200);
  });

  it("requires a random-looking device id", async () => {
    const ws = await setupWorkspace();
    expect((await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "user-42" }) })).status).toBe(400);
  });

  it("/health reports D1 status", async () => {
    const ok = await app.request("http://localhost/health", {}, env);
    expect(await ok.json()).toMatchObject({ ok: true, checks: { d1: { ok: true } } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { prepare: () => ({ first: () => Promise.reject(new Error("no such table: workspaces")) }) };
    const down = await app.request("http://localhost/health", {}, { ...env, DB: broken as unknown as D1Database });
    expect(down.status).toBe(503);
  });

  it("retries a transient push failure for just the failed device", async () => {
    const ctx = await setupAgentWorkspace();
    const started = (await (await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "hi" }) })).json()) as { conversation: Conversation };
    await ctx.publicCall("/v1/push-devices", { method: "POST", token: ctx.contactToken, body: json({ platform: "android", token: "fcm-ok", appId: "com.acme" }) });
    await ctx.publicCall("/v1/push-devices", { method: "POST", token: ctx.contactToken, body: json({ platform: "android", token: "fcm-flaky", appId: "com.acme" }) });
    const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = (await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer;
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    await savePushCredentials(env, ctx.ws.id, "fcm", { project_id: "p", client_email: "retry@acme.iam", private_key: pem });
    const reply = (await (await ctx.admin.call(`/agent/w/${ctx.ws.id}/conversations/${started.conversation.id}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "hello" }) })).json()) as Message;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
      const token = JSON.parse(String(init?.body)).message.token;
      return token === "fcm-flaky" ? new Response("unavailable", { status: 503 }) : Response.json({ name: "ok" });
    });
    const sent = vi.spyOn(env.NOTIFICATIONS, "send").mockResolvedValue(undefined as never);
    await handleNotification(env, { type: "agent_reply", workspaceId: ctx.ws.id, conversationId: started.conversation.id, messageId: reply.id });
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ onlyTokens: ["fcm-flaky"], pushAttempt: 2 }), expect.objectContaining({ delaySeconds: expect.any(Number) }));
  });
});
