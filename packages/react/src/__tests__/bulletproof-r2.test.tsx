import { LiveChatClient, createMemoryStorage } from "@kobecuppens/livechat-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveChatProvider, Messenger, useMessenger } from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#10B981", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: null,
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

type Route = (url: URL) => { status?: number; body?: unknown } | undefined;

function makeClient(routes: Record<string, Route> = {}) {
  const all: Record<string, Route> = {
    "GET /v1/config": () => ({ body: config }),
    "POST /v1/session": () => ({ body: { token: "tok", expiresAt: Date.now() + 1e9, contact } }),
    "GET /v1/conversations/unread": () => ({ body: { count: 0 } }),
    "GET /v1/conversations": () => ({ body: { items: [], nextCursor: null } }),
    "GET /v1/faq/categories": () => ({ body: [] }),
    "GET /v1/faq/articles": () => ({ body: [] }),
    ...routes,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const r = all[`${init.method ?? "GET"} ${url.pathname}`]?.(url) ?? { status: 404, body: { error: { code: "nf", message: "nf" } } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
  }) as unknown as typeof fetch;
  return new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk", storage: createMemoryStorage(), fetch: fetchImpl, WebSocket: NoopSocket as unknown as typeof WebSocket });
}

function Go({ to }: { to: Parameters<ReturnType<typeof useMessenger>["open"]>[0] }) {
  const m = useMessenger();
  return <button type="button" onClick={() => m.open(to)}>go</button>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const conv = {
  id: "cv_1",
  status: "open",
  assignee: null,
  lastMessage: null,
  lastMessageAt: 1,
  unreadCount: 0,
  contactLastReadAt: 0,
  agentLastReadAt: 0,
  csatScore: null,
  createdAt: 1,
};

describe("web messenger (bulletproof round 2)", () => {
  it("keeps focus on the composer when a screen focuses it itself", async () => {
    const client = makeClient();
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    await act(async () => fireEvent.click(await screen.findByText("Send us a message")));
    const composer = await screen.findByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("a screen that keeps crashing offers Back, which leaves it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { id: "msg_1", conversationId: "cv_1", clientId: null, authorType: "agent", author: null, body: "x", attachments: null, systemEvent: null, createdAt: 1 };
    const client = makeClient({
      "GET /v1/conversations/cv_1": () => ({ body: conv }),
      "GET /v1/conversations/cv_1/messages": () => ({ body: { items: [bad], nextCursor: null } }),
      "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Go to={{ name: "conversation", id: "cv_1" }} />
        <Messenger inline />
      </LiveChatProvider>,
    );
    await screen.findByText("Send us a message");
    await act(async () => fireEvent.click(screen.getByText("go")));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Back" })));
    expect(await screen.findByText("Send us a message")).toBeTruthy();
  });

  it("reopens an open conversation after the user logs in", async () => {
    let loads = 0;
    const client = makeClient({
      "GET /v1/conversations/cv_1": () => ({ body: conv }),
      "GET /v1/conversations/cv_1/messages": () => {
        loads++;
        return { body: { items: [], nextCursor: null } };
      },
      "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Go to={{ name: "conversation", id: "cv_1" }} />
        <Messenger inline />
      </LiveChatProvider>,
    );
    await screen.findByText("Send us a message");
    await act(async () => fireEvent.click(screen.getByText("go")));
    await waitFor(() => expect(loads).toBe(1));
    await act(async () => client.identify({ id: "u1", hash: "a".repeat(64) }));
    await waitFor(() => expect(loads).toBe(2));
    expect(client.state.threads.cv_1?.loaded).toBe(true);
  });
});
