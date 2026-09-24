import { LiveChatClient, createMemoryStorage } from "@kobecuppens/livechat-core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LiveChatProvider,
  useLiveChatClient,
  useLiveChatState,
  useMessenger,
  useTranslate,
  useUnreadCount,
  type MessengerControls,
} from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
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

function server() {
  const sessions: any[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (key === "GET /v1/config") return new Response(JSON.stringify(config));
    if (key === "GET /v1/conversations/unread") return new Response(JSON.stringify({ count: 3 }));
    if (key === "POST /v1/session") {
      sessions.push(body);
      if (body.userId === "bad") {
        return new Response(JSON.stringify({ error: { code: "invalid_user_hash", message: "Invalid user hash" } }), { status: 403 });
      }
      return new Response(JSON.stringify({ token: `tok_${sessions.length}`, expiresAt: Date.now() + 1e9, contact }));
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, sessions };
}

function makeClient(s = server(), storage = createMemoryStorage()) {
  return new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage,
    fetch: s.fetch,
    WebSocket: NoopSocket as unknown as typeof WebSocket,
  });
}

/** A returning visitor: a stored session means the unread badge is fetched on init. */
async function returningVisitorStorage(workspaceKey: string) {
  const storage = createMemoryStorage();
  await storage.setItem(`livechat:${workspaceKey}:session`, JSON.stringify({ token: "tok", expiresAt: Date.now() + 1e9, contact, userId: null }));
  return storage;
}

/** Captures the latest context values so tests can drive them. */
function Probe({ onRender }: { onRender: (v: { client: LiveChatClient; messenger: MessengerControls; t: ReturnType<typeof useTranslate>; unread: number; locale: string }) => void }) {
  onRender({
    client: useLiveChatClient(),
    messenger: useMessenger(),
    t: useTranslate(),
    unread: useUnreadCount(),
    locale: useLiveChatState((s) => s.locale),
  });
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("hooks outside the provider", () => {
  it.each([
    ["useLiveChatClient", () => useLiveChatClient()],
    ["useLiveChatState", () => useLiveChatState()],
    ["useTranslate", () => useTranslate()],
    ["useMessenger", () => useMessenger()],
    ["useUnreadCount", () => useUnreadCount()],
  ])("%s throws a helpful error", (_name, hook) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bad() {
      hook();
      return null;
    }
    expect(() => render(<Bad />)).toThrow("[livechat] Wrap your app in <LiveChatProvider>.");
  });
});

describe("LiveChatProvider", () => {
  it("initializes the client and exposes state, translations and unread count", async () => {
    const client = makeClient(server(), await returningVisitorStorage("pk"));
    let latest!: Parameters<Parameters<typeof Probe>[0]["onRender"]>[0];
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} strings={{ en: { "chat.send": "Go!" } }}>
        <Probe onRender={(v) => (latest = v)} />
      </LiveChatProvider>,
    );
    expect(latest.client).toBe(client);
    await waitFor(() => expect(latest.unread).toBe(3));
    expect(client.state.status).toBe("ready");
    expect(latest.t("chat.send")).toBe("Go!");
  });

  it("does not identify on first render but does when the user prop changes", async () => {
    const s = server();
    const client = makeClient(s);
    const identify = vi.spyOn(client, "identify");
    const { rerender } = render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} user={{ id: "u1", hash: "h1" }}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("ready"));
    expect(identify).not.toHaveBeenCalled();

    // Re-render with the same user identity: still no identify.
    rerender(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} user={{ id: "u1", hash: "h1", name: "Changed" }}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    expect(identify).not.toHaveBeenCalled();

    rerender(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} user={{ id: "u2", hash: "h2", email: "u2@test.dev" }}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(identify).toHaveBeenCalledWith({ id: "u2", hash: "h2", email: "u2@test.dev" }));
    await waitFor(() => expect(s.sessions.some((b) => b.userId === "u2" && b.userHash === "h2")).toBe(true));

    // Logging out passes null.
    rerender(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} user={null}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(identify).toHaveBeenLastCalledWith(null));
  });

  it("surfaces an identify failure as store error instead of an unhandled rejection", async () => {
    const proc = (globalThis as unknown as { process: { on(e: string, f: () => void): void; off(e: string, f: () => void): void } }).process;
    const unhandled = vi.fn();
    proc.on("unhandledRejection", unhandled);
    try {
      const client = makeClient();
      const { rerender } = render(
        <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
          <Probe onRender={() => {}} />
        </LiveChatProvider>,
      );
      await waitFor(() => expect(client.state.status).toBe("ready"));
      rerender(
        <LiveChatProvider apiUrl="" workspaceKey="" client={client} user={{ id: "bad", hash: "nope" }}>
          <Probe onRender={() => {}} />
        </LiveChatProvider>,
      );
      await waitFor(() => expect(client.state.error).toBe("Invalid user hash"));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      proc.off("unhandledRejection", unhandled);
    }
  });

  it("negotiates the locale prop and follows changes to it", async () => {
    const client = makeClient();
    const setLocale = vi.spyOn(client, "setLocale");
    let locale = "";
    const { rerender } = render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} locale="en-US">
        <Probe onRender={(v) => (locale = v.locale)} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("ready"));
    expect(setLocale).toHaveBeenCalledWith("en-US");
    rerender(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} locale="nl-BE">
        <Probe onRender={(v) => (locale = v.locale)} />
      </LiveChatProvider>,
    );
    expect(setLocale).toHaveBeenLastCalledWith("nl-BE");
    await waitFor(() => expect(locale).toBe("nl"));
    // Unsupported locale falls back to the workspace default.
    rerender(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} locale="de">
        <Probe onRender={(v) => (locale = v.locale)} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(locale).toBe("en"));
  });

  it("drives the messenger stack: open, navigate, back, replace, close and toggle", () => {
    const client = makeClient();
    let m!: MessengerControls;
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Probe onRender={(v) => (m = v.messenger)} />
      </LiveChatProvider>,
    );
    expect(m.isOpen).toBe(false);
    expect(m.route).toEqual({ name: "home" });
    expect(m.canGoBack).toBe(false);

    act(() => m.open({ name: "conversation", id: "cv_1" }));
    expect(m.isOpen).toBe(true);
    expect(m.route).toEqual({ name: "conversation", id: "cv_1" });
    expect(m.canGoBack).toBe(true);
    act(() => m.back());
    expect(m.route).toEqual({ name: "home" });
    expect(m.canGoBack).toBe(false);
    act(() => m.back()); // no-op at the root
    expect(m.route).toEqual({ name: "home" });

    act(() => m.navigate({ name: "new" }));
    act(() => m.navigate({ name: "article", slug: "refunds" }));
    expect(m.route).toEqual({ name: "article", slug: "refunds" });
    act(() => m.replace({ name: "conversation", id: "cv_2" }));
    expect(m.route).toEqual({ name: "conversation", id: "cv_2" });
    act(() => m.back());
    expect(m.route).toEqual({ name: "new" });

    act(() => m.close());
    expect(m.isOpen).toBe(false);
    // open() without a route keeps the current stack.
    act(() => m.open());
    expect(m.isOpen).toBe(true);
    expect(m.route).toEqual({ name: "new" });

    act(() => m.open({ name: "home" }));
    expect(m.route).toEqual({ name: "home" });
    expect(m.canGoBack).toBe(false);

    act(() => m.toggle());
    expect(m.isOpen).toBe(false);
    act(() => m.toggle());
    expect(m.isOpen).toBe(true);
  });

  it("destroys a client it created on unmount", async () => {
    const s = server();
    let created!: LiveChatClient;
    const { unmount } = render(
      <LiveChatProvider apiUrl="https://api.test" workspaceKey="pk" storage={createMemoryStorage()} fetch={s.fetch} WebSocket={NoopSocket as unknown as typeof WebSocket}>
        <Probe onRender={(v) => (created = v.client)} />
      </LiveChatProvider>,
    );
    expect(created).toBeInstanceOf(LiveChatClient);
    await waitFor(() => expect(created.state.status).toBe("ready"));
    const destroy = vi.spyOn(created, "destroy");
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves a passed-in client alive on unmount", async () => {
    const client = makeClient();
    const destroy = vi.spyOn(client, "destroy");
    const { unmount } = render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("ready"));
    unmount();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps init failures in state instead of throwing", async () => {
    const client = new LiveChatClient({
      apiUrl: "https://api.test",
      workspaceKey: "pk",
      storage: createMemoryStorage(),
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
      WebSocket: NoopSocket as unknown as typeof WebSocket,
    });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Probe onRender={() => {}} />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("error"));
    expect(client.state.error).toBe("offline");
  });
});
