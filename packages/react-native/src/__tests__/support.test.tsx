import { createMemoryStorage, LiveChatClient } from "@kobecuppens/livechat-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { LiveChat, LiveChatProvider, SupportModal, SupportScreen } from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en", "fr"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: false,
  typicalReplyMinutes: null,
};
const conv = { id: "cv_1", status: "open", assignee: { id: "ag_1", name: "Sam Lee", avatarUrl: null }, lastMessage: null, lastMessageAt: 2, contactLastReadAt: 0, agentLastReadAt: 0, unreadCount: 0, csatScore: null, createdAt: 1 };

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

function makeClient(locale = "en", crashMessages = false) {
  const calls: { key: string; body?: any }[] = [];
  const routes: Record<string, (body: any, url: URL) => unknown> = {
    "GET /v1/config": () => config,
    "POST /v1/session": () => ({ token: "tok", expiresAt: Date.now() + 1e9, contact: { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false } }),
    "GET /v1/conversations/unread": () => ({ count: 0 }),
    "GET /v1/conversations": () => ({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => [],
    "GET /v1/faq/articles": (_b, url) =>
      url.searchParams.get("q") ? [] : [{ id: "art_1", categoryId: null, slug: "reset", title: "Reset password", excerpt: "", locale: "en" }],
    "GET /v1/faq/articles/reset": () => ({ id: "art_1", categoryId: null, slug: "reset", title: "Reset password", excerpt: "", locale: "en", bodyMd: "Tap **Forgot password**.", updatedAt: 1 }),
    "GET /v1/conversations/cv_1": () => conv,
    "GET /v1/conversations/cv_1/messages": () => ({
      items: crashMessages
        ? [{ id: "msg_bad", conversationId: "cv_1", clientId: null, authorType: "agent", author: null, body: "x", attachments: null, systemEvent: null, createdAt: 1 }]
        : [
        { id: "msg_1", conversationId: "cv_1", clientId: "c1", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "Hi", attachments: [], systemEvent: null, createdAt: 1 },
        { id: "msg_2", conversationId: "cv_1", clientId: null, authorType: "agent", author: { id: "ag_1", name: "Sam Lee", avatarUrl: null }, body: "Hello! How can I help?", attachments: [], systemEvent: null, createdAt: 2 },
      ],
      nextCursor: null,
    }),
    "POST /v1/conversations/cv_1/read": () => undefined,
    "POST /v1/push-devices": () => undefined,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push({ key, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404 });
    const out = handler(undefined, url);
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk", storage: createMemoryStorage(), locale, fetch: fetchImpl, WebSocket: NoopSocket as unknown as typeof WebSocket });
  return { client, calls };
}

describe("SupportScreen", () => {
  it("renders home with offline status and opens an article", async () => {
    const { client } = makeClient();
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportScreen />
      </LiveChatProvider>,
    );
    expect(await screen.findByText("We're away right now. Leave a message and we'll get back to you.")).toBeTruthy();
    await fireEvent.press(await screen.findByText("Reset password"));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
    expect(screen.getByText("Was this article helpful?")).toBeTruthy();
  });

  it("uses the device locale when the workspace supports it", async () => {
    const { client } = makeClient("fr-BE");
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportScreen />
      </LiveChatProvider>,
    );
    expect(await screen.findByText("Envoyez-nous un message")).toBeTruthy();
  });

  it("opens a conversation from a notification tap via the modal and shows messages", async () => {
    const { client } = makeClient();
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportModal />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("ready"));
    expect(LiveChat.handleNotification({ type: "other" })).toBe(false);
    await act(async () => {
      expect(LiveChat.handleNotification({ type: "livechat", conversationId: "cv_1" })).toBe(true);
    });
    expect(await screen.findByText("Hello! How can I help?")).toBeTruthy();
    expect(screen.getAllByText("Sam Lee").length).toBeGreaterThan(0);
  });

  it("queues push registration until the client is ready", async () => {
    const { client, calls } = makeClient();
    const pending = LiveChat.registerPushToken({ platform: "ios", token: "apns-1", appId: "com.acme", sandbox: true });
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportScreen />
      </LiveChatProvider>,
    );
    await pending;
    await waitFor(() => expect(calls.find((c) => c.key === "POST /v1/push-devices")?.body).toMatchObject({ platform: "ios", token: "apns-1", appId: "com.acme" }));
  });

  it("a crashed screen keeps Back so the user can leave it", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient("en", true);
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportScreen />
      </LiveChatProvider>,
    );
    await screen.findByText("Reset password");
    await act(async () => LiveChat.open({ name: "conversation", id: "cv_1" }));
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Back"));
    expect(await screen.findByText("Reset password")).toBeTruthy();
    (console.error as jest.Mock).mockRestore();
  });
});
