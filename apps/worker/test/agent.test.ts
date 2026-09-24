import { env } from "cloudflare:test";
import type { AgentConversation, AgentMe, Conversation, InboxEvent, Message, ServerEvent } from "@kobecuppens/livechat-protocol";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { devOutbox } from "../src/lib/mailer";
import { setupAgentWorkspace, signIn } from "./agent-helpers";
import { json } from "./helpers";

function nextEvent<T>(ws: WebSocket, predicate: (e: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      const parsed = JSON.parse(e.data as string) as T;
      if (predicate(parsed)) {
        ws.removeEventListener("message", handler);
        resolve(parsed);
      }
    };
    ws.addEventListener("message", handler);
  });
}

describe("agent auth", () => {
  it("does not reveal whether an email has an account and sends nothing to strangers", async () => {
    const before = devOutbox.length;
    const res = await app.request(
      "/agent/auth/magic-link",
      { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ email: "stranger@x.com" }) },
      env,
    );
    expect(res.status).toBe(204);
    expect(devOutbox.length).toBe(before);
  });

  it("magic links are single use and create a session cookie", async () => {
    const { call, token } = await signIn("owner@acme.com");
    const me = (await (await call("/agent/me")).json()) as AgentMe;
    expect(me).toMatchObject({ agent: { email: "owner@acme.com" }, superAdmin: true });
    const reuse = await app.request(
      "/agent/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ token }) },
      env,
    );
    expect(reuse.status).toBe(400);
  });

  it("requires the CSRF header on mutations", async () => {
    const { cookie } = await signIn("owner@acme.com");
    const res = await app.request("/agent/workspaces", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: json({ name: "x" }) }, env);
    expect(res.status).toBe(403);
  });

  it("logout invalidates the session", async () => {
    const { call } = await signIn("owner@acme.com");
    await call("/agent/auth/logout", { method: "POST" });
    expect((await call("/agent/me")).status).toBe(401);
  });
});

describe("workspaces and members", () => {
  it("only super admins create workspaces; admins invite agents who can then sign in", async () => {
    const { admin, ws } = await setupAgentWorkspace();
    const invite = await admin.call(`/agent/workspaces/${ws.id}/members`, { method: "POST", body: json({ email: "sam@acme.com", name: "Sam" }) });
    expect(invite.status).toBe(201);
    expect(devOutbox.at(-1)).toMatchObject({ to: "sam@acme.com", subject: "You're invited to Acme" });

    const sam = await signIn("sam@acme.com");
    const me = (await (await sam.call("/agent/me")).json()) as AgentMe;
    expect(me.workspaces).toEqual([{ id: ws.id, name: "Acme", role: "agent" }]);
    expect((await sam.call("/agent/workspaces", { method: "POST", body: json({ name: "Mine" }) })).status).toBe(403);
    expect((await sam.call(`/agent/workspaces/${ws.id}/members`, { method: "POST", body: json({ email: "x@y.co" }) })).status).toBe(403);
  });

  it("hides workspaces the agent is not a member of", async () => {
    const { ws } = await setupAgentWorkspace();
    await env.DB.prepare("INSERT INTO agents (id, email, name, created_at) VALUES ('ag_out', 'out@x.com', 'Out', 1)").run();
    const outsider = await signIn("out@x.com");
    expect((await outsider.call(`/agent/w/${ws.id}/conversations`)).status).toBe(404);
  });
});

describe("agent inbox", () => {
  async function withConversation() {
    const ctx = await setupAgentWorkspace();
    const started = (await (
      await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "My order is late" }) })
    ).json()) as { conversation: Conversation };
    return { ...ctx, conversationId: started.conversation.id };
  }

  it("lists conversations with contact info and unread counts, filterable", async () => {
    const { admin, ws } = await withConversation();
    const all = (await (await admin.call(`/agent/w/${ws.id}/conversations`)).json()) as { items: AgentConversation[] };
    expect(all.items).toHaveLength(1);
    expect(all.items[0]).toMatchObject({ unreadCount: 1, contact: { name: "Kim", verified: false }, lastMessage: { body: "My order is late" } });
    const mine = (await (await admin.call(`/agent/w/${ws.id}/conversations?assignee=me`)).json()) as { items: AgentConversation[] };
    expect(mine.items).toHaveLength(0);
    const unassigned = (await (await admin.call(`/agent/w/${ws.id}/conversations?assignee=unassigned&status=open`)).json()) as { items: AgentConversation[] };
    expect(unassigned.items).toHaveLength(1);
  });

  it("agent replies reach the contact live, auto-assign, and mark read", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const upgrade = await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } });
    const contactWs = upgrade.webSocket!;
    contactWs.accept();

    const received = nextEvent<ServerEvent>(contactWs, (e) => e.type === "message.created");
    const reply = await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "On it!" }) });
    expect(reply.status).toBe(201);
    expect(await received).toMatchObject({ message: { body: "On it!", authorType: "agent", author: { name: "owner" } } });

    const conv = (await (await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}`)).json()) as AgentConversation;
    expect(conv.assignee?.name).toBe("owner");
    expect(conv.unreadCount).toBe(0);
    expect(await (await publicCall("/v1/conversations/unread", { token: contactToken })).json()).toEqual({ count: 1 });
    contactWs.close();
  });

  it("streams contact messages to the workspace inbox socket", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const upgrade = await admin.call(`/agent/w/${ws.id}/inbox/ws`, { headers: { Upgrade: "websocket" } });
    expect(upgrade.status).toBe(101);
    const inbox = upgrade.webSocket!;
    inbox.accept();

    const update = nextEvent<InboxEvent>(inbox, (e) => e.type === "conversation.updated");
    await publicCall(`/v1/conversations/${conversationId}/messages`, { method: "POST", token: contactToken, body: json({ clientId: "client-0002", body: "Hello??" }) });
    expect(await update).toMatchObject({ conversation: { id: conversationId, unreadCount: 2, lastMessage: { body: "Hello??" } } });
    inbox.close();
  });

  it("relays typing between contact and agent sockets", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const contactWs = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    const agentWs = (await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}/ws`, { headers: { Upgrade: "websocket" } })).webSocket!;
    contactWs.accept();
    agentWs.accept();

    const atAgent = nextEvent<ServerEvent>(agentWs, (e) => e.type === "typing");
    contactWs.send(JSON.stringify({ type: "typing", typing: true }));
    expect(await atAgent).toEqual({ type: "typing", authorType: "contact", name: null, typing: true });

    const atContact = nextEvent<ServerEvent>(contactWs, (e) => e.type === "typing");
    agentWs.send(JSON.stringify({ type: "typing", typing: true }));
    expect(await atContact).toEqual({ type: "typing", authorType: "agent", name: "owner", typing: true });
    contactWs.close();
    agentWs.close();
  });

  it("assigning and resolving post system messages and status events", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const me = (await (await admin.call("/agent/me")).json()) as AgentMe;
    const res = await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}`, {
      method: "PATCH",
      body: json({ assigneeId: me.agent.id, status: "resolved" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "resolved", assignee: { id: me.agent.id } });

    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.map((m) => m.systemEvent)).toEqual([null, "assigned", "resolved", "csat_request"]);

    const bad = await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}`, { method: "PATCH", body: json({ assigneeId: "ag_nobody" }) });
    expect(bad.status).toBe(400);
  });

  it("rejects cross-origin dashboard sockets", async () => {
    const { admin, ws } = await withConversation();
    const evil = await admin.call(`/agent/w/${ws.id}/inbox/ws`, { headers: { Upgrade: "websocket", Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const ok = await admin.call(`/agent/w/${ws.id}/inbox/ws`, { headers: { Upgrade: "websocket", Origin: "http://localhost:8787" } });
    expect(ok.status).toBe(101);
    ok.webSocket!.accept();
    ok.webSocket!.close();
  });

  it("agent read receipts reach the contact", async () => {
    const { admin, ws, publicCall, contactToken, conversationId } = await withConversation();
    const contactWs = (await publicCall(`/v1/conversations/${conversationId}/ws?token=${contactToken}`, { headers: { Upgrade: "websocket" } })).webSocket!;
    contactWs.accept();
    const read = nextEvent<ServerEvent>(contactWs, (e) => e.type === "read");
    await admin.call(`/agent/w/${ws.id}/conversations/${conversationId}/read`, { method: "POST" });
    expect(await read).toMatchObject({ type: "read", authorType: "agent" });
    contactWs.close();
  });
});
