import { createMemoryStorage, LiveChatClient } from "@kobecuppens/livechat-core";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { AppState, Text, type AppStateStatus } from "react-native";
import { LiveChat, LiveChatProvider, SupportModal, usePickAttachment, type PickedFile } from "../index";

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: false,
  typicalReplyMinutes: null,
};

function makeClient(overrides: Record<string, () => { status: number; body?: unknown }> = {}) {
  const calls: string[] = [];
  const routes: Record<string, () => { status: number; body?: unknown }> = {
    "GET /v1/config": () => ({ status: 200, body: config }),
    "POST /v1/session": () => ({
      status: 200,
      body: { token: "tok", expiresAt: Date.now() + 1e9, contact: { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false } },
    }),
    "GET /v1/conversations/unread": () => ({ status: 200, body: { count: 0 } }),
    "GET /v1/conversations": () => ({ status: 200, body: { items: [], nextCursor: null } }),
    "GET /v1/faq/categories": () => ({ status: 200, body: [] }),
    "GET /v1/faq/articles": () => ({ status: 200, body: [] }),
    "POST /v1/push-devices": () => ({ status: 204 }),
    ...overrides,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${new URL(input).pathname}`;
    calls.push(key);
    const out = routes[key]?.() ?? { status: 404, body: { error: { code: "not_found", message: key } } };
    return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage: createMemoryStorage(),
    locale: "en",
    fetch: fetchImpl,
    WebSocket: NoopSocket as unknown as typeof WebSocket,
  });
  return { client, calls };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("LiveChat.handleNotification", () => {
  it("returns false for missing data, other types and non-string conversation ids", () => {
    expect(LiveChat.handleNotification(undefined)).toBe(false);
    expect(LiveChat.handleNotification(null)).toBe(false);
    expect(LiveChat.handleNotification({})).toBe(false);
    expect(LiveChat.handleNotification({ type: "marketing", conversationId: "cv_1" })).toBe(false);
    expect(LiveChat.handleNotification({ type: "livechat" })).toBe(false);
    expect(LiveChat.handleNotification({ type: "livechat", conversationId: 42 as unknown as string })).toBe(false);
  });

  it("returns true for a livechat payload even when no modal is mounted", () => {
    expect(LiveChat.handleNotification({ type: "livechat", conversationId: "cv_1" })).toBe(true);
  });
});

describe("LiveChat.open / close", () => {
  it("opens and closes the support modal", async () => {
    const { client } = makeClient();
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <SupportModal />
      </LiveChatProvider>,
    );
    await waitFor(() => expect(client.state.status).toBe("ready"));
    expect(screen.queryByText("Send us a message")).toBeNull();

    await act(async () => LiveChat.open());
    expect(await screen.findByText("Send us a message")).toBeTruthy();

    await act(async () => LiveChat.close());
    await waitFor(() => expect(screen.queryByText("Send us a message")).toBeNull());
  });

  it("is a no-op when no provider is mounted", () => {
    expect(() => {
      LiveChat.open();
      LiveChat.close();
    }).not.toThrow();
  });
});

describe("AppState foreground handling", () => {
  function captureAppState() {
    let listener: ((s: AppStateStatus) => void) | null = null;
    const remove = jest.fn();
    jest.spyOn(AppState, "addEventListener").mockImplementation(((type: string, handler: (s: AppStateStatus) => void) => {
      if (type === "change") listener = handler;
      return { remove };
    }) as typeof AppState.addEventListener);
    return { emit: (s: AppStateStatus) => listener!(s), remove, has: () => listener !== null };
  }

  it("calls client.resume only when returning to active from background/inactive", async () => {
    const app = captureAppState();
    const { client } = makeClient();
    const resume = jest.spyOn(client, "resume");
    const view = await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Text>app</Text>
      </LiveChatProvider>,
    );
    expect(app.has()).toBe(true);

    await act(async () => app.emit("active"));
    expect(resume).not.toHaveBeenCalled();

    await act(async () => app.emit("background"));
    expect(resume).not.toHaveBeenCalled();
    await act(async () => app.emit("active"));
    expect(resume).toHaveBeenCalledTimes(1);

    await act(async () => app.emit("inactive"));
    await act(async () => app.emit("active"));
    expect(resume).toHaveBeenCalledTimes(2);

    await view.unmount();
    expect(app.remove).toHaveBeenCalled();
  });
});

describe("push registration", () => {
  it("logs a queued registration failure with console.warn instead of throwing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { client, calls } = makeClient({ "POST /v1/push-devices": () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }) });

    await expect(LiveChat.registerPushToken({ platform: "android", token: "fcm-1", appId: "com.acme" })).resolves.toBeUndefined();
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Text>app</Text>
      </LiveChatProvider>,
    );

    await waitFor(() => expect(warn).toHaveBeenCalledWith("[livechat] push registration failed", expect.objectContaining({ code: "internal" })));
    expect(calls).toContain("POST /v1/push-devices");
  });

  it("registers directly once the provider is mounted and rejects on failure", async () => {
    const { client, calls } = makeClient({ "POST /v1/push-devices": () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }) });
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Text>app</Text>
      </LiveChatProvider>,
    );
    await expect(LiveChat.registerPushToken({ platform: "ios", token: "apns-2", appId: "com.acme", sandbox: true })).rejects.toMatchObject({ code: "internal" });
    expect(calls).toContain("POST /v1/push-devices");
  });
});

describe("usePickAttachment", () => {
  function Probe({ onValue }: { onValue: (v: unknown) => void }) {
    onValue(usePickAttachment());
    return null;
  }

  it("returns the pickAttachment function given to the provider", async () => {
    const { client } = makeClient();
    const pick = async (): Promise<PickedFile | null> => null;
    let seen: unknown = "unset";
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client} pickAttachment={pick}>
        <Probe onValue={(v) => (seen = v)} />
      </LiveChatProvider>,
    );
    expect(seen).toBe(pick);
  });

  it("returns undefined when none is provided", async () => {
    const { client } = makeClient();
    let seen: unknown = "unset";
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Probe onValue={(v) => (seen = v)} />
      </LiveChatProvider>,
    );
    expect(seen).toBeUndefined();
  });
});
