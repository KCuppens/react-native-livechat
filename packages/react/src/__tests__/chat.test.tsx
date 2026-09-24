import { LiveChatClient, createMemoryStorage, type Conversation, type Message, type ServerEvent } from "@kobecuppens/livechat-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveChatProvider, Messenger, useMessenger } from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: true,
  typicalReplyMinutes: 5,
};
const contact = { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false };

/** Controllable WebSocket: tests open it and push server events through it. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
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

function conv(partial: Partial<Conversation> = {}): Conversation {
  return {
    id: "cv_1",
    status: "open",
    assignee: null,
    lastMessage: null,
    lastMessageAt: 1,
    contactLastReadAt: 0,
    agentLastReadAt: 0,
    unreadCount: 0,
    csatScore: null,
    createdAt: 1,
    ...partial,
  };
}

type Reply = { status: number; body?: unknown } | unknown;
type Handler = (body: any, url: URL) => Reply;

interface Call {
  key: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}

function server(opts: { messages?: Message[]; nextCursor?: string | null; conversation?: Partial<Conversation>; routes?: Record<string, Handler> } = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    "GET /v1/config": () => config,
    "POST /v1/session": () => ({ token: "tok", expiresAt: Date.now() + 1e9, contact }),
    "GET /v1/conversations/unread": () => ({ count: 0 }),
    "GET /v1/conversations": () => ({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => [],
    "GET /v1/faq/articles": () => [],
    "GET /v1/conversations/cv_1": () => conv(opts.conversation),
    "GET /v1/conversations/cv_1/messages": () => ({ items: opts.messages ?? [], nextCursor: opts.nextCursor ?? null }),
    "POST /v1/conversations/cv_1/read": () => undefined,
    ...opts.routes,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404 });
    const out = handler(body, url);
    if (out === undefined) return new Response(null, { status: 204 });
    if (out && typeof out === "object" && "status" in out && typeof (out as { status: unknown }).status === "number") {
      const r = out as { status: number; body?: unknown };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const clients: LiveChatClient[] = [];

function OpenConversation({ id }: { id: string }) {
  const messenger = useMessenger();
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once on mount
  useEffect(() => {
    messenger.open({ name: "conversation", id });
  }, []);
  return null;
}

async function renderChat(s: ReturnType<typeof server>) {
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage: createMemoryStorage(),
    locale: "en",
    fetch: s.fetch,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  clients.push(client);
  const utils = render(
    <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
      <OpenConversation id="cv_1" />
      <Messenger inline />
    </LiveChatProvider>,
  );
  await waitFor(() => expect(client.state.threads.cv_1?.loaded).toBe(true));
  await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
  return { client, calls: s.calls, socket: FakeSocket.instances[0]!, ...utils };
}

const composer = () => screen.getByLabelText("Write a message…") as HTMLTextAreaElement;
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

function pngFile(name = "shot.png", size?: number) {
  const f = new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
}

beforeEach(() => {
  FakeSocket.instances = [];
  // happy-dom never loads images; resolve dimensions like a browser would.
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.destroy();
  vi.unstubAllGlobals();
});

describe("ChatScreen", () => {
  it("renders agent messages with the author name once per group and the avatar on the last of the group", async () => {
    const { container } = await renderChat(
      server({
        conversation: { assignee: { id: "ag_1", name: "Sam Lee", avatarUrl: null } as Conversation["assignee"] },
        messages: [
          msg({ id: "m01", body: "Hello there" }),
          msg({ id: "m02", body: "How can I help?" }),
          msg({ id: "m03", body: "Anonymous bot", author: null as unknown as Message["author"] }),
          msg({ id: "m04", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "Refund please" }),
        ],
      }),
    );
    expect(await screen.findByText("Hello there")).toBeTruthy();
    expect(screen.getByText("How can I help?")).toBeTruthy();
    // Header shows the assignee's name.
    expect(screen.getByText("Sam Lee", { selector: "strong" })).toBeTruthy();
    // Author name appears once for Sam's group, "Support" for the author-less message.
    expect(screen.getAllByText("Sam Lee", { selector: ".lc-author" })).toHaveLength(1);
    expect(screen.getByText("Support", { selector: ".lc-author" })).toBeTruthy();

    const agentRows = [...container.querySelectorAll(".lc-msg:not(.lc-mine)")];
    expect(agentRows).toHaveLength(3);
    expect(agentRows[0]!.classList.contains("lc-first")).toBe(true);
    expect(agentRows[0]!.querySelector(".lc-hidden")).not.toBeNull(); // avatar hidden mid-group
    expect(agentRows[1]!.classList.contains("lc-first")).toBe(false);
    expect(agentRows[1]!.querySelector(".lc-avatar")?.textContent).toBe("SL");
    expect(container.querySelector(".lc-msg.lc-mine")?.textContent).toContain("Refund please");
  });

  it("renders system messages for resolved, reopened, assigned and auto replies", async () => {
    await renderChat(
      server({
        messages: [
          msg({ id: "m01", authorType: "system", systemEvent: "auto_reply", body: "We'll reply soon" }),
          msg({ id: "m02", authorType: "system", systemEvent: "assigned", body: "Sam" }),
          msg({ id: "m03", authorType: "system", systemEvent: "resolved", body: "" }),
          msg({ id: "m04", authorType: "system", systemEvent: "reopened", body: "" }),
          msg({ id: "m05", authorType: "system", systemEvent: null, body: "ignored" }),
        ],
      }),
    );
    expect(await screen.findByText("We'll reply soon")).toBeTruthy();
    expect(screen.getByText("Sam joined the conversation")).toBeTruthy();
    expect(screen.getByText("This conversation was marked as resolved")).toBeTruthy();
    expect(screen.getByText("Conversation reopened")).toBeTruthy();
    expect(screen.queryByText("ignored")).toBeNull();
    // Without an assignee, the header falls back to the workspace brand.
    expect(screen.getByText("Acme", { selector: "strong" })).toBeTruthy();
  });

  it("collects a CSAT rating with a comment and thanks the contact", async () => {
    const { calls } = await renderChat(
      server({
        messages: [msg({ id: "m01", authorType: "system", systemEvent: "csat_request", body: "" })],
        routes: { "POST /v1/conversations/cv_1/csat": () => undefined },
      }),
    );
    expect(await screen.findByText("How would you rate your conversation?")).toBeTruthy();
    expect(screen.queryByText("Submit")).toBeNull();

    expect(screen.getByRole("radiogroup", { name: "How would you rate your conversation?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "4 of 5" }));
    expect(screen.getByRole("radio", { name: "4 of 5" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByPlaceholderText("Tell us more (optional)"), { target: { value: "  Quick help  " } });
    fireEvent.click(screen.getByText("Submit"));

    expect(await screen.findByText("Thanks for rating us!")).toBeTruthy();
    const post = calls.find((c) => c.key === "POST /v1/conversations/cv_1/csat");
    expect(post?.body).toEqual({ score: 4, comment: "Quick help" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows the thanks note directly when the conversation was already rated", async () => {
    await renderChat(
      server({
        conversation: { csatScore: 5 },
        messages: [msg({ id: "m01", authorType: "system", systemEvent: "csat_request", body: "" })],
      }),
    );
    expect(await screen.findByText("Thanks for rating us!")).toBeTruthy();
  });

  it("marks a failed send and retries it on tap", async () => {
    let attempts = 0;
    const { calls } = await renderChat(
      server({
        routes: {
          "POST /v1/conversations/cv_1/messages": (body) =>
            ++attempts === 1
              ? { status: 500, body: { error: { code: "internal", message: "boom" } } }
              : msg({ id: "m09", authorType: "contact", clientId: body.clientId, body: body.body, author: { id: "ct_1", name: null, avatarUrl: null }, createdAt: 5 }),
        },
      }),
    );
    fireEvent.change(composer(), { target: { value: "Are you there?" } });
    fireEvent.keyDown(composer(), { key: "Enter" });

    const retry = await screen.findByText("Not sent. Tap to retry.");
    expect(composer().value).toBe("");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText("Not sent. Tap to retry.")).toBeNull());
    expect(screen.getByText("Are you there?")).toBeTruthy();
    expect(calls.filter((c) => c.key === "POST /v1/conversations/cv_1/messages")).toHaveLength(2);
  });

  it("shows 'Seen' under the last sent message once the agent read it", async () => {
    const { socket } = await renderChat(
      server({
        messages: [
          msg({ id: "m01", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "first", createdAt: 100 }),
          msg({ id: "m02", authorType: "contact", author: { id: "ct_1", name: null, avatarUrl: null }, body: "second", createdAt: 200 }),
        ],
      }),
    );
    await act(async () => socket.open());
    expect(screen.queryByText("Seen")).toBeNull();

    await act(async () => socket.emit({ type: "read", authorType: "agent", at: 150 }));
    expect(screen.queryByText("Seen")).toBeNull(); // older than the latest message

    await act(async () => socket.emit({ type: "read", authorType: "agent", at: 200 }));
    const seen = screen.getAllByText("Seen");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.closest(".lc-msg")?.textContent).toContain("second");
  });

  it("shows typing dots while the agent types", async () => {
    const { socket } = await renderChat(server());
    await act(async () => socket.open());
    await act(async () => socket.emit({ type: "typing", authorType: "agent", name: "Sam", typing: true }));
    expect(screen.getByText("Sam is typing…")).toBeTruthy();

    await act(async () => socket.emit({ type: "typing", authorType: "agent", name: null, typing: true }));
    expect(screen.getByText("Typing…")).toBeTruthy();

    await act(async () => socket.emit({ type: "typing", authorType: "agent", name: null, typing: false }));
    expect(screen.queryByText("Typing…")).toBeNull();
  });

  it("loads earlier messages with the oldest id as cursor", async () => {
    let page = 0;
    const { calls } = await renderChat(
      server({
        routes: {
          "GET /v1/conversations/cv_1/messages": (_b, url) =>
            url.searchParams.get("before")
              ? { items: [msg({ id: "m01", body: "Older one" })], nextCursor: null }
              : { items: [msg({ id: "m05", body: `Latest ${++page}` })], nextCursor: "m05" },
        },
      }),
    );
    fireEvent.click(await screen.findByText("Load earlier messages"));
    expect(await screen.findByText("Older one")).toBeTruthy();
    const older = calls.find((c) => c.key === "GET /v1/conversations/cv_1/messages" && c.url.searchParams.has("before"));
    expect(older?.url.searchParams.get("before")).toBe("m05");
    await waitFor(() => expect(screen.queryByText("Load earlier messages")).toBeNull());
  });

  it("shows the offline banner while the socket is (re)connecting after load", async () => {
    const { socket } = await renderChat(server());
    expect(await screen.findByText("You're offline. Reconnecting…")).toBeTruthy();
    await act(async () => socket.open());
    expect(screen.queryByText("You're offline. Reconnecting…")).toBeNull();
  });

  it("renders image attachments inline and other files as links", async () => {
    const { container } = await renderChat(
      server({
        messages: [
          msg({
            id: "m01",
            body: "",
            attachments: [
              { id: "a1", name: "photo.png", contentType: "image/png", size: 10, width: 20, height: 10, url: "https://cdn.test/photo.png" },
              { id: "a2", name: "invoice.pdf", contentType: "application/pdf", size: 10, url: "https://cdn.test/invoice.pdf" },
              { id: "a3", name: "pending.png", contentType: "image/png", size: 10 },
            ],
          }),
        ],
      }),
    );
    const img = (await screen.findByAltText("photo.png")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://cdn.test/photo.png");
    const pdf = screen.getByText("invoice.pdf").closest("a")!;
    expect(pdf.className).toBe("lc-attachment-file");
    expect(pdf.getAttribute("href")).toBe("https://cdn.test/invoice.pdf");
    // An image without a URL cannot be previewed; it falls back to a file link.
    expect(screen.getByText("pending.png").closest("a")?.className).toBe("lc-attachment-file");
    expect(container.querySelector(".lc-bubble")).toBeNull(); // empty body → no bubble
  });

  it("rejects unsupported and oversized files with an error chip", async () => {
    const { container, calls } = await renderChat(server());
    const exe = new File(["x"], "virus.exe", { type: "application/x-msdownload" });
    await act(async () => fireEvent.change(fileInput(container), { target: { files: [exe] } }));
    expect(await screen.findByText("virus.exe — This file type isn't supported")).toBeTruthy();

    await act(async () => fireEvent.change(fileInput(container), { target: { files: [pngFile("huge.png", 11 * 1024 * 1024)] } }));
    expect(await screen.findByText("huge.png — Files must be smaller than 10 MB")).toBeTruthy();

    expect(calls.some((c) => c.key === "POST /v1/attachments")).toBe(false);
    // Only errored chips → nothing to send.
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);

    // Chips can be dismissed.
    const chip = screen.getByText("virus.exe — This file type isn't supported").closest(".lc-chip")!;
    fireEvent.click(chip.querySelector("button")!);
    expect(screen.queryByText("virus.exe — This file type isn't supported")).toBeNull();
  });

  it("uploads a valid image and sends its attachment id with the message", async () => {
    const attachment = { id: "att_1", name: "shot.png", contentType: "image/png", size: 4, width: 640, height: 480, url: "https://cdn.test/shot.png" };
    const { container, calls } = await renderChat(
      server({
        routes: {
          "POST /v1/attachments": () => attachment,
          "POST /v1/conversations/cv_1/messages": (body) =>
            msg({ id: "m09", authorType: "contact", clientId: body.clientId, body: body.body, attachments: [attachment], author: { id: "ct_1", name: null, avatarUrl: null } }),
        },
      }),
    );
    await act(async () => fireEvent.change(fileInput(container), { target: { files: [pngFile()] } }));
    await waitFor(() => expect(container.querySelector(".lc-chip:not(.lc-uploading):not(.lc-chip-error)")).not.toBeNull());
    const upload = calls.find((c) => c.key === "POST /v1/attachments")!;
    expect(upload.headers["X-Filename"]).toBe("shot.png");
    expect(upload.headers["X-Width"]).toBe("640");
    expect(upload.headers["Content-Type"]).toBe("image/png");

    // An attachment alone is enough to send.
    const send = screen.getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(calls.some((c) => c.key === "POST /v1/conversations/cv_1/messages")).toBe(true));
    const post = calls.find((c) => c.key === "POST /v1/conversations/cv_1/messages")!;
    expect(post.body).toMatchObject({ body: "", attachmentIds: ["att_1"] });
    expect(container.querySelector(".lc-chips")).toBeNull();
    expect(await screen.findByAltText("shot.png")).toBeTruthy();
  });

  it("shows a generic error chip when the upload request fails", async () => {
    const { container } = await renderChat(
      server({ routes: { "POST /v1/attachments": () => ({ status: 500, body: { error: { code: "internal", message: "x" } } }) } }),
    );
    await act(async () => fireEvent.change(fileInput(container), { target: { files: [pngFile("a.png")] } }));
    expect(await screen.findByText("a.png — Something went wrong")).toBeTruthy();
  });

  it("uploads files pasted into the composer", async () => {
    const { calls } = await renderChat(
      server({ routes: { "POST /v1/attachments": () => ({ id: "att_2", name: "pasted.png", contentType: "image/png", size: 4 }) } }),
    );
    fireEvent.paste(composer(), { clipboardData: { files: [pngFile("pasted.png")] } });
    await waitFor(() => expect(calls.some((c) => c.key === "POST /v1/attachments")).toBe(true));
    expect(await screen.findByText("pasted.png")).toBeTruthy();
  });

  it("sends on Enter, not on Shift+Enter, and disables send while empty", async () => {
    const { calls } = await renderChat(
      server({
        routes: {
          "POST /v1/conversations/cv_1/messages": (body) =>
            msg({ id: "m09", authorType: "contact", clientId: body.clientId, body: body.body, author: { id: "ct_1", name: null, avatarUrl: null } }),
        },
      }),
    );
    const send = screen.getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(composer(), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(composer(), { key: "Enter" });

    fireEvent.change(composer(), { target: { value: "Line one" } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    expect(composer().value).toBe("Line one");

    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(composer().value).toBe("");
    await waitFor(() => expect(screen.getByText("Line one")).toBeTruthy());
    const posts = calls.filter((c) => c.key === "POST /v1/conversations/cv_1/messages");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.body).toBe("Line one");
  });
});
