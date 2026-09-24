import { LiveChatClient, createMemoryStorage } from "@kobecuppens/livechat-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveChatProvider, LiveChatWidget, Messenger } from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: { nl: "Hallo daar!" } },
  defaultLocale: "en",
  locales: ["en", "nl"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: 5,
};
const contact = { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false };

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

function server(extra: Record<string, (body: any, url: URL) => unknown> = {}) {
  const calls: string[] = [];
  const routes: Record<string, (body: any, url: URL) => unknown> = {
    "GET /v1/config": () => config,
    "POST /v1/session": () => ({ token: "tok", expiresAt: Date.now() + 1e9, contact }),
    "GET /v1/conversations/unread": () => ({ count: 2 }),
    "GET /v1/conversations": () => ({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => [{ id: "cat_1", slug: "billing", title: "Billing", description: null, icon: null, articleCount: 3 }],
    "GET /v1/faq/articles": (_b, url) =>
      url.searchParams.get("q")
        ? url.searchParams.get("q")!.includes("refund")
          ? [{ id: "art_1", categoryId: null, slug: "refunds", title: "Getting a refund", excerpt: "How refunds work", locale: "en" }]
          : []
        : [{ id: "art_2", categoryId: null, slug: "reset", title: "Reset your password", excerpt: "", locale: "en" }],
    "GET /v1/faq/articles/refunds": () => ({ id: "art_1", categoryId: null, slug: "refunds", title: "Getting a refund", excerpt: "", locale: "en", bodyMd: "Go to **Billing**.", updatedAt: 1 }),
    "POST /v1/faq/articles/art_1/feedback": () => undefined,
    ...extra,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404 });
    const out = handler(typeof init.body === "string" ? JSON.parse(init.body) : undefined, url);
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: key.startsWith("POST /v1/conversations") ? 201 : 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** A returning visitor: a stored session means the unread badge is fetched on init. */
async function returningVisitorStorage(workspaceKey: string) {
  const storage = createMemoryStorage();
  await storage.setItem(`livechat:${workspaceKey}:session`, JSON.stringify({ token: "tok", expiresAt: Date.now() + 1e9, contact, userId: null }));
  return storage;
}

function setup(s = server(), locale = "en", storage = createMemoryStorage()) {
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage,
    locale,
    fetch: s.fetch,
    WebSocket: NoopSocket as unknown as typeof WebSocket,
  });
  return { client, calls: s.calls };
}

afterEach(cleanup);

describe("Messenger", () => {
  it("renders the localized home with status, categories and popular articles", async () => {
    const { client } = setup(server(), "nl-BE");
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    expect(await screen.findByText("Hallo daar!")).toBeTruthy();
    expect(screen.getByText("Antwoordt meestal binnen 5 min")).toBeTruthy();
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.getByText("Reset your password")).toBeTruthy();
  });

  it("searches as you type and opens an article with feedback", async () => {
    const { client, calls } = setup();
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    fireEvent.change(await screen.findByPlaceholderText("Search for help"), { target: { value: "refund" } });
    fireEvent.click(await screen.findByText("Getting a refund"));
    expect(await screen.findByText("Billing", { selector: "strong" })).toBeTruthy();
    fireEvent.click(screen.getByText(/Yes/));
    expect(await screen.findByText("Thanks for your feedback!")).toBeTruthy();
    expect(calls).toContain("POST /v1/faq/articles/art_1/feedback");

    fireEvent.click(screen.getByLabelText("Back"));
    fireEvent.change(await screen.findByPlaceholderText("Search for help"), { target: { value: "zzz" } });
    expect(await screen.findByText("No articles found for “zzz”")).toBeTruthy();
  });

  it("starts a conversation from the new-message screen and switches to it", async () => {
    const s = server({
      "POST /v1/conversations": (body) => ({
        conversation: { id: "cv_1", status: "open", assignee: null, lastMessage: null, lastMessageAt: 2, contactLastReadAt: 0, agentLastReadAt: 0, unreadCount: 0, csatScore: null, createdAt: 1 },
        message: { id: "msg_1", conversationId: "cv_1", clientId: body.clientId, authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: body.body, attachments: [], systemEvent: null, createdAt: 2 },
      }),
      "GET /v1/conversations/cv_1": () => ({ id: "cv_1", status: "open", assignee: null, lastMessage: null, lastMessageAt: 2, contactLastReadAt: 0, agentLastReadAt: 0, unreadCount: 0, csatScore: null, createdAt: 1 }),
      "GET /v1/conversations/cv_1/messages": () => ({ items: [], nextCursor: null }),
      "POST /v1/conversations/cv_1/read": () => undefined,
    });
    const { client } = setup(s);
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    fireEvent.click(await screen.findByText("Send us a message"));
    const box = await screen.findByLabelText("Write a message…");
    fireEvent.change(box, { target: { value: "I need a refund" } });
    expect(await screen.findByText("These articles might help", {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("I need a refund")).toBeTruthy());
    await waitFor(() => expect(client.state.threads.cv_1?.messages[0]?.status).toBe("sent"));
    expect(screen.getByText("Acme", { selector: "strong" })).toBeTruthy(); // header switched from "New conversation"
  });

  it("widget shows the unread badge and toggles the panel", async () => {
    const { client } = setup(server(), "en", await returningVisitorStorage("pk"));
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <LiveChatWidget />
      </LiveChatProvider>,
    );
    expect(await screen.findByText("2")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The unread count is part of the launcher's accessible name (the badge itself is hidden).
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Help, 2 unread" })));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
