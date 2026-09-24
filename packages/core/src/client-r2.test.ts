import { beforeEach, describe, expect, it } from "vitest";
import { LiveChatClient } from "./client";
import { createMemoryStorage } from "./storage";
import { conversation, FakeWebSocket, fakeServer, flush, message } from "./test-utils";

const contact = { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false };
const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#000000", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: null,
};

function routes(extra: Parameters<typeof fakeServer>[0] = {}) {
  let n = 0;
  return fakeServer({
    "GET /v1/config": () => ({ body: config }),
    "POST /v1/session": ({ body }) => ({
      body: {
        token: `tok_${++n}`,
        expiresAt: Date.now() + 86_400_000,
        contact: body.userId ? { ...contact, id: `ct_${body.userId}`, externalId: body.userId, verified: true } : contact,
      },
    }),
    "GET /v1/conversations/unread": () => ({ body: { count: 0 } }),
    "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    "GET /v1/conversations/cv_1": () => ({ body: conversation({ id: "cv_1" }) }),
    "GET /v1/conversations/cv_1/messages": () => ({ body: { items: [], nextCursor: null } }),
    ...extra,
  });
}

function makeClient(server: ReturnType<typeof fakeServer>) {
  return new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk_test",
    storage: createMemoryStorage(),
    fetch: server.fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe("client round 2 regressions", () => {
  it("overlapping identify calls finish in call order: login then logout ends logged out", async () => {
    const server = routes();
    const client = makeClient(server);
    await client.init();
    await client.http.getUnreadCount();
    const login = client.identify({ id: "u1", hash: "a".repeat(64) });
    const logout = client.identify(null);
    await Promise.all([login, logout]);
    expect(client.state.contact?.verified).toBe(false);
  });

  it("identify(null) without a session keeps the visitor sessionless", async () => {
    const server = routes();
    const client = makeClient(server);
    await client.init();
    await client.identify(null);
    expect(server.calls.filter((c) => c.path === "/v1/session")).toHaveLength(0);
    expect(client.hasSession).toBe(false);
  });

  it("bumps the identity counter when the user changes", async () => {
    const client = makeClient(routes());
    await client.init();
    const before = client.state.identity;
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    expect(client.state.identity).toBe(before + 1);
  });

  it("two overlapping markRead calls lower the badge once", async () => {
    const client = makeClient(routes());
    await client.init();
    await client.http.getUnreadCount();
    client.store.set({ unreadCount: 5, conversations: [conversation({ id: "cv_1", unreadCount: 2 })] });
    await Promise.all([client.markRead("cv_1"), client.markRead("cv_1")]);
    expect(client.state.unreadCount).toBe(3);
  });

  it("backfills on the socket's first open, catching messages published before it subscribed", async () => {
    let items: unknown[] = [];
    const client = makeClient(routes({ "GET /v1/conversations/cv_1/messages": () => ({ body: { items, nextCursor: null } }) }));
    await client.init();
    client.openConversation("cv_1");
    await flush();
    await flush();
    expect(client.state.threads.cv_1?.loaded).toBe(true);
    // The auto-reply lands after the initial load but before the socket is subscribed.
    items = [message({ id: "msg_auto", conversationId: "cv_1", authorType: "system", systemEvent: "auto_reply" })];
    FakeWebSocket.instances[0]!.open();
    await flush();
    await flush();
    expect(client.state.threads.cv_1?.messages.map((m) => m.id)).toContain("msg_auto");
  });

  it("a send that finishes after an identity change does not touch the new identity's state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = routes({
      "POST /v1/conversations": ({ body }) => ({
        body: { conversation: conversation({ id: "cv_old" }), message: message({ id: "msg_1", conversationId: "cv_old", clientId: body.clientId }) },
      }),
    });
    const slowFetch = (async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/v1/conversations" && init?.method === "POST") await gate;
      return server.fetch(url, init);
    }) as typeof fetch;
    const client = new LiveChatClient({
      apiUrl: "https://api.test",
      workspaceKey: "pk_test",
      storage: createMemoryStorage(),
      fetch: slowFetch,
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    await client.init();
    const sent = client.sendMessage(null, { body: "hi" });
    await flush();
    await client.identify({ id: "u2", hash: "b".repeat(64) });
    release();
    expect(await sent).toBeNull();
    expect(client.state.threads.cv_old).toBeUndefined();
    expect(client.state.conversations).toEqual([]);
  });

  it("re-registers the push device on resume when the move to the new identity failed", async () => {
    let failRegister = false;
    const server = routes({
      "POST /v1/push-devices": () => (failRegister ? { status: 500, body: { error: { code: "x", message: "x" } } } : { status: 204 }),
      "DELETE /v1/push-devices/fcm-1": () => ({ status: 204 }),
    });
    const client = makeClient(server);
    await client.init();
    await client.registerPushDevice({ platform: "android", token: "fcm-1", appId: "com.acme" });
    failRegister = true;
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    await flush();
    failRegister = false;
    const before = server.calls.filter((c) => c.method === "POST" && c.path === "/v1/push-devices").length;
    client.resume();
    await flush();
    await flush();
    expect(server.calls.filter((c) => c.method === "POST" && c.path === "/v1/push-devices").length).toBe(before + 1);
  });

  it("probes the session over HTTP after repeated failed socket handshakes", async () => {
    const server = routes();
    const client = makeClient(server);
    await client.init();
    client.openConversation("cv_1");
    await flush();
    const unreadCalls = () => server.calls.filter((c) => c.path === "/v1/conversations/unread").length;
    const before = unreadCalls();
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.instances.at(-1)!.close(1006); // e.g. the upgrade was refused with HTTP 401
      client.resume();
      await flush();
      await flush();
    }
    // resume() also refreshes unread once per call; the probe adds one more.
    expect(unreadCalls() - before).toBe(4);
  });

  it("a session-revoked close gets a new session and reconnects with it", async () => {
    const server = routes();
    const client = makeClient(server);
    await client.init();
    client.openConversation("cv_1");
    await flush();
    await flush();
    const first = FakeWebSocket.instances.at(-1)!;
    expect(first.url).toContain("tok_1");
    first.open();
    first.close(4401);
    for (let i = 0; i < 5; i++) await flush();
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url).toContain("tok_2");
    expect(server.calls.filter((c) => c.path === "/v1/session")).toHaveLength(2);
  });

  it("opening a conversation loads it once, plus a messages-only backfill when the socket subscribes", async () => {
    const server = routes();
    const client = makeClient(server);
    await client.init();
    client.openConversation("cv_1");
    await flush(); // the socket is created once its URL (session token) resolves
    FakeWebSocket.instances[0]!.open();
    for (let i = 0; i < 6; i++) await flush();
    const count = (path: string) => server.calls.filter((c) => c.method === "GET" && c.path.startsWith(path)).length;
    expect(count("/v1/conversations/cv_1/messages")).toBe(2);
    expect(server.calls.filter((c) => c.method === "GET" && c.path === "/v1/conversations/cv_1").length).toBe(1);
    expect(client.state.threads.cv_1?.loaded).toBe(true);
  });
});
