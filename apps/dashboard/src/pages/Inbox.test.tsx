import type { AgentConversation, AgentMe, Message } from "@kobecuppens/livechat-protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui";
import { match, Router, useRouter } from "../router";
import { InboxPage } from "./Inbox";

// ---------------------------------------------------------------- fakes

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (init: RequestInit) => Reply | Promise<Reply>;

interface Call {
  method: string;
  url: string;
  init: RequestInit;
}

/**
 * Fake backend: routes are keyed by "METHOD /path?query" (exact) or "METHOD /path" (any query).
 * Anything unrouted answers 404 so a missing stub surfaces as a visible failure.
 */
function stubApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
    const r: Reply = handler ? await handler(init) : { status: 404, body: { error: { code: "not_found", message: `unrouted ${method} ${url}` } } };
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  const find = (method: string, url: string) => calls.filter((c) => c.method === method && c.url.startsWith(url));
  return { calls, find, fetchMock };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    act(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  emit(event: unknown) {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(event) });
    });
  }
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
}

async function socket(pathSuffix: string) {
  let found: FakeWebSocket | undefined;
  await waitFor(() => {
    found = FakeWebSocket.instances.find((s) => s.url.endsWith(pathSuffix) && !s.closed);
    expect(found).toBeTruthy();
  });
  return found!;
}
const inboxSocket = () => socket("/agent/w/ws_1/inbox/ws");
const convSocket = (id = "cv_1") => socket(`/agent/w/ws_1/conversations/${id}/ws`);

// ---------------------------------------------------------------- fixtures

const NOW = Date.now();

const me: AgentMe = {
  agent: { id: "ag_me", email: "alex@acme.test", name: "Alex Agent", avatarUrl: null },
  superAdmin: false,
  workspaces: [{ id: "ws_1", name: "Acme", role: "admin" }],
};

const members = [
  { id: "ag_me", email: "alex@acme.test", name: "Alex Agent", avatarUrl: null, role: "admin", online: true },
  { id: "ag_bo", email: "bo@acme.test", name: "Bo Other", avatarUrl: null, role: "agent", online: false },
];

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: "cv_1",
    clientId: null,
    authorType: "contact",
    author: null,
    body: `body of ${id}`,
    attachments: [],
    systemEvent: null,
    createdAt: NOW - 60_000,
    ...over,
  };
}

function conv(id: string, over: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id,
    status: "open",
    assignee: null,
    lastMessage: msg(`m_${id}`, { conversationId: id, body: `last in ${id}` }),
    lastMessageAt: NOW - 60_000,
    contactLastReadAt: 0,
    agentLastReadAt: 0,
    unreadCount: 0,
    csatScore: null,
    createdAt: NOW - 3_600_000,
    csatComment: null,
    contact: { id: `ct_${id}`, externalId: null, email: null, name: `Name ${id}`, locale: "en", verified: false, lastSeenAt: NOW - 120_000 },
    ...over,
  };
}

const LIST = "/agent/w/ws_1/conversations";
const listUrl = (q: string) => `${LIST}?${q}`;

function Harness({ onUnread }: { onUnread: (n: number) => void }) {
  const { path } = useRouter();
  const m = match("/w/:ws/inbox/:id?", path);
  return (
    <>
      <InboxPage me={me} workspaceId="ws_1" conversationId={m?.id ?? null} onUnread={onUnread} onAccessLost={() => {}} />
      <Toaster />
    </>
  );
}

function renderInbox(url = "/w/ws_1/inbox") {
  history.replaceState(null, "", url);
  const onUnread = vi.fn();
  const utils = render(
    <Router>
      <Harness onUnread={onUnread} />
    </Router>,
  );
  return { ...utils, onUnread };
}

const baseRoutes = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
  "GET /agent/workspaces/ws_1/members": () => ({ body: members }),
  [`GET ${LIST}`]: () => ({ body: { items: [], nextCursor: null } }),
  "GET /agent/w/ws_1/canned-replies": () => ({ body: [] }),
  ...over,
});

const listItems = (container: HTMLElement) => [...container.querySelectorAll(".conv-item strong")].map((e) => e.textContent);

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeNotification.instances = [];
  FakeNotification.permission = "granted";
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  document.title = "";
});

// ---------------------------------------------------------------- list

describe("InboxPage conversation list", () => {
  it("loads open conversations for all assignees by default and renders previews", async () => {
    const api = stubApi(
      baseRoutes({
        [`GET ${LIST}`]: () => ({
          body: {
            items: [
              conv("cv_1", { unreadCount: 2 }),
              conv("cv_2", { lastMessage: msg("m_x", { authorType: "agent", author: { id: "ag_me", name: "Alex Agent", avatarUrl: null }, body: "we are on it" }) }),
              conv("cv_3", { lastMessage: msg("m_y", { authorType: "system", systemEvent: "csat_request", body: "" }) }),
              conv("cv_4", { lastMessage: msg("m_z", { body: "", attachments: [{ id: "at", name: "a.png", contentType: "image/png", size: 1 }] }), contact: { ...conv("cv_4").contact, name: null, email: "anon@x.test" } }),
            ],
            nextCursor: null,
          },
        }),
      }),
    );
    const { container } = renderInbox();

    expect(await screen.findByText("Name cv_1")).toBeTruthy();
    expect(api.find("GET", LIST).map((c) => c.url)).toEqual([listUrl("status=open&assignee=all")]);
    expect(screen.getByText("last in cv_1")).toBeTruthy();
    expect(screen.getByText("2 unread")).toBeTruthy();
    expect(container.querySelector(".conv-item.unread")?.getAttribute("href")).toBe("/w/ws_1/inbox/cv_1");
    // Agent-authored previews get a "You:" prefix; system events and attachment-only messages get a label.
    expect(screen.getByText(/we are on it/).textContent).toBe("You: we are on it");
    expect(screen.getByText("— rating requested")).toBeTruthy();
    expect(screen.getByText("anon@x.test")).toBeTruthy();
    expect(screen.getByText("📎 Attachment")).toBeTruthy();
    expect(screen.getByText("Select a conversation")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Open" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
  });

  it("refetches with the new filter when switching status and assignee tabs, and shows the empty state", async () => {
    const api = stubApi(
      baseRoutes({
        [`GET ${listUrl("status=open&assignee=all")}`]: () => ({ body: { items: [conv("cv_1")], nextCursor: null } }),
      }),
    );
    renderInbox();
    await screen.findByText("Name cv_1");

    fireEvent.click(screen.getByRole("tab", { name: "Pending" }));
    expect(await screen.findByText("No pending conversations 🎉")).toBeTruthy();
    expect(screen.queryByText("Name cv_1")).toBeNull();
    expect(screen.getByRole("tab", { name: "Pending" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    await waitFor(() => expect(api.find("GET", LIST)).toHaveLength(3));
    fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
    fireEvent.click(screen.getByRole("tab", { name: "Unassigned" }));
    expect(await screen.findByText("No resolved conversations 🎉")).toBeTruthy();

    await waitFor(() =>
      expect(api.find("GET", LIST).map((c) => c.url)).toEqual([
        listUrl("status=open&assignee=all"),
        listUrl("status=pending&assignee=all"),
        listUrl("status=pending&assignee=me"),
        listUrl("status=resolved&assignee=me"),
        listUrl("status=resolved&assignee=unassigned"),
      ]),
    );
  });

  it("navigates to a conversation when its row is clicked", async () => {
    stubApi(
      baseRoutes({
        [`GET ${LIST}`]: () => ({ body: { items: [conv("cv_1"), conv("cv_2")], nextCursor: null } }),
        "GET /agent/w/ws_1/conversations/cv_2": () => ({ body: conv("cv_2") }),
        "GET /agent/w/ws_1/conversations/cv_2/messages": () => ({ body: { items: [], nextCursor: null } }),
        "POST /agent/w/ws_1/conversations/cv_2/read": () => ({ status: 204 }),
      }),
    );
    const { container } = renderInbox();
    await screen.findByText("Name cv_2");

    // Click the anchor itself: happy-dom runs an anchor's default navigation while a click bubbles from a
    // child, before React's root listener can preventDefault (browsers don't).
    fireEvent.click(screen.getByText("Name cv_2").closest("a")!);

    expect(location.pathname).toBe("/w/ws_1/inbox/cv_2");
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeTruthy();
    expect(container.querySelector(".conv-item.active")?.getAttribute("href")).toBe("/w/ws_1/inbox/cv_2");
    expect(screen.queryByText("Select a conversation")).toBeNull();
  });

  it("appends the next page with the cursor and drops duplicates", async () => {
    const api = stubApi(
      baseRoutes({
        [`GET ${listUrl("status=open&assignee=all")}`]: () => ({ body: { items: [conv("cv_1"), conv("cv_2")], nextCursor: "cur_2" } }),
        [`GET ${listUrl("status=open&assignee=all&cursor=cur_2")}`]: () => ({ body: { items: [conv("cv_2"), conv("cv_3")], nextCursor: null } }),
      }),
    );
    const { container } = renderInbox();
    await screen.findByText("Name cv_1");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Name cv_3")).toBeTruthy();
    expect(listItems(container)).toEqual(["Name cv_1", "Name cv_2", "Name cv_3"]);
    expect(api.find("GET", LIST).map((c) => c.url)).toContain(listUrl("status=open&assignee=all&cursor=cur_2"));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("upserts and re-sorts conversations from the inbox socket and removes ones that no longer match", async () => {
    stubApi(
      baseRoutes({
        [`GET ${LIST}`]: () => ({
          body: { items: [conv("cv_1", { lastMessageAt: NOW - 1000 }), conv("cv_2", { lastMessageAt: NOW - 2000 })], nextCursor: null },
        }),
      }),
    );
    const { container } = renderInbox();
    await screen.findByText("Name cv_1");
    const ws = await inboxSocket();
    ws.open();

    // A new conversation lands on top; an update to cv_2 moves it above cv_1.
    ws.emit({ type: "conversation.updated", conversation: conv("cv_3", { lastMessageAt: NOW - 500 }) });
    ws.emit({ type: "conversation.updated", conversation: conv("cv_2", { lastMessageAt: NOW, lastMessage: msg("m_new", { body: "fresh" }) }) });
    expect(listItems(container)).toEqual(["Name cv_2", "Name cv_3", "Name cv_1"]);
    expect(screen.getByText("fresh")).toBeTruthy();

    // Resolving cv_1 removes it from the open list.
    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { status: "resolved" }) });
    expect(listItems(container)).toEqual(["Name cv_2", "Name cv_3"]);
  });

  it("applies the assignee filter to socket updates", async () => {
    stubApi(baseRoutes({ [`GET ${LIST}`]: () => ({ body: { items: [conv("cv_1", { assignee: { id: "ag_me", name: "Alex", avatarUrl: null } })], nextCursor: null } }) }));
    const { container } = renderInbox();
    await screen.findByText("Name cv_1");
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    await screen.findByText("Name cv_1");
    const ws = await inboxSocket();

    ws.emit({ type: "conversation.updated", conversation: conv("cv_9", { assignee: { id: "ag_bo", name: "Bo", avatarUrl: null } }) });
    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { assignee: { id: "ag_bo", name: "Bo", avatarUrl: null } }) });
    expect(listItems(container)).toEqual([]);
    expect(screen.getByText("No open conversations 🎉")).toBeTruthy();

    ws.emit({ type: "conversation.updated", conversation: conv("cv_5", { assignee: { id: "ag_me", name: "Alex", avatarUrl: null } }) });
    expect(listItems(container)).toEqual(["Name cv_5"]);
  });

  it("refetches the list after the inbox socket reconnects", async () => {
    const api = stubApi(baseRoutes());
    renderInbox();
    await screen.findByText("No open conversations 🎉");
    const first = await inboxSocket();
    first.open();
    vi.useFakeTimers();
    try {
      act(() => first.onclose?.({}));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      vi.useRealTimers();
    }
    const second = FakeWebSocket.instances.filter((s) => s.url.endsWith("/inbox/ws")).at(-1)!;
    expect(second).not.toBe(first);
    second.open();
    await waitFor(() => expect(api.find("GET", LIST)).toHaveLength(2));
  });

  it("shows a browser notification for a new contact message in a conversation that isn't open", async () => {
    stubApi(baseRoutes({ [`GET ${LIST}`]: () => ({ body: { items: [conv("cv_1")], nextCursor: null } }) }));
    renderInbox();
    await screen.findByText("Name cv_1");
    const ws = await inboxSocket();

    // Agent-authored and already-read updates stay silent.
    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { unreadCount: 1, lastMessage: msg("m_a", { authorType: "agent" }) }) });
    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { unreadCount: 0 }) });
    expect(FakeNotification.instances).toHaveLength(0);

    ws.emit({ type: "conversation.updated", conversation: conv("cv_2", { unreadCount: 1, lastMessage: msg("m_b", { body: "help please" }) }) });
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0]!;
    expect(n.title).toBe("Name cv_2");
    expect(n.options).toEqual({ body: "help please", tag: "Name cv_2" });

    act(() => n.onclick?.());
    expect(location.pathname).toBe("/w/ws_1/inbox/cv_2");
    expect(n.close).toHaveBeenCalled();
  });

  it("does not notify for the open conversation or when permission isn't granted", async () => {
    stubApi(
      baseRoutes({
        [`GET ${LIST}`]: () => ({ body: { items: [conv("cv_1")], nextCursor: null } }),
        "GET /agent/w/ws_1/conversations/cv_1": () => ({ body: conv("cv_1") }),
        "GET /agent/w/ws_1/conversations/cv_1/messages": () => ({ body: { items: [], nextCursor: null } }),
        "POST /agent/w/ws_1/conversations/cv_1/read": () => ({ status: 204 }),
      }),
    );
    renderInbox("/w/ws_1/inbox/cv_1");
    await screen.findAllByText("Name cv_1");
    const ws = await inboxSocket();

    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { unreadCount: 1 }) });
    expect(FakeNotification.instances).toHaveLength(0);

    FakeNotification.permission = "denied";
    ws.emit({ type: "conversation.updated", conversation: conv("cv_2", { unreadCount: 1 }) });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("asks for notification permission from a button, not on load", async () => {
    FakeNotification.permission = "default";
    stubApi(baseRoutes());
    renderInbox();
    await screen.findByText("No open conversations 🎉");
    // Browsers ignore or quietly block prompts that don't come from a user gesture.
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull());
  });

  it("reports the unread count for the open/all view and mirrors it in the page title", async () => {
    stubApi(
      baseRoutes({
        [`GET ${LIST}`]: () => ({ body: { items: [conv("cv_1", { unreadCount: 3 }), conv("cv_2", { unreadCount: 1 }), conv("cv_3")], nextCursor: null } }),
      }),
    );
    const { onUnread } = renderInbox();
    await screen.findByText("Name cv_1");

    await waitFor(() => expect(onUnread).toHaveBeenLastCalledWith(2));
    expect(document.title).toBe("(2) Support Inbox");

    const ws = await inboxSocket();
    ws.emit({ type: "conversation.updated", conversation: conv("cv_1", { unreadCount: 0 }) });
    ws.emit({ type: "conversation.updated", conversation: conv("cv_2", { unreadCount: 0 }) });
    expect(onUnread).toHaveBeenLastCalledWith(0);
    expect(document.title).toBe("Support Inbox");

    // Other views don't report their counts.
    onUnread.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading" })).toBeNull());
    expect(onUnread).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- conversation pane

const CONV = "/agent/w/ws_1/conversations/cv_1";

function paneRoutes(opts: { summary?: AgentConversation; detail?: AgentConversation; messages?: Message[]; over?: Record<string, Handler> } = {}) {
  const summary = opts.summary ?? conv("cv_1", { contact: { ...conv("cv_1").contact, name: "Jane Doe" } });
  return baseRoutes({
    [`GET ${LIST}`]: () => ({ body: { items: [summary], nextCursor: null } }),
    [`GET ${CONV}`]: () => ({ body: opts.detail ?? summary }),
    [`GET ${CONV}/messages`]: () => ({ body: { items: opts.messages ?? [], nextCursor: null } }),
    [`POST ${CONV}/read`]: () => ({ status: 204 }),
    ...opts.over,
  });
}

const reply = () => screen.getByLabelText("Reply") as HTMLTextAreaElement;
const thread = () => screen.getByRole("region", { name: "Conversation" });

async function openPane() {
  const utils = renderInbox("/w/ws_1/inbox/cv_1");
  await waitFor(() => expect(within(thread()).queryByRole("status", { name: "Loading" })).toBeNull());
  return utils;
}

describe("InboxPage conversation pane", () => {
  it("loads the conversation and messages, marks it read and renders system events", async () => {
    const api = stubApi(
      paneRoutes({
        messages: [
          msg("m_003", { authorType: "system", systemEvent: "assigned", body: "Bo Other" }),
          msg("m_001", { body: "Where is my order?" }),
          msg("m_002", { authorType: "agent", author: { id: "ag_me", name: "Alex Agent", avatarUrl: null }, body: "Checking now" }),
          msg("m_004", { authorType: "system", systemEvent: "resolved", body: "" }),
          msg("m_005", { authorType: "system", systemEvent: "auto_reply", body: "We reply in 5m" }),
          msg("m_006", { authorType: "contact", body: "", attachments: [{ id: "at_1", name: "receipt.pdf", contentType: "application/pdf", size: 3, url: "https://f/x.pdf" }, { id: "at_2", name: "shot.png", contentType: "image/png", size: 3, url: "https://f/s.png" }] }),
        ],
      }),
    );
    const { container } = await openPane();

    const log = screen.getByRole("log");
    expect(within(log).getByText("Where is my order?")).toBeTruthy();
    expect(within(log).getByText("Checking now")).toBeTruthy();
    // Messages are sorted by id.
    expect([...log.querySelectorAll(".msg-bubble, .sys")].map((e) => e.textContent)).toEqual([
      "Where is my order?",
      "Checking now",
      "Assigned to Bo Other",
      "Marked as resolved",
      "Auto-reply: We reply in 5m",
    ]);
    expect(within(log).getByText(/receipt\.pdf/).getAttribute("href")).toBe("https://f/x.pdf");
    expect((within(log).getByAltText("shot.png") as HTMLImageElement).src).toBe("https://f/s.png");
    expect(container.querySelector(".msg.contact .msg-meta")?.textContent).toMatch(/^Jane Doe · /);
    expect(container.querySelector(".msg.agent .msg-meta")?.textContent).toMatch(/^Alex Agent · /);

    expect(api.find("GET", CONV).map((c) => c.url)).toEqual(expect.arrayContaining([CONV, `${CONV}/messages`]));
    await waitFor(() => expect(api.find("POST", `${CONV}/read`)).toHaveLength(1));
    expect(within(thread()).getByText("Anonymous visitor")).toBeTruthy();
    expect(reply().placeholder).toBe("Reply to Jane Doe… (type / for saved replies)");
  });

  it("shows contact details in the contact pane", async () => {
    const summary = conv("cv_1", {
      csatScore: 4,
      csatComment: "Quick help",
      contact: { id: "ct_1", externalId: "user-42", email: "jane@x.test", name: "Jane Doe", locale: "nl", verified: true, lastSeenAt: NOW - 120_000 },
    });
    stubApi(paneRoutes({ summary }));
    await openPane();

    const pane = screen.getByRole("complementary", { name: "Contact" });
    expect(within(pane).getByText("✓ Verified user")).toBeTruthy();
    expect(within(pane).getByText("jane@x.test").getAttribute("href")).toBe("mailto:jane@x.test");
    expect(within(pane).getByText("user-42")).toBeTruthy();
    expect(within(pane).getByText("nl")).toBeTruthy();
    expect(within(pane).getByText("2 minutes ago")).toBeTruthy();
    expect(within(pane).getByText("★★★★☆")).toBeTruthy();
    expect(within(pane).getByText("“Quick help”")).toBeTruthy();
    expect(within(thread()).getByText("jane@x.test")).toBeTruthy();
  });

  it("shows Retry when the conversation fails to load, and recovers", async () => {
    let fail = true;
    const routes = paneRoutes();
    const ok = routes[`GET ${CONV}`]!;
    stubApi({ ...routes, [`GET ${CONV}`]: (init) => (fail ? { status: 500, body: { error: { code: "boom", message: "boom" } } } : ok(init)) });
    renderInbox("/w/ws_1/inbox/cv_1");
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText(/Couldn't load this conversation/)).toBeTruthy();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(/Couldn't load this conversation/)).toBeNull());
  });

  it("prefixes another agent's reply with their name, not 'You'", async () => {
    stubApi({
      ...paneRoutes(),
      [`GET ${LIST}`]: () => ({
        body: { items: [conv("cv_9", { lastMessage: msg("m_y", { authorType: "agent", author: { id: "ag_bo", name: "Bo", avatarUrl: null }, body: "on it" }) })], nextCursor: null },
      }),
    });
    renderInbox("/w/ws_1/inbox");
    expect((await screen.findByText(/on it/)).textContent).toBe("Bo: on it");
  });

  it("loads earlier messages with the before cursor", async () => {
    const api = stubApi(
      paneRoutes({
        over: {
          [`GET ${CONV}/messages`]: () => ({ body: { items: [msg("m_010", { body: "newest" })], nextCursor: "m_010" } }),
          [`GET ${CONV}/messages?before=m_010`]: () => ({ body: { items: [msg("m_001", { body: "oldest" })], nextCursor: null } }),
        },
      }),
    );
    await openPane();

    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(await screen.findByText("oldest")).toBeTruthy();
    expect([...screen.getByRole("log").querySelectorAll(".msg-bubble")].map((e) => e.textContent)).toEqual(["oldest", "newest"]);
    expect(api.find("GET", `${CONV}/messages?before=m_010`)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });

  it("sends a reply on Enter with a clientId and shows the saved message", async () => {
    let resolveReply!: (r: Reply) => void;
    const api = stubApi(paneRoutes({ over: { [`POST ${CONV}/messages`]: () => new Promise<Reply>((r) => (resolveReply = r)) } }));
    await openPane();

    fireEvent.change(reply(), { target: { value: "  Hello there  " } });
    fireEvent.keyDown(reply(), { key: "Enter" });

    // Optimistic pending bubble while the request is in flight.
    expect(await screen.findByText("Sending…")).toBeTruthy();
    expect(reply().value).toBe("");
    const [post] = api.find("POST", `${CONV}/messages`);
    const body = JSON.parse(post!.init.body as string);
    expect(body).toEqual({ clientId: expect.stringMatching(/^a_[0-9a-f-]{36}$/), body: "Hello there", attachmentIds: [] });

    resolveReply({ body: msg("m_100", { authorType: "agent", author: { id: "ag_me", name: "Alex Agent", avatarUrl: null }, body: "Hello there", clientId: body.clientId }) });
    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(within(screen.getByRole("log")).getByText("Hello there").closest(".msg")?.className).toBe("msg agent");
    // Replying to an unassigned conversation assigns it to me.
    expect((screen.getByLabelText("Assignee", { selector: "select" }) as HTMLSelectElement).value).toBe("ag_me");
  });

  it("does not send on Shift+Enter or with an empty draft", async () => {
    const api = stubApi(paneRoutes());
    await openPane();

    fireEvent.keyDown(reply(), { key: "Enter" });
    fireEvent.change(reply(), { target: { value: "line one" } });
    fireEvent.keyDown(reply(), { key: "Enter", shiftKey: true });

    expect(api.find("POST", `${CONV}/messages`)).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("marks a failed send and retries it with the same clientId", async () => {
    let attempts = 0;
    const api = stubApi(
      paneRoutes({
        over: {
          [`POST ${CONV}/messages`]: (init) => {
            attempts++;
            if (attempts === 1) return { status: 500, body: { error: { code: "internal", message: "nope" } } };
            const b = JSON.parse(init.body as string);
            return { body: msg("m_200", { authorType: "agent", body: b.body, clientId: b.clientId }) };
          },
        },
      }),
    );
    await openPane();

    fireEvent.change(reply(), { target: { value: "Try me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const retry = await screen.findByRole("button", { name: "Failed — retry" });

    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Failed — retry" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("log").querySelector(".msg.pending")).toBeNull());
    expect(within(screen.getByRole("log")).getByText("Try me")).toBeTruthy();

    const posts = api.find("POST", `${CONV}/messages`).map((c) => JSON.parse(c.init.body as string));
    expect(posts).toHaveLength(2);
    expect(posts[1].clientId).toBe(posts[0].clientId);
  });

  it("filters saved replies on '/' and applies the highlighted one with the contact's first name", async () => {
    stubApi(
      paneRoutes({
        over: {
          "GET /agent/w/ws_1/canned-replies": () => ({
            body: [
              { id: "c1", shortcut: "greet", title: "Greeting", body: "Hi {{name}}!" },
              { id: "c2", shortcut: "hello", title: "Formal greeting", body: "Hello {{ name }}, I'm {{agent}}." },
              { id: "c3", shortcut: "bye", title: "Goodbye", body: "Bye" },
            ],
          }),
        },
      }),
    );
    await openPane();

    fireEvent.change(reply(), { target: { value: "/gree" } });
    const menu = await screen.findByRole("listbox");
    expect(within(menu).getAllByRole("option").map((o) => o.querySelector("strong")?.textContent)).toEqual(["/greet", "/hello"]);
    expect(within(menu).getAllByRole("option")[0]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(reply(), { key: "ArrowDown" });
    expect(within(menu).getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(reply(), { key: "Enter" });

    expect(reply().value).toBe("Hello Jane, I'm Alex Agent.");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Mouse selection works too, and ArrowUp wraps around.
    fireEvent.change(reply(), { target: { value: "/" } });
    fireEvent.keyDown(reply(), { key: "ArrowUp" });
    expect(within(screen.getByRole("listbox")).getAllByRole("option")[2]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(within(screen.getByRole("listbox")).getByText("/greet").closest("button")!);
    expect(reply().value).toBe("Hi Jane!");

    // Screen readers get combobox semantics pointing at the highlighted reply.
    fireEvent.change(reply(), { target: { value: "/bye" } });
    const listbox = screen.getByRole("listbox");
    expect(reply().getAttribute("role")).toBe("combobox");
    expect(reply().getAttribute("aria-expanded")).toBe("true");
    expect(reply().getAttribute("aria-controls")).toBe(listbox.id);
    expect(document.getElementById(reply().getAttribute("aria-activedescendant")!)?.textContent).toContain("/bye");
    // Escape closes the menu so "/bye" can be sent as plain text; typing reopens it.
    fireEvent.keyDown(reply(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(reply().getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(reply(), { target: { value: "/by" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("PATCHes the assignee and status and reflects the server's answer", async () => {
    const summary = conv("cv_1", { contact: { ...conv("cv_1").contact, name: "Jane Doe" } });
    const api = stubApi(
      paneRoutes({
        summary,
        over: {
          [`PATCH ${CONV}`]: (init) => {
            const b = JSON.parse(init.body as string);
            return {
              body: {
                ...summary,
                status: b.status ?? "open",
                assignee: b.assigneeId ? { id: b.assigneeId, name: "x", avatarUrl: null } : null,
              },
            };
          },
        },
      }),
    );
    await openPane();
    const header = within(thread());
    const select = header.getByLabelText("Assignee") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Unassigned", "Alex Agent (you)", "Bo Other"]);

    fireEvent.change(select, { target: { value: "ag_bo" } });
    await waitFor(() => expect(select.value).toBe("ag_bo"));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(select.value).toBe(""));

    fireEvent.click(header.getByRole("button", { name: "Snooze" }));
    await waitFor(() => expect(header.queryByRole("button", { name: "Snooze" })).toBeNull());
    expect(header.getByText("Pending")).toBeTruthy();

    fireEvent.click(header.getByRole("button", { name: "Resolve" }));
    const reopen = await header.findByRole("button", { name: "Reopen" });
    expect(header.getByText("Resolved")).toBeTruthy();

    fireEvent.click(reopen);
    await header.findByRole("button", { name: "Snooze" });
    expect(header.getByText("Open")).toBeTruthy();

    expect(api.find("PATCH", CONV).map((c) => JSON.parse(c.init.body as string))).toEqual([
      { assigneeId: "ag_bo" },
      { assigneeId: null },
      { status: "pending" },
      { status: "resolved" },
      { status: "open" },
    ]);
  });

  it("toasts when an update fails", async () => {
    stubApi(paneRoutes({ over: { [`PATCH ${CONV}`]: () => ({ status: 409, body: { error: { code: "conflict", message: "x" } } }) } }));
    await openPane();
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("Update failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy();
  });

  it("applies realtime message, typing, read and status events", async () => {
    const api = stubApi(
      paneRoutes({
        messages: [msg("m_001", { authorType: "agent", author: { id: "ag_me", name: "Alex Agent", avatarUrl: null }, body: "Anything else?", createdAt: NOW - 10_000 })],
      }),
    );
    const { container } = await openPane();
    const ws = await convSocket();
    ws.open();
    const agentMeta = () => container.querySelector(".msg.agent .msg-meta")!.textContent;
    expect(agentMeta()).not.toContain("Seen");

    ws.emit({ type: "typing", authorType: "contact", name: null, typing: true });
    expect(screen.getByText("Jane Doe is typing…")).toBeTruthy();
    // Agent typing events are ignored.
    ws.emit({ type: "typing", authorType: "agent", name: "Bo", typing: false });
    expect(screen.getByText("Jane Doe is typing…")).toBeTruthy();

    ws.emit({ type: "read", authorType: "contact", at: NOW });
    expect(agentMeta()).toMatch(/ · Seen$/);

    const readsBefore = api.find("POST", `${CONV}/read`).length;
    ws.emit({ type: "message.created", message: msg("m_002", { body: "No thanks" }) });
    expect(screen.queryByText("Jane Doe is typing…")).toBeNull();
    // Read receipts are debounced (1s) so a burst of messages sends one.
    await waitFor(() => expect(api.find("POST", `${CONV}/read`).length).toBe(readsBefore + 1), { timeout: 2500 });
    // A duplicate delivery (e.g. after a reconnect) is not rendered twice.
    ws.emit({ type: "message.created", message: msg("m_002", { body: "No thanks" }) });
    expect(within(screen.getByRole("log")).getAllByText("No thanks")).toHaveLength(1);

    ws.emit({ type: "status.changed", status: "resolved", assigneeId: null });
    expect(within(thread()).getByRole("button", { name: "Reopen" })).toBeTruthy();
  });

  it("clears the contact typing indicator after 6 seconds without updates", async () => {
    stubApi(paneRoutes());
    await openPane();
    const ws = await convSocket();
    vi.useFakeTimers();
    try {
      ws.emit({ type: "typing", authorType: "contact", name: null, typing: true });
      expect(screen.getByText("Jane Doe is typing…")).toBeTruthy();
      act(() => vi.advanceTimersByTime(6000));
      expect(screen.queryByText("Jane Doe is typing…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends agent typing frames over the conversation socket", async () => {
    stubApi(paneRoutes());
    await openPane();
    const ws = await convSocket();
    ws.open();

    fireEvent.change(reply(), { target: { value: "h" } });
    fireEvent.change(reply(), { target: { value: "hi" } });
    fireEvent.change(reply(), { target: { value: "" } });
    // Canned-reply queries never count as typing.
    fireEvent.change(reply(), { target: { value: "/greet" } });

    expect(ws.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", typing: true },
      { type: "typing", typing: false },
    ]);
  });

  it("marks the online agents in the assignee picker from inbox presence", async () => {
    stubApi(paneRoutes());
    await openPane();
    const ws = await inboxSocket();
    ws.emit({ type: "presence", onlineAgentIds: ["ag_bo"] });

    const select = within(thread()).getByLabelText("Assignee") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Unassigned", "Alex Agent (you)", "Bo Other ●"]);
  });

  it("uploads an attachment, shows a chip and sends it with the reply", async () => {
    const api = stubApi(
      paneRoutes({
        over: {
          "POST /agent/w/ws_1/attachments": () => ({ body: { id: "at_9", name: "my file.png", contentType: "image/png", size: 4 } }),
          [`POST ${CONV}/messages`]: (init) => {
            const b = JSON.parse(init.body as string);
            return { body: msg("m_300", { authorType: "agent", body: b.body, clientId: b.clientId, attachments: [{ id: "at_9", name: "my file.png", contentType: "image/png", size: 4, url: "https://f/9.png" }] }) };
          },
        },
      }),
    );
    const { container } = await openPane();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const file = new File(["abcd"], "my file.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });

    const chip = await screen.findByText("my file.png");
    expect(chip.className).toBe("file-chip");
    const [upload] = api.find("POST", "/agent/w/ws_1/attachments");
    const headers = upload!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["X-Filename"]).toBe("my%20file.png");
    expect(upload!.init.body).toBe(file);

    // Attachment-only replies are allowed.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.find("POST", `${CONV}/messages`)).toHaveLength(1));
    expect(JSON.parse(api.find("POST", `${CONV}/messages`)[0]!.init.body as string)).toMatchObject({ body: "", attachmentIds: ["at_9"] });
    expect(await screen.findByAltText("my file.png")).toBeTruthy();
    expect(container.querySelector(".composer .file-chip")).toBeNull();
  });

  it("removes an upload chip and toasts upload errors", async () => {
    let n = 0;
    stubApi(
      paneRoutes({
        over: {
          "POST /agent/w/ws_1/attachments": () =>
            ++n === 1 ? { body: { id: "at_1", name: "a.pdf", contentType: "application/pdf", size: 1 } } : { status: 413, body: { error: { code: "too_large", message: "File too large" } } },
        },
      }),
    );
    const { container } = await openPane();
    const input = container.querySelector("input[type=file]") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] } });
    await screen.findByText("a.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Remove a.pdf" }));
    expect(screen.queryByText("a.pdf")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { files: [new File(["x"], "b.pdf", { type: "application/pdf" })] } });
    expect(await screen.findByText("File too large")).toBeTruthy();
    expect(screen.queryByText("Uploading…")).toBeNull();
  });
});
