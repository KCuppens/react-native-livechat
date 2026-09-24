import { env } from "cloudflare:test";
import type { Conversation, Message, ServerEvent, SessionResponse } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { sendEmail } from "../src/lib/mailer";
import { createWorkspace } from "../src/services/workspaces";
import { setupAgentWorkspace, signIn } from "./agent-helpers";
import { json, setupWorkspace } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function nextEvent(ws: WebSocket, predicate: (e: ServerEvent) => boolean): Promise<ServerEvent> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      const parsed = JSON.parse(e.data as string) as ServerEvent;
      if (predicate(parsed)) {
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function withConversation() {
  const ctx = await setupAgentWorkspace();
  const started = (await (
    await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "Help please" }) })
  ).json()) as { conversation: Conversation };
  return { ...ctx, base: `/agent/w/${ctx.ws.id}`, conversationId: started.conversation.id };
}

describe("start conversation", () => {
  it("keeps the saved message when a side effect fails", async () => {
    const { call, token } = await (async () => {
      const ws = await setupWorkspace();
      const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
      return { ...ws, token: s.token };
    })();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inbox = env.WORKSPACE_INBOX;
    const broken = { ...inbox, idFromName: inbox.idFromName.bind(inbox), get: () => ({ broadcast: () => Promise.reject(new Error("DO down")) }) };
    const res = await app.request(
      "/v1/conversations",
      { method: "POST", headers: { "X-Livechat-Key": (await env.DB.prepare("SELECT publishable_key FROM workspaces ORDER BY created_at DESC LIMIT 1").first<{ publishable_key: string }>())!.publishable_key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: json({ clientId: "client-0001", body: "still here" }) },
      { ...env, WORKSPACE_INBOX: broken as unknown as typeof inbox },
    );
    expect(res.status).toBe(201);
    const list = (await (await call("/v1/conversations", { token })).json()) as { items: Conversation[] };
    expect(list.items[0]?.lastMessage?.body).toBe("still here");
  });

  it("answers a retry with the contact's own first message, not the auto-reply", async () => {
    const ctx = await setupAgentWorkspace();
    await ctx.admin.call(`/agent/w/${ctx.ws.id}/settings`, {
      method: "PATCH",
      body: json({ officeHours: { enabled: true, timezone: "UTC", windows: [] }, autoReply: { en: "We're closed." } }),
    });
    const send = () => ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "hi" }) });
    await send();
    const retry = (await (await send()).json()) as { message: Message };
    expect(retry.message).toMatchObject({ body: "hi", clientId: "client-0001", authorType: "contact" });
  });
});

describe("agent reply on a resolved conversation", () => {
  it("reopens it and tells the contact", async () => {
    const { admin, base, publicCall, contactToken, conversationId } = await withConversation();
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const ws = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    ws.accept();
    const status = nextEvent(ws, (e) => e.type === "status.changed");
    await admin.call(`${base}/conversations/${conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "One more thing" }) });
    expect(await status).toMatchObject({ type: "status.changed", status: "open" });
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.map((m) => m.systemEvent).slice(-2)).toEqual(["reopened", null]); // notice, then the reply
    ws.close();
  });
});

describe("tenancy", () => {
  it("an admin of workspace A cannot touch workspace B's conversations through A's routes", async () => {
    const a = await setupAgentWorkspace();
    const b = await withConversation(); // same super admin, a second workspace
    const path = `/agent/w/${a.ws.id}/conversations/${b.conversationId}`;
    expect((await a.admin.call(path)).status).toBe(404);
    expect((await a.admin.call(`${path}/messages`)).status).toBe(404);
    expect((await a.admin.call(`${path}/messages`, { method: "POST", body: json({ clientId: "agent-client-x", body: "hi" }) })).status).toBe(404);
    expect((await a.admin.call(path, { method: "PATCH", body: json({ status: "resolved" }) })).status).toBe(404);
    expect((await a.admin.call(`${path}/ws`, { headers: { Upgrade: "websocket" } })).status).toBe(404);
  });

  it("rejects a contact token from another workspace", async () => {
    const a = await setupWorkspace();
    const b = await setupWorkspace();
    const s = (await (await a.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const res = await b.call("/v1/conversations", { token: s.token });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_token" } });
  });
});

describe("member removal", () => {
  it("admins remove agents (and their live sockets); agents and self-removal are refused", async () => {
    const { admin, ws, base, conversationId } = await withConversation();
    await admin.call(`/agent/workspaces/${ws.id}/members`, { method: "POST", body: json({ email: "sam@acme.com", name: "Sam" }) });
    await admin.call(`/agent/workspaces/${ws.id}/members`, { method: "POST", body: json({ email: "lee@acme.com", name: "Lee" }) });
    const sam = await signIn("sam@acme.com");
    const lee = await signIn("lee@acme.com");
    const samId = (await env.DB.prepare("SELECT id FROM agents WHERE email = 'sam@acme.com'").first<{ id: string }>())!.id;
    const leeId = (await env.DB.prepare("SELECT id FROM agents WHERE email = 'lee@acme.com'").first<{ id: string }>())!.id;
    const ownerId = (await env.DB.prepare("SELECT id FROM agents WHERE email = 'owner@acme.com'").first<{ id: string }>())!.id;

    expect((await lee.call(`/agent/workspaces/${ws.id}/members/${samId}`, { method: "DELETE" })).status).toBe(403);
    expect((await admin.call(`/agent/workspaces/${ws.id}/members/${ownerId}`, { method: "DELETE" })).status).toBe(400);

    const room = (await sam.call(`${base}/conversations/${conversationId}/ws`, { headers: { Upgrade: "websocket" } })).webSocket!;
    const inbox = (await sam.call(`${base}/inbox/ws`, { headers: { Upgrade: "websocket" } })).webSocket!;
    room.accept();
    inbox.accept();
    const roomClosed = new Promise<number>((r) => room.addEventListener("close", (e) => r(e.code)));
    const inboxClosed = new Promise<number>((r) => inbox.addEventListener("close", (e) => r(e.code)));

    expect((await admin.call(`/agent/workspaces/${ws.id}/members/${samId}`, { method: "DELETE" })).status).toBe(204);
    expect(await roomClosed).toBe(4003);
    expect(await inboxClosed).toBe(4003);
    expect((await sam.call(`${base}/conversations`)).status).toBe(404);
    void leeId;
  });
});

describe("push devices", () => {
  it("re-registering moves a token to the new contact; only its owner can delete it", async () => {
    const ws = await setupWorkspace();
    const session = async (deviceId: string) =>
      ((await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId }) })).json()) as SessionResponse).token;
    const a = await session("device-000a-0123456789ab");
    const b = await session("device-000b-0123456789ab");
    const device = json({ platform: "android", token: "fcm-shared", appId: "com.acme" });
    expect((await ws.call("/v1/push-devices", { method: "POST", token: a, body: device })).status).toBe(204);
    await ws.call("/v1/push-devices", { method: "POST", token: b, body: device });
    const owner = async () => (await env.DB.prepare("SELECT c.device_id FROM push_devices p JOIN contacts c ON c.id = p.contact_id WHERE p.token = 'fcm-shared'").first<{ device_id: string }>())?.device_id;
    expect(await owner()).toBe("device-000b-0123456789ab");

    await ws.call("/v1/push-devices/fcm-shared", { method: "DELETE", token: a });
    expect(await owner()).toBe("device-000b-0123456789ab");
    await ws.call("/v1/push-devices/fcm-shared", { method: "DELETE", token: b });
    expect(await owner()).toBeUndefined();
  });
});

describe("paging and idempotency", () => {
  it("does not skip conversations that share a timestamp", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    for (const id of ["cv_a", "cv_b", "cv_c"]) {
      await env.DB.prepare("INSERT INTO conversations (id, workspace_id, contact_id, last_message_at, created_at) VALUES (?, ?, ?, 1000, 1000)")
        .bind(id, ws.id, s.contact.id)
        .run();
    }
    const first = (await (await ws.call("/v1/conversations?limit=2", { token: s.token })).json()) as { items: Conversation[]; nextCursor: string };
    const second = (await (await ws.call(`/v1/conversations?limit=2&cursor=${first.nextCursor}`, { token: s.token })).json()) as { items: Conversation[] };
    expect([...first.items, ...second.items].map((c) => c.id).sort()).toEqual(["cv_a", "cv_b", "cv_c"]);
    expect((await ws.call("/v1/conversations?cursor=garbage", { token: s.token })).status).toBe(400);
  });

  it("parallel retries with one clientId create one message", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const started = (await (await ws.call("/v1/conversations", { method: "POST", token: s.token, body: json({ clientId: "client-0001", body: "a" }) })).json()) as { conversation: Conversation };
    const send = () => ws.call(`/v1/conversations/${started.conversation.id}/messages`, { method: "POST", token: s.token, body: json({ clientId: "client-dup1", body: "b" }) });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_id = 'client-dup1'").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});

describe("config safety", () => {
  it("never logs email bodies when the EMAIL binding is missing", async () => {
    const log = vi.spyOn(console, "log");
    await expect(sendEmail({ ...env, DEV_EMAIL_LOG: undefined, EMAIL: undefined }, { to: "a@b.co", subject: "Your sign-in link", text: "#token=secret", html: "" })).rejects.toThrow(/EMAIL binding/);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses to serve a deployed host while PUBLIC_URL is not https", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("https://support.example.com/health", {}, env);
    expect(res.status).toBe(500);
    expect((await app.request("http://localhost/health", {}, env)).status).toBe(200);
    const ok = await app.request("https://support.example.com/health", {}, { ...env, PUBLIC_URL: "https://support.example.com", DEV_EMAIL_LOG: undefined });
    expect(ok.status).toBe(200);
    // Dev email logging prints sign-in links: refused on any deployed host.
    const devLog = await app.request("https://support.example.com/health", {}, { ...env, PUBLIC_URL: "https://support.example.com", DEV_EMAIL_LOG: "true" });
    expect(devLog.status).toBe(500);
  });

  void createWorkspace;
});
