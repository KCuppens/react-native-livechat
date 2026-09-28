import { beforeEach, describe, expect, it } from "vitest";
import { LiveChatClient, type AgentMessageEvent } from "./client";
import { createMemoryStorage } from "./storage";
import { conversation, FakeWebSocket, fakeServer, flush, message } from "./test-utils";

const contact = { id: "ct_user", externalId: "u1", email: null, name: null, locale: null, verified: true };
const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#000000", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: null,
};

function setup(conversations = [conversation({ id: "cv_1" }), conversation({ id: "cv_2" })], unread = 0) {
  const server = fakeServer({
    "GET /v1/config": () => ({ body: config }),
    "POST /v1/session": () => ({ body: { token: "tok", expiresAt: Date.now() + 86_400_000, contact } }),
    "GET /v1/conversations/unread": () => ({ body: { count: unread } }),
    "GET /v1/conversations": () => ({ body: { items: conversations, nextCursor: null } }),
    "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    "GET /v1/conversations/cv_1": () => ({ body: conversation({ id: "cv_1" }) }),
    "GET /v1/conversations/cv_1/messages": () => ({ body: { items: [], nextCursor: null } }),
  });
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk_test",
    storage: createMemoryStorage(),
    user: { id: "u1", hash: "a".repeat(64) },
    fetch: server.fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
  return { client, server };
}

const socketFor = (id: string) => FakeWebSocket.instances.filter((s) => s.url.includes(`/conversations/${id}/ws`));

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe("watching replies", () => {
  it("opens a socket per recent conversation and counts agent replies as unread without reading them", async () => {
    const { client, server } = setup();
    await client.init();
    const events: AgentMessageEvent[] = [];
    client.onAgentMessage((e) => events.push(e));
    client.startWatching();
    await flush();
    await flush();
    expect(socketFor("cv_1")).toHaveLength(1);
    expect(socketFor("cv_2")).toHaveLength(1);

    const ws = socketFor("cv_2")[0]!;
    ws.open();
    const reply = message({ id: "msg_1", conversationId: "cv_2", body: "we fixed it" });
    ws.emit({ type: "message.created", message: reply });
    ws.emit({ type: "message.created", message: reply }); // duplicate delivery
    ws.emit({ type: "message.created", message: message({ id: "msg_2", conversationId: "cv_2", authorType: "contact" }) });

    expect(client.state.unreadCount).toBe(1);
    expect(client.state.conversations.find((c) => c.id === "cv_2")).toMatchObject({ unreadCount: 1, lastMessage: { id: "msg_2" } });
    expect(events).toEqual([{ conversationId: "cv_2", message: reply }]);
    expect(server.calls.some((c) => c.path.endsWith("/read"))).toBe(false);
  });

  it("hands a conversation opened on screen to its own socket and watches it again when released", async () => {
    const { client } = setup();
    await client.init();
    const events: AgentMessageEvent[] = [];
    client.onAgentMessage((e) => events.push(e));
    client.startWatching();
    await flush();
    await flush();
    const watch = socketFor("cv_1")[0]!;
    watch.open();
    const release = client.openConversation("cv_1");
    expect(watch.readyState).toBe(3);
    await flush();
    const own = socketFor("cv_1")[1]!;
    own.open();
    own.emit({ type: "message.created", message: message({ id: "msg_9" }) });
    expect(events).toHaveLength(0);
    expect(client.state.unreadCount).toBe(0);

    release();
    await flush();
    expect(socketFor("cv_1")).toHaveLength(3); // watched again
  });

  it("closes the watch sockets on stop and watches newly started conversations", async () => {
    const { client } = setup([conversation({ id: "cv_1" })]);
    await client.init();
    client.startWatching();
    await flush();
    await flush();
    const first = socketFor("cv_1")[0]!;
    first.open();
    client.stopWatching();
    expect(first.readyState).toBe(3);

    client.startWatching();
    await flush();
    expect(socketFor("cv_1")).toHaveLength(2);
    // Stopped clients don't count replies.
    client.stopWatching();
    first.emit({ type: "message.created", message: message({ id: "msg_x" }) });
    expect(client.state.unreadCount).toBe(0);
  });

  it("keeps conversations the first page doesn't contain", async () => {
    const { client } = setup([conversation({ id: "cv_2" })]);
    await client.init();
    const release = client.openConversation("cv_1"); // e.g. opened from a notification
    await flush();
    await flush();
    client.startWatching();
    await flush();
    await flush();
    expect(client.state.conversations.map((c) => c.id).sort()).toEqual(["cv_1", "cv_2"]);
    release();
  });
});
