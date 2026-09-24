import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { inboxStub } from "../src/realtime/publish";
import type { Conversation, Message, SessionResponse } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as conversations from "../src/services/conversations";
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

describe("bulletproof round 3 approved fixes", () => {
  it("does not take files from a claim that may still be in flight, and rejects bad ids without waiting", async () => {
    const { ws, publicCall, contactToken, contactId, conversationId } = await withConversation();
    const att = await addAttachment(ws.id, { type: "contact", id: contactId }, "msg_in_flight");
    await env.DB.prepare("UPDATE attachments SET claimed_at = ? WHERE id = ?").bind(Date.now(), att).run();
    const res = await publicCall(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      token: contactToken,
      body: json({ clientId: "client-0005", body: "photo", attachmentIds: [att] }),
    });
    // Retryable: the claim clears up by itself once it's old enough (or its send finishes).
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "attachment_busy" } });

    const started = Date.now();
    const bad = await publicCall(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      token: contactToken,
      body: json({ clientId: "client-0006", body: "x", attachmentIds: ["att_nope"] }),
    });
    expect(bad.status).toBe(400);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rotation only closes sockets on revoked tokens, and a revoked token can't open a new one", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    await admin.call(`/agent/w/${ws.id}/settings/rotate-identity-secret`, { method: "POST" });
    // The upgrade checks the epoch against a fresh row, so an old token can't open a socket.
    const old = await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } });
    expect(old.status).toBe(401);
    const fresh = (await (await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", name: "Kim" }) })).json()) as SessionResponse;
    const sock = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${fresh.token}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    sock.accept();
    let closed = false;
    sock.addEventListener("close", () => {
      closed = true;
    });
    // A second rotation's disconnect with the current epoch leaves this socket alone...
    const { roomStub } = await import("../src/realtime/publish");
    const epoch = (await env.DB.prepare("SELECT contact_token_epoch AS e FROM workspaces WHERE id = ?").bind(ws.id).first<{ e: number }>())!.e;
    await roomStub(env, conversationId).disconnectContacts(epoch);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    // ...and one for a newer epoch closes it.
    await roomStub(env, conversationId).disconnectContacts(epoch + 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it("tells the admin when an invite email hits the per-address cap (the member is still added)", async () => {
    const { admin, ws } = await setupAgentWorkspace();
    const invite = () => admin.call(`/agent/workspaces/${ws.id}/members`, { method: "POST", body: json({ email: "sam@acme.com", role: "agent" }) });
    for (let i = 0; i < 3; i++) expect(await (await invite()).json()).toMatchObject({ inviteEmailSent: true });
    const capped = await invite();
    expect(capped.status).toBe(201);
    expect(await capped.json()).toMatchObject({ email: "sam@acme.com", inviteEmailSent: false });
  });

  it("keeps a reopen (and announces it) when the contact wrote after it and the reply then failed", async () => {
    const { admin, base, conversationId, publicCall, contactToken, contactId, ws } = await withConversation();
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const real = conversations.insertMessage;
    vi.spyOn(conversations, "insertMessage").mockImplementation(async (db, input) => {
      if (input.authorType !== "agent") return real(db, input);
      await real(db, { conversationId, workspaceId: ws.id, authorType: "contact", authorId: contactId, clientId: "client-mid", body: "still there?" });
      throw new Error("d1 hiccup");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await admin.call(`${base}/conversations/${conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-9", body: "Hi" }) });
    expect(res.status).toBe(500);
    const row = await env.DB.prepare("SELECT status FROM conversations WHERE id = ?").bind(conversationId).first<{ status: string }>();
    expect(row?.status).toBe("open");
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.map((m) => m.systemEvent ?? m.body).slice(-2)).toEqual(["reopened", "still there?"]);
  });

  it("retries a failed room disconnect from the inbox alarm", async () => {
    const { ws, publicCall, contactToken, conversationId } = await withConversation();
    const sock = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    sock.accept();
    const closed = new Promise<number>((resolve) => sock.addEventListener("close", (e) => resolve(e.code)));
    const inbox = inboxStub(env, ws.id);
    // As left behind by a rotation whose RPC to this room failed.
    await runInDurableObject(inbox, async (_obj, state) => {
      await state.storage.put("pendingDisconnect", { minEpoch: 99, rooms: [conversationId], attempt: 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(inbox)).toBe(true);
    expect(await closed).toBe(4401);
    await runInDurableObject(inbox, async (_obj, state) => {
      expect(await state.storage.get("pendingDisconnect")).toBeUndefined();
    });
  });
});
