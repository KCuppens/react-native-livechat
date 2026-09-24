import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_CONVERSATION, LiveChatClient } from "./client";
import { createMemoryStorage } from "./storage";
import { conversation, FakeWebSocket, fakeServer, flush, message } from "./test-utils";

const contact = { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false };
const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#000000", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en", "nl"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: null,
};

function baseRoutes(extra: Parameters<typeof fakeServer>[0] = {}) {
  let n = 0;
  return fakeServer({
    "GET /v1/config": () => ({ body: config }),
    "POST /v1/session": ({ body }) => ({
      body: {
        token: `tok_${++n}`,
        expiresAt: Date.now() + 86_400_000,
        contact: body.userId ? { ...contact, id: "ct_user", externalId: body.userId, verified: true } : contact,
      },
    }),
    "GET /v1/conversations/unread": () => ({ body: { count: 0 } }),
    "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    "GET /v1/conversations/cv_1": () => ({ body: conversation({ id: "cv_1" }) }),
    "GET /v1/conversations/cv_1/messages": () => ({ body: { items: [], nextCursor: null } }),
    ...extra,
  });
}

function makeClient(server: ReturnType<typeof fakeServer>, storage = createMemoryStorage(), locale?: string) {
  return new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk_test",
    storage,
    locale,
    fetch: server.fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("session", () => {
  it("initializes config, negotiates locale and persists the session", async () => {
    const server = baseRoutes();
    const storage = createMemoryStorage();
    const client = makeClient(server, storage, "nl-BE");
    await client.init();
    // Anonymous visitors get a session lazily, on first use.
    expect(client.state).toMatchObject({ status: "ready", locale: "nl", contact: null });
    expect(server.calls.filter((c) => c.path === "/v1/session")).toHaveLength(0);
    await client.http.getUnreadCount(); // first authenticated call creates the session
    expect(client.state.contact).toMatchObject({ id: "ct_1" });

    const again = makeClient(server, storage);
    await again.init(); // restores the stored session: no new POST /v1/session
    expect(again.state.contact).toMatchObject({ id: "ct_1" });
    expect(server.calls.filter((c) => c.path === "/v1/session")).toHaveLength(1);
  });

  it("passes the anonymous token when identifying so history is merged", async () => {
    const server = baseRoutes();
    const client = makeClient(server);
    await client.init();
    await client.http.getUnreadCount(); // anonymous session exists before logging in
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    const sessionCalls = server.calls.filter((c) => c.path === "/v1/session");
    expect(sessionCalls[1]!.body).toMatchObject({ userId: "u1", previousToken: "tok_1" });
    expect(client.state.contact?.verified).toBe(true);
  });

  it("uses a new device id after logging out of a verified user", async () => {
    const server = baseRoutes();
    const client = makeClient(server);
    await client.init();
    await client.http.getUnreadCount();
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    await client.identify(null);
    const ids = server.calls.filter((c) => c.path === "/v1/session").map((c) => c.body.deviceId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("recreates the session once on invalid_token", async () => {
    let first = true;
    const server = baseRoutes({
      "GET /v1/conversations": () => {
        if (first) {
          first = false;
          return { status: 401, body: { error: { code: "invalid_token", message: "expired" } } };
        }
        return { body: { items: [], nextCursor: null } };
      },
    });
    const client = makeClient(server);
    await client.init();
    await client.refreshConversations();
    const list = server.calls.filter((c) => c.path === "/v1/conversations");
    expect(list.map((c) => c.headers.Authorization)).toEqual(["Bearer tok_1", "Bearer tok_2"]);
  });
});

describe("sending", () => {
  it("starts a conversation optimistically and moves the draft to the real id", async () => {
    const server = baseRoutes({
      "POST /v1/conversations": ({ body }) => ({
        status: 201,
        body: {
          conversation: conversation({ id: "cv_1", lastMessageAt: 5 }),
          message: message({ id: "msg_1", clientId: body.clientId, authorType: "contact", body: body.body }),
        },
      }),
    });
    const client = makeClient(server);
    await client.init();
    const pending = client.sendMessage(null, { body: "help" });
    expect(client.state.threads[DRAFT_CONVERSATION]!.messages[0]).toMatchObject({ body: "help", status: "sending" });

    expect(await pending).toBe("cv_1");
    expect(client.state.threads[DRAFT_CONVERSATION]).toBeUndefined();
    expect(client.state.threads.cv_1!.messages).toMatchObject([{ id: "msg_1", status: "sent", conversationId: "cv_1" }]);
    expect(client.state.conversations.map((c) => c.id)).toEqual(["cv_1"]);
  });

  it("marks failed sends and retries with the same clientId", async () => {
    let fail = true;
    const server = baseRoutes({
      "POST /v1/conversations/cv_1/messages": ({ body }) =>
        fail ? { status: 503, body: { error: { code: "unavailable", message: "x" } } } : { status: 201, body: message({ id: "msg_9", clientId: body.clientId, authorType: "contact" }) },
    });
    const client = makeClient(server);
    await client.init();
    expect(await client.sendMessage("cv_1", { body: "hello" })).toBeNull();
    const failed = client.state.threads.cv_1!.messages[0]!;
    expect(failed.status).toBe("failed");

    fail = false;
    expect(await client.retry(failed.clientId!)).toBe("cv_1");
    const sends = server.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    expect(sends[0]!.body.clientId).toBe(sends[1]!.body.clientId);
    expect(client.state.threads.cv_1!.messages).toMatchObject([{ id: "msg_9", status: "sent" }]);
  });
});

describe("realtime", () => {
  it("merges socket messages, dedupes the optimistic echo and marks agent replies read", async () => {
    let sendBody: any;
    const server = baseRoutes({
      "POST /v1/conversations/cv_1/messages": ({ body }) => {
        sendBody = body;
        return { status: 201, body: message({ id: "msg_2", clientId: body.clientId, authorType: "contact", body: body.body }) };
      },
    });
    const client = makeClient(server);
    await client.init();
    const release = client.openConversation("cv_1");
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain("wss://api.test/v1/conversations/cv_1/ws?key=pk_test&token=tok_1");
    ws.open();

    await client.sendMessage("cv_1", { body: "mine" });
    ws.emit({ type: "message.created", message: message({ id: "msg_2", clientId: sendBody.clientId, authorType: "contact", body: "mine" }) });
    vi.useFakeTimers();
    ws.emit({ type: "message.created", message: message({ id: "msg_3", body: "agent reply" }) });
    ws.emit({ type: "message.created", message: message({ id: "msg_4", body: "and another" }) });
    const readsBefore = server.calls.filter((c) => c.path === "/v1/conversations/cv_1/read").length;
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await flush();

    expect(client.state.threads.cv_1!.messages.map((m) => m.id)).toEqual(["msg_2", "msg_3", "msg_4"]);
    const reads = server.calls.filter((c) => c.path === "/v1/conversations/cv_1/read");
    expect(reads.length).toBe(readsBefore + 1); // two agent messages → one debounced receipt
    release();
    expect(ws.readyState).toBe(3);
  });

  it("shows agent typing and expires it", async () => {
    const client = makeClient(baseRoutes());
    await client.init();
    client.openConversation("cv_1");
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    vi.useFakeTimers();
    ws.emit({ type: "typing", authorType: "agent", name: "Sam", typing: true });
    expect(client.state.threads.cv_1!.typing).toEqual({ name: "Sam" });
    vi.advanceTimersByTime(6_001);
    expect(client.state.threads.cv_1!.typing).toBeNull();
  });

  it("throttles outgoing typing and sends a stop after idle", async () => {
    const client = makeClient(baseRoutes());
    await client.init();
    client.openConversation("cv_1");
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    vi.useFakeTimers();
    client.setTyping("cv_1", true);
    client.setTyping("cv_1", true);
    client.setTyping("cv_1", true);
    expect(ws.sent.filter((e: any) => e.type === "typing")).toEqual([{ type: "typing", typing: true }]);
    vi.advanceTimersByTime(5_001);
    expect(ws.sent.filter((e: any) => e.type === "typing").at(-1)).toEqual({ type: "typing", typing: false });
  });

  it("reconnects with backoff and backfills missed messages", async () => {
    let items = [message({ id: "msg_1" })];
    const server = baseRoutes({ "GET /v1/conversations/cv_1/messages": () => ({ body: { items, nextCursor: null } }) });
    const client = makeClient(server);
    await client.init();
    client.openConversation("cv_1");
    await flush();
    FakeWebSocket.instances[0]!.open();
    await flush();

    items = [message({ id: "msg_1" }), message({ id: "msg_2", body: "missed" })];
    vi.useFakeTimers();
    FakeWebSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    await flush();
    await flush();
    expect(client.state.threads.cv_1!.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("tracks agent read receipts", async () => {
    const client = makeClient(baseRoutes());
    await client.init();
    client.openConversation("cv_1");
    await flush();
    FakeWebSocket.instances[0]!.emit({ type: "read", authorType: "agent", at: 1234 });
    expect(client.state.threads.cv_1!.agentLastReadAt).toBe(1234);
  });
});

describe("review fixes", () => {
  it("sends a second draft into the conversation the first one creates", async () => {
    let starts = 0;
    let releaseStart!: () => void;
    const gate = new Promise<void>((r) => (releaseStart = r));
    const server = baseRoutes({
      "POST /v1/conversations": ({ body }) => {
        starts++;
        return {
          status: 201,
          body: {
            conversation: conversation({ id: "cv_1" }),
            message: message({ id: "msg_1", clientId: body.clientId, authorType: "contact", body: body.body }),
          },
        };
      },
      "POST /v1/conversations/cv_1/messages": ({ body }) => ({
        status: 201,
        body: message({ id: "msg_2", clientId: body.clientId, authorType: "contact", body: body.body }),
      }),
    });
    const slowFetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/conversations") && init?.method === "POST") await gate;
      return server.fetch(url, init);
    }) as unknown as typeof fetch;
    const client = new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk_test", storage: createMemoryStorage(), fetch: slowFetch });
    await client.init();

    const first = client.sendMessage(null, { body: "one" });
    const second = client.sendMessage(null, { body: "two" });
    await flush();
    releaseStart();
    expect(await first).toBe("cv_1");
    expect(await second).toBe("cv_1");
    expect(starts).toBe(1);
    expect(client.state.threads.cv_1!.messages.map((m) => [m.body, m.status])).toEqual([
      ["one", "sent"],
      ["two", "sent"],
    ]);
  });

  it("recovers from a corrupt stored session", async () => {
    const storage = createMemoryStorage();
    await storage.setItem("livechat:pk_test:session", "{not json");
    const client = makeClient(baseRoutes(), storage);
    await client.init();
    expect(client.state.status).toBe("ready");
    expect(await storage.getItem("livechat:pk_test:session")).toBeNull(); // corrupt value dropped
    await client.http.getUnreadCount();
    expect(JSON.parse((await storage.getItem("livechat:pk_test:session"))!).token).toBe("tok_1");
  });

  it("nudge while a connect is pending does not open a second socket", async () => {
    let resolveUrl!: (u: string) => void;
    const { ReconnectingSocket } = await import("./socket");
    const socket = new ReconnectingSocket({
      url: () => new Promise((r) => (resolveUrl = r)),
      onEvent: () => {},
      onStateChange: () => {},
      onReconnect: () => {},
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    });
    socket.start();
    socket.nudge();
    resolveUrl("wss://x");
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.stop();
  });
});

describe("bulletproof round 1", () => {
  it("negotiates English for English devices even when the default is another language", async () => {
    const { negotiateLocale } = await import("./i18n");
    expect(negotiateLocale("en", ["en", "nl"], "nl")).toBe("en");
    expect(negotiateLocale("en-US", ["en", "nl"], "nl")).toBe("en");
    expect(negotiateLocale("de", ["en", "nl"], "nl")).toBe("nl");
  });

  it("uses plural forms when a count is given", async () => {
    const { createTranslator } = await import("./i18n");
    expect(createTranslator("en")("faq.articlesCount", { count: 1 })).toBe("1 article");
    expect(createTranslator("en")("faq.articlesCount", { count: 3 })).toBe("3 articles");
    expect(createTranslator("nl")("faq.articlesCount", { count: 1 })).toBe("1 artikel");
  });

  it("refreshes the session once when parallel requests fail with the same expired token", async () => {
    let sessions = 0;
    const server = fakeServer({
      "GET /v1/config": () => ({ body: config }),
      "POST /v1/session": () => ({ body: { token: `tok_${++sessions}`, expiresAt: Date.now() + 86_400_000, contact } }),
      "GET /v1/conversations/unread": ({ headers }) =>
        headers.Authorization === "Bearer tok_1" ? { status: 401, body: { error: { code: "invalid_token", message: "x" } } } : { body: { count: 0 } },
      "GET /v1/conversations": ({ headers }) =>
        headers.Authorization === "Bearer tok_1" ? { status: 401, body: { error: { code: "invalid_token", message: "x" } } } : { body: { items: [], nextCursor: null } },
    });
    const client = makeClient(server);
    await client.init();
    await flush();
    await Promise.all([client.refreshConversations(), client.refreshUnread(), client.refreshConversations()]);
    expect(sessions).toBe(2);
  });

  it("drops a previous identity's in-flight responses after identify()", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = baseRoutes({
      "GET /v1/conversations": () => ({ body: { items: [conversation({ id: "cv_old" })], nextCursor: null } }),
    });
    const slow = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/conversations") && (init?.method ?? "GET") === "GET") await gate;
      return server.fetch(url, init);
    }) as unknown as typeof fetch;
    const client = new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk_test", storage: createMemoryStorage(), fetch: slow });
    await client.init();
    const pending = client.refreshConversations();
    await client.identify({ id: "u2", hash: "b".repeat(64) });
    release();
    await pending;
    expect(client.state.conversations).toEqual([]);
  });

  it("moves the push token to the new identity on logout", async () => {
    const server = baseRoutes({
      "POST /v1/push-devices": () => ({ status: 204 }),
      "DELETE /v1/push-devices/fcm-1": () => ({ status: 204 }),
    });
    const client = makeClient(server);
    await client.init();
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    await client.registerPushDevice({ platform: "android", token: "fcm-1", appId: "com.acme" });
    await client.identify(null);
    await flush();
    const push = server.calls.filter((c) => c.path.startsWith("/v1/push-devices"));
    expect(push.map((c) => `${c.method} ${c.headers.Authorization}`)).toEqual([
      "POST Bearer tok_1", // registered as the verified user
      "DELETE Bearer tok_1", // detached with the user's own session
      "POST Bearer tok_2", // re-registered to the fresh anonymous contact
    ]);
  });

  it("marks a thread errored when its first load fails and retries on the first socket open", async () => {
    let fail = true;
    const server = baseRoutes({
      "GET /v1/conversations/cv_1/messages": () => (fail ? { status: 503, body: { error: { code: "down", message: "x" } } } : { body: { items: [message({ id: "msg_1" })], nextCursor: null } }),
    });
    const client = makeClient(server);
    await client.init();
    client.openConversation("cv_1");
    await flush();
    await flush();
    expect(client.state.threads.cv_1).toMatchObject({ loaded: false, error: true });
    fail = false;
    FakeWebSocket.instances[0]!.open();
    await flush();
    await flush();
    expect(client.state.threads.cv_1).toMatchObject({ loaded: true, error: false });
  });

  it("stops reconnecting after an application close code (access revoked)", async () => {
    const { ReconnectingSocket } = await import("./socket");
    const terminal = vi.fn();
    const socket = new ReconnectingSocket({ url: async () => "wss://x", onEvent: () => {}, onStateChange: () => {}, onReconnect: () => {}, onTerminalClose: terminal, WebSocket: FakeWebSocket as unknown as typeof WebSocket });
    socket.start();
    await flush();
    FakeWebSocket.instances[0]!.open();
    vi.useFakeTimers();
    FakeWebSocket.instances[0]!.close(4003);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    expect(terminal).toHaveBeenCalledWith(4003);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("bulletproof round 1 (high-risk)", () => {
  it("does not create a session for a new anonymous visitor until the messenger is used", async () => {
    const server = baseRoutes();
    const client = makeClient(server);
    await client.init();
    await client.refreshUnread(); // e.g. the launcher's badge poll
    expect(server.calls.filter((c) => c.path === "/v1/session" || c.path === "/v1/conversations/unread")).toHaveLength(0);
    expect(client.hasSession).toBe(false);
  });

  it("a session request superseded by identify() never overwrites the newer identity", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let n = 0;
    const server = fakeServer({
      "GET /v1/config": () => ({ body: config }),
      "GET /v1/conversations/unread": () => ({ body: { count: 0 } }),
      "POST /v1/session": ({ body }) => ({
        body: { token: `tok_${++n}`, expiresAt: Date.now() + 86_400_000, contact: body.userId ? { ...contact, id: "ct_user", verified: true } : contact },
      }),
    });
    const slow = (async (url: string, init?: RequestInit) => {
      const isAnon = url.endsWith("/v1/session") && !String(init?.body).includes("userId");
      if (isAnon) await firstGate;
      return server.fetch(url, init);
    }) as unknown as typeof fetch;
    const storage = createMemoryStorage();
    const client = new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk_test", storage, fetch: slow });
    await client.init();
    const anon = client.http.getUnreadCount().catch(() => {}); // starts an anonymous session request
    await flush();
    await client.identify({ id: "u1", hash: "a".repeat(64) });
    releaseFirst();
    await anon;
    await flush();
    expect(client.state.contact).toMatchObject({ id: "ct_user", verified: true });
    expect(JSON.parse((await storage.getItem("livechat:pk_test:session"))!).userId).toBe("u1");
  });
});
