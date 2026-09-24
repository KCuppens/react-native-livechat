import { env } from "cloudflare:test";
import type { Conversation, Message, ServerEvent, SessionResponse } from "@kobecuppens/livechat-protocol";
import { describe, expect, it } from "vitest";
import { insertMessage } from "../src/services/conversations";
import { json, setupWorkspace } from "./helpers";

async function contactSession(deviceId = "device-0001-0123456789ab") {
  const ws = await setupWorkspace();
  const session = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId }) })).json()) as SessionResponse;
  return { ...ws, token: session.token, contactId: session.contact.id };
}

async function start(call: Awaited<ReturnType<typeof contactSession>>["call"], token: string, body = "Hello", clientId = "client-0001") {
  const res = await call("/v1/conversations", { method: "POST", token, body: json({ clientId, body }) });
  return { res, data: (await res.json()) as { conversation: Conversation; message: Message } };
}

describe("conversations", () => {
  it("requires a contact token", async () => {
    const { call } = await setupWorkspace();
    expect((await call("/v1/conversations")).status).toBe(401);
  });

  it("starts a conversation with its first message", async () => {
    const { call, token, contactId } = await contactSession();
    const { res, data } = await start(call, token);
    expect(res.status).toBe(201);
    expect(data.conversation).toMatchObject({ status: "open", unreadCount: 0 });
    expect(data.message).toMatchObject({ body: "Hello", authorType: "contact", author: { id: contactId } });

    const list = (await (await call("/v1/conversations", { token })).json()) as { items: Conversation[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.lastMessage?.body).toBe("Hello");
  });

  it("is idempotent when starting a conversation is retried", async () => {
    const { call, token } = await contactSession();
    const first = await start(call, token);
    const retry = await start(call, token);
    expect(retry.res.status).toBe(200);
    expect(retry.data.conversation.id).toBe(first.data.conversation.id);
    const list = (await (await call("/v1/conversations", { token })).json()) as { items: Conversation[] };
    expect(list.items).toHaveLength(1);
  });

  it("dedupes message retries by clientId", async () => {
    const { call, token } = await contactSession();
    const { data } = await start(call, token);
    const path = `/v1/conversations/${data.conversation.id}/messages`;
    const a = await call(path, { method: "POST", token, body: json({ clientId: "client-0002", body: "second" }) });
    const b = await call(path, { method: "POST", token, body: json({ clientId: "client-0002", body: "second" }) });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(((await b.json()) as Message).id).toBe(((await a.json()) as Message).id);
  });

  it("isolates conversations between contacts", async () => {
    const owner = await contactSession("device-0001-0123456789ab");
    const { data } = await start(owner.call, owner.token);
    const other = (await (await owner.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0002-0123456789ab" }) })).json()) as SessionResponse;
    const res = await owner.call(`/v1/conversations/${data.conversation.id}/messages`, { token: other.token });
    expect(res.status).toBe(404);
  });

  it("pages messages backwards in ascending order", async () => {
    const { call, token, id: workspaceId } = await contactSession();
    const { data } = await start(call, token, "m0");
    for (let i = 1; i <= 4; i++) {
      await insertMessage(env.DB, {
        conversationId: data.conversation.id, workspaceId, authorType: "system", authorId: null, clientId: null, body: `m${i}`,
      });
    }
    const path = `/v1/conversations/${data.conversation.id}/messages`;
    const newest = (await (await call(`${path}?limit=3`, { token })).json()) as { items: Message[]; nextCursor: string };
    expect(newest.items.map((m) => m.body)).toEqual(["m2", "m3", "m4"]);
    const older = (await (await call(`${path}?limit=3&before=${newest.nextCursor}`, { token })).json()) as { items: Message[]; nextCursor: string | null };
    expect(older.items.map((m) => m.body)).toEqual(["m0", "m1"]);
    expect(older.nextCursor).toBeNull();
  });

  it("tracks unread agent messages until the contact reads", async () => {
    const { call, token, id: workspaceId } = await contactSession();
    const { data } = await start(call, token);
    await env.DB.prepare("INSERT INTO agents (id, email, name, created_at) VALUES ('ag_1', 'sam@acme.com', 'Sam', 1)").run();
    await insertMessage(env.DB, {
      conversationId: data.conversation.id, workspaceId, authorType: "agent", authorId: "ag_1", clientId: null, body: "Hi, I'm Sam",
    });
    expect(await (await call("/v1/conversations/unread", { token })).json()).toEqual({ count: 1 });
    const msgs = (await (await call(`/v1/conversations/${data.conversation.id}/messages`, { token })).json()) as { items: Message[] };
    expect(msgs.items.at(-1)?.author).toEqual({ id: "ag_1", name: "Sam", avatarUrl: null });

    await new Promise((r) => setTimeout(r, 5));
    expect((await call(`/v1/conversations/${data.conversation.id}/read`, { method: "POST", token })).status).toBe(204);
    expect(await (await call("/v1/conversations/unread", { token })).json()).toEqual({ count: 0 });
  });

  it("reopens a resolved conversation when the contact replies", async () => {
    const { call, token } = await contactSession();
    const { data } = await start(call, token);
    await env.DB.prepare("UPDATE conversations SET status = 'resolved' WHERE id = ?").bind(data.conversation.id).run();
    await call(`/v1/conversations/${data.conversation.id}/messages`, { method: "POST", token, body: json({ clientId: "client-0009", body: "one more thing" }) });
    const conv = (await (await call(`/v1/conversations/${data.conversation.id}`, { token })).json()) as Conversation;
    expect(conv.status).toBe("open");
  });

  it("rejects attachments the contact did not upload", async () => {
    const { call, token } = await contactSession();
    const res = await call("/v1/conversations", {
      method: "POST", token, body: json({ clientId: "client-0001", body: "", attachmentIds: ["att_missing"] }),
    });
    expect(res.status).toBe(400);
    const list = (await (await call("/v1/conversations", { token })).json()) as { items: Conversation[] };
    expect(list.items).toHaveLength(0);
  });
});

describe("realtime", () => {
  function nextEvent(ws: WebSocket): Promise<ServerEvent> {
    return new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string)), { once: true }));
  }

  it("streams new messages to a connected contact socket", async () => {
    const { call, token } = await contactSession();
    const { data } = await start(call, token);
    const upgrade = await call(`/v1/conversations/${data.conversation.id}/ws?token=${token}`, { headers: { Upgrade: "websocket" } });
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket!;
    ws.accept();

    const received = nextEvent(ws);
    await call(`/v1/conversations/${data.conversation.id}/messages`, { method: "POST", token, body: json({ clientId: "client-0002", body: "live" }) });
    const event = await received;
    expect(event).toMatchObject({ type: "message.created", message: { body: "live" } });

    const pong = nextEvent(ws);
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await pong).toEqual({ type: "pong" });
    ws.close();
  });

  it("refuses sockets for someone else's conversation", async () => {
    const owner = await contactSession("device-0001-0123456789ab");
    const { data } = await start(owner.call, owner.token);
    const other = (await (await owner.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0002-0123456789ab" }) })).json()) as SessionResponse;
    const res = await owner.call(`/v1/conversations/${data.conversation.id}/ws?token=${other.token}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});
