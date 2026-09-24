import { createMemoryStorage, LiveChatClient, type Conversation, type Message, type ServerEvent, type WorkspaceConfig } from "@kobecuppens/livechat-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { LiveChat, LiveChatProvider, SupportModal, type PickedFile } from "../index";

// ------------------------------------------------------------ fakes

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function msg(partial: Partial<Message> & { id: string }): Message {
  return {
    conversationId: "cv_1",
    clientId: null,
    authorType: "agent",
    author: { id: "ag_1", name: "Sam Lee", avatarUrl: null },
    body: "hi",
    attachments: [],
    systemEvent: null,
    createdAt: 1,
    ...partial,
  };
}

const baseConfig: WorkspaceConfig = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: false,
  typicalReplyMinutes: null,
} as WorkspaceConfig;

function conversation(partial: Partial<Conversation> = {}): Conversation {
  return {
    id: "cv_1",
    status: "open",
    assignee: { id: "ag_1", name: "Sam Lee", avatarUrl: null },
    lastMessage: null,
    lastMessageAt: 2,
    contactLastReadAt: 0,
    agentLastReadAt: 0,
    unreadCount: 0,
    csatScore: null,
    createdAt: 1,
    ...partial,
  };
}

type Reply = { status: number; body?: unknown } | undefined;
type Route = (body: any, url: URL) => Reply;
const ok = (body?: unknown): Reply => (body === undefined ? { status: 204 } : { status: 200, body });

function setup(opts: { messages?: Message[]; nextCursor?: string | null; conv?: Partial<Conversation>; config?: Partial<WorkspaceConfig>; routes?: Record<string, Route> } = {}) {
  const calls: { key: string; url: URL; body?: any; headers: Record<string, string> }[] = [];
  let conv = conversation(opts.conv);
  const routes: Record<string, Route> = {
    "GET /v1/config": () => ok({ ...baseConfig, ...opts.config }),
    "POST /v1/session": () =>
      ok({ token: "tok", expiresAt: Date.now() + 1e9, contact: { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false } }),
    "GET /v1/conversations/unread": () => ok({ count: 0 }),
    "GET /v1/conversations": () => ok({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => ok([]),
    "GET /v1/faq/articles": () => ok([]),
    "GET /v1/conversations/cv_1": () => ok(conv),
    "GET /v1/conversations/cv_1/messages": (_b, url) =>
      ok(url.searchParams.get("before") ? { items: [], nextCursor: null } : { items: opts.messages ?? [], nextCursor: opts.nextCursor ?? null }),
    "POST /v1/conversations/cv_1/read": () => ok(),
    "POST /v1/conversations/cv_1/csat": (b) => {
      conv = { ...conv, csatScore: b.score };
      return ok();
    },
    ...opts.routes,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const out = routes[key]?.(body, url) ?? { status: 404, body: { error: { code: "not_found", message: key } } };
    return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage: createMemoryStorage(),
    locale: "en",
    fetch: fetchImpl,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
  });
  return { client, calls, routes };
}

async function mount(client: LiveChatClient, pickAttachment?: () => Promise<PickedFile | null>) {
  await render(
    <LiveChatProvider apiUrl="" workspaceKey="" client={client} pickAttachment={pickAttachment}>
      <SupportModal />
    </LiveChatProvider>,
  );
  await waitFor(() => expect(client.state.status).toBe("ready"));
}

async function openConversation(client: LiveChatClient, pickAttachment?: () => Promise<PickedFile | null>) {
  await mount(client, pickAttachment);
  await act(async () => LiveChat.open({ name: "conversation", id: "cv_1" }));
  await waitFor(() => expect(client.state.threads.cv_1?.loaded).toBe(true));
}

const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

let activeClient: LiveChatClient | null = null;
beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  activeClient?.destroy();
  activeClient = null;
});
const track = <T extends { client: LiveChatClient }>(s: T): T => {
  activeClient = s.client;
  return s;
};

// ------------------------------------------------------------ conversation view

describe("ChatScreen — existing conversation", () => {
  it("renders contact/agent bubbles, grouped author names and system messages", async () => {
    const { client } = track(
      setup({
        messages: [
          msg({ id: "m01", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "Hi there" }),
          msg({ id: "m02", body: "Hello! How can I help?" }),
          msg({ id: "m03", body: "Still there?" }),
          msg({ id: "m04", authorType: "agent", author: { id: "ag_9", name: null, avatarUrl: null }, body: "Bot reply" }),
          msg({ id: "m05", authorType: "system", author: null, body: "Alex", systemEvent: "assigned" }),
          msg({ id: "m06", authorType: "system", author: null, body: "We usually reply in a few hours", systemEvent: "auto_reply" }),
          msg({ id: "m07", authorType: "system", author: null, body: "", systemEvent: "resolved" }),
          msg({ id: "m08", authorType: "system", author: null, body: "", systemEvent: "reopened" }),
        ],
      }),
    );
    await openConversation(client);

    expect(await screen.findByText("Hi there")).toBeTruthy();
    expect(screen.getByText("Hello! How can I help?")).toBeTruthy();
    expect(screen.getByText("Still there?")).toBeTruthy();
    // Author name shown once per agent group (+ once in the header title).
    expect(screen.getAllByText("Sam Lee")).toHaveLength(2);
    // Agent without a name falls back to "Support".
    expect(screen.getByText("Support")).toBeTruthy();
    expect(screen.getByText("Alex joined the conversation")).toBeTruthy();
    expect(screen.getByText("We usually reply in a few hours")).toBeTruthy();
    expect(screen.getByText("This conversation was marked as resolved")).toBeTruthy();
    expect(screen.getByText("Conversation reopened")).toBeTruthy();
    // Offline workspace subtitle.
    expect(screen.getByText("We're away right now. Leave a message and we'll get back to you.")).toBeTruthy();
  });

  it("renders image and file attachments that open their URLs", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const { client } = track(
      setup({
        messages: [
          msg({
            id: "m01",
            body: "",
            attachments: [
              { id: "at_1", name: "photo.png", contentType: "image/png", size: 10, width: 400, height: 300, url: "https://cdn.test/photo.png" },
              { id: "at_2", name: "invoice.pdf", contentType: "application/pdf", size: 10, url: "https://cdn.test/invoice.pdf" },
            ],
          }),
        ],
      }),
    );
    await openConversation(client);

    await fireEvent.press(await screen.findByLabelText("photo.png"));
    expect(openURL).toHaveBeenCalledWith("https://cdn.test/photo.png");
    await fireEvent.press(screen.getByText("📄 invoice.pdf"));
    expect(openURL).toHaveBeenCalledWith("https://cdn.test/invoice.pdf");
    openURL.mockRestore();
  });

  it("shows the online reply-time subtitle when the workspace is online", async () => {
    const { client } = track(setup({ config: { online: true, typicalReplyMinutes: 5 } }));
    await openConversation(client);
    expect(await screen.findByText("Typically replies in 5 min")).toBeTruthy();
  });

  it("shows 'We're online' when online without a typical reply time", async () => {
    const { client } = track(setup({ config: { online: true, typicalReplyMinutes: null } }));
    await openConversation(client);
    expect(await screen.findByText("We're online")).toBeTruthy();
  });

  it("csat card: pick a face, add a comment, submit posts /csat and shows thanks", async () => {
    const { client, calls } = track(
      setup({ messages: [msg({ id: "m01", authorType: "system", author: null, body: "", systemEvent: "csat_request" })] }),
    );
    await openConversation(client);

    expect(await screen.findByText("How would you rate your conversation?")).toBeTruthy();
    expect(screen.queryByText("Submit")).toBeNull();
    await fireEvent.press(screen.getByLabelText("4 of 5"));
    expect(screen.getByLabelText("4 of 5").props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.changeText(screen.getByPlaceholderText("Tell us more (optional)"), "  Great help  ");
    await fireEvent.press(screen.getByText("Submit"));

    await waitFor(() => expect(calls.find((c) => c.key === "POST /v1/conversations/cv_1/csat")?.body).toEqual({ score: 4, comment: "Great help" }));
    expect(await screen.findByText("Thanks for rating us!")).toBeTruthy();
    expect(screen.queryByText("How would you rate your conversation?")).toBeNull();
  });

  it("csat card is replaced by thanks when the conversation already has a score", async () => {
    const { client } = track(
      setup({ conv: { csatScore: 5 }, messages: [msg({ id: "m01", authorType: "system", author: null, body: "", systemEvent: "csat_request" })] }),
    );
    await openConversation(client);
    expect(await screen.findByText("Thanks for rating us!")).toBeTruthy();
  });

  it("a failed send shows 'Not sent. Tap to retry.' and tapping retries delivery", async () => {
    let attempts = 0;
    const { client, calls } = track(
      setup({
        routes: {
          "POST /v1/conversations/cv_1/messages": (b) => {
            attempts++;
            if (attempts === 1) return { status: 500, body: { error: { code: "internal", message: "boom" } } };
            return ok(msg({ id: "m99", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, clientId: b.clientId, body: b.body, createdAt: 5 }));
          },
        },
      }),
    );
    await openConversation(client);

    const send = screen.getByLabelText("Send");
    expect(send.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(screen.getByLabelText("Write a message…"), "  Need help  ");
    await fireEvent.press(screen.getByLabelText("Send"));

    expect(await screen.findByText("Not sent. Tap to retry.")).toBeTruthy();
    expect(screen.getByText("Need help")).toBeTruthy();
    expect(calls.filter((c) => c.key === "POST /v1/conversations/cv_1/messages")[0]!.body).toMatchObject({ body: "Need help", attachmentIds: [] });

    await fireEvent.press(screen.getByText("Not sent. Tap to retry."));
    await waitFor(() => expect(screen.queryByText("Not sent. Tap to retry.")).toBeNull());
    expect(attempts).toBe(2);
    expect(screen.getByText("Need help")).toBeTruthy();
    expect(client.state.threads.cv_1!.messages.map((m) => [m.id, m.status])).toEqual([["m99", "sent"]]);
  });

  it("shows the typing indicator for agent typing events", async () => {
    const { client } = track(setup({ messages: [msg({ id: "m01", body: "Hello" })] }));
    await openConversation(client);
    await act(async () => socket().open());

    await act(async () => socket().emit({ type: "typing", authorType: "agent", name: "Sam", typing: true }));
    expect(await screen.findByLabelText("Sam is typing…")).toBeTruthy();

    await act(async () => socket().emit({ type: "typing", authorType: "agent", name: null, typing: true }));
    expect(await screen.findByLabelText("Typing…")).toBeTruthy();

    await act(async () => socket().emit({ type: "typing", authorType: "agent", name: null, typing: false }));
    await waitFor(() => expect(screen.queryByLabelText("Typing…")).toBeNull());
  });

  it("shows 'Seen' under the last contact message after an agent read event", async () => {
    const { client } = track(
      setup({ messages: [msg({ id: "m01", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "Question", createdAt: 10 })] }),
    );
    await openConversation(client);
    await act(async () => socket().open());
    expect(screen.queryByText("Seen")).toBeNull();

    await act(async () => socket().emit({ type: "read", authorType: "agent", at: 20 }));
    expect(await screen.findByText("Seen")).toBeTruthy();
  });

  it("shows the offline banner while the socket is connecting and hides it once open", async () => {
    const { client } = track(setup({ messages: [msg({ id: "m01", body: "Hello" })] }));
    await openConversation(client);

    expect(await screen.findByText("You're offline. Reconnecting…")).toBeTruthy();
    await act(async () => socket().open());
    await waitFor(() => expect(screen.queryByText("You're offline. Reconnecting…")).toBeNull());
  });

  it("loads older messages when the list reaches its end", async () => {
    const { client, calls } = track(setup({ messages: [msg({ id: "m05", body: "Latest" })], nextCursor: "m05" }));
    await openConversation(client);
    await screen.findByText("Latest");

    // Walk up from a rendered row to the list's host ScrollView and simulate layout + scrolling to the end.
    let list = screen.getByText("Latest").parent;
    while (list && typeof list.props.onScroll !== "function") list = list.parent;
    expect(list).toBeTruthy();
    const size = { width: 300, height: 400 };
    await fireEvent(list!, "layout", { nativeEvent: { layout: { x: 0, y: 0, ...size } } });
    await fireEvent(list!, "contentSizeChange", 300, 100);
    await fireEvent.scroll(list!, { nativeEvent: { contentOffset: { x: 0, y: 0 }, contentSize: { width: 300, height: 100 }, layoutMeasurement: size } });
    await waitFor(() => expect(calls.some((c) => c.key === "GET /v1/conversations/cv_1/messages" && c.url.searchParams.get("before") === "m05")).toBe(true));
  });
});

// ------------------------------------------------------------ new conversation

describe("ChatScreen — new conversation", () => {
  it("suggests articles for the draft and sending creates the conversation", async () => {
    const created = msg({ id: "m01", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "How do I reset my password" });
    const { client, calls } = track(
      setup({
        routes: {
          "GET /v1/faq/articles": (_b, url) =>
            ok(url.searchParams.get("q") ? [{ id: "art_1", categoryId: null, slug: "reset", title: "Reset password", excerpt: "", locale: "en" }] : []),
          "POST /v1/conversations": (b) => ok({ conversation: conversation({ assignee: null }), message: { ...created, clientId: b.clientId } }),
        },
        conv: { assignee: null },
        messages: [created],
      }),
    );
    await mount(client);
    await act(async () => LiveChat.open({ name: "new" }));

    expect(await screen.findByText("New conversation")).toBeTruthy();
    expect(screen.queryByText("These articles might help")).toBeNull();
    await fireEvent.changeText(screen.getByLabelText("Write a message…"), "How do I reset my password");

    expect(await screen.findByText("These articles might help", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Reset password")).toBeTruthy();
    const search = calls.find((c) => c.key === "GET /v1/faq/articles" && c.url.searchParams.get("q"));
    expect(search!.url.searchParams.get("mode")).toBe("any");
    expect(search!.url.searchParams.get("limit")).toBe("3");

    await fireEvent.press(screen.getByLabelText("Send"));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /v1/conversations")?.body).toMatchObject({ body: "How do I reset my password", attachmentIds: [] }));
    // Replaced with the created conversation (brand name header since unassigned).
    await waitFor(() => expect(screen.queryByText("New conversation")).toBeNull());
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("How do I reset my password")).toBeTruthy();
    expect(screen.queryByText("These articles might help")).toBeNull();
  });

  it("navigates to a suggested article when tapped", async () => {
    const { client } = track(
      setup({
        routes: {
          "GET /v1/faq/articles": (_b, url) =>
            ok(url.searchParams.get("q") ? [{ id: "art_1", categoryId: null, slug: "reset", title: "Reset password", excerpt: "", locale: "en" }] : []),
          "GET /v1/faq/articles/reset": () =>
            ok({ id: "art_1", categoryId: null, slug: "reset", title: "Reset password", excerpt: "", locale: "en", bodyMd: "Tap **Forgot password**.", updatedAt: 1 }),
        },
      }),
    );
    await mount(client);
    await act(async () => LiveChat.open({ name: "new" }));
    await fireEvent.changeText(await screen.findByLabelText("Write a message…"), "How do I reset my password");
    await fireEvent.press(await screen.findByText("Reset password", {}, { timeout: 3000 }));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
  });
});

// ------------------------------------------------------------ attachments

describe("ChatScreen — attachments", () => {
  const realFetch = globalThis.fetch;
  let fileFetch: jest.Mock;
  beforeEach(() => {
    fileFetch = jest.fn(async (uri: string) => {
      if (!uri.startsWith("file://")) throw new Error(`unexpected global fetch: ${uri}`);
      return { blob: async () => new Blob(["bytes"]) };
    });
    globalThis.fetch = fileFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const file = (over: Partial<PickedFile> = {}): PickedFile => ({ uri: "file:///tmp/photo.png", name: "photo.png", type: "image/png", size: 1234, width: 640, height: 480, ...over });

  it("hides the attach button when no pickAttachment is provided", async () => {
    const { client } = track(setup());
    await openConversation(client);
    await screen.findByLabelText("Write a message…");
    expect(screen.queryByLabelText("Attach a file")).toBeNull();
  });

  it("does nothing when the picker is cancelled", async () => {
    const pick = jest.fn(async () => null);
    const { client, calls } = track(setup());
    await openConversation(client, pick);
    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(fileFetch).not.toHaveBeenCalled();
    expect(calls.some((c) => c.key === "POST /v1/attachments")).toBe(false);
  });

  it("uploads the picked file, shows its chip, and sends it with the message", async () => {
    const attachment = { id: "at_1", name: "photo.png", contentType: "image/png", size: 1234, width: 640, height: 480 };
    const { client, calls } = track(
      setup({
        routes: {
          "POST /v1/attachments": () => ok(attachment),
          "POST /v1/conversations/cv_1/messages": (b) =>
            ok(msg({ id: "m50", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, clientId: b.clientId, body: b.body, attachments: [attachment] })),
        },
      }),
    );
    await openConversation(client, async () => file());

    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    expect(await screen.findByText("photo.png")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.key === "POST /v1/attachments")).toBe(true));
    expect(fileFetch).toHaveBeenCalledWith("file:///tmp/photo.png");
    const upload = calls.find((c) => c.key === "POST /v1/attachments")!;
    expect(upload.headers).toMatchObject({ "Content-Type": "image/png", "X-Filename": "photo.png", "X-Width": "640", "X-Height": "480" });

    // An uploaded attachment alone enables send.
    await waitFor(() => expect(screen.getByLabelText("Send").props.accessibilityState).toMatchObject({ disabled: false }));
    await fireEvent.press(screen.getByLabelText("Send"));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /v1/conversations/cv_1/messages")?.body).toMatchObject({ body: "", attachmentIds: ["at_1"] }));
    // Chip cleared after sending.
    expect(screen.queryByLabelText("Close photo.png")).toBeNull();
  });

  it("shows 'This file type isn't supported' for unsupported files without uploading", async () => {
    const { client, calls } = track(setup());
    await openConversation(client, async () => file({ uri: "file:///tmp/a.zip", name: "a.zip", type: "application/zip" }));

    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    expect(await screen.findByText("a.zip — This file type isn't supported")).toBeTruthy();
    expect(calls.some((c) => c.key === "POST /v1/attachments")).toBe(false);
    expect(screen.getByLabelText("Send").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("shows a size error for files over 10 MB", async () => {
    const { client } = track(setup());
    await openConversation(client, async () => file({ size: 11 * 1024 * 1024 }));
    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    expect(await screen.findByText("photo.png — Files must be smaller than 10 MB")).toBeTruthy();
  });

  it("shows a generic error when the upload request fails", async () => {
    const { client } = track(setup({ routes: { "POST /v1/attachments": () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }) } }));
    await openConversation(client, async () => file());
    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    expect(await screen.findByText("photo.png — Something went wrong")).toBeTruthy();
  });

  it("pressing a chip removes it", async () => {
    const { client } = track(setup());
    await openConversation(client, async () => file({ uri: "file:///tmp/a.zip", name: "a.zip", type: "application/zip" }));
    await fireEvent.press(await screen.findByLabelText("Attach a file"));
    await screen.findByText("a.zip — This file type isn't supported");

    await fireEvent.press(screen.getByLabelText("Close a.zip"));
    expect(screen.queryByText("a.zip — This file type isn't supported")).toBeNull();
  });
});

describe("bulletproof round 1 (RN)", () => {
  it("tells the contact when submitting a rating fails", async () => {
    const { client } = track(
      setup({
        messages: [msg({ id: "m01", authorType: "system", author: null, body: "", systemEvent: "csat_request" })],
        routes: { "POST /v1/conversations/cv_1/csat": () => ({ status: 500, body: { error: { code: "boom", message: "x" } } }) },
      }),
    );
    await openConversation(client);
    await fireEvent.press(await screen.findByLabelText("4 of 5"));
    await fireEvent.press(screen.getByText("Submit"));
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.queryByText("Thanks for rating us!")).toBeNull();
  });

  it("shows Retry when the conversation fails to load, and recovers", async () => {
    let fail = true;
    const { client } = track(
      setup({
        routes: {
          "GET /v1/conversations/cv_1/messages": () => (fail ? { status: 503, body: { error: { code: "down", message: "x" } } } : ok({ items: [], nextCursor: null })),
        },
      }),
    );
    await mount(client);
    await act(async () => LiveChat.open({ name: "conversation", id: "cv_1" }));
    const retry = await screen.findByText("Retry");
    fail = false;
    await fireEvent.press(retry);
    await waitFor(() => expect(screen.queryByText("Retry")).toBeNull());
  });
});
