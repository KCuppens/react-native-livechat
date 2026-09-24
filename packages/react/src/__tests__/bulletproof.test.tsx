import { LiveChatClient, createMemoryStorage } from "@kobecuppens/livechat-core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveChatProvider, Messenger, useMessenger } from "../index";
import { MessengerErrorBoundary } from "../web/screens/shared";
import { onColor } from "../web/util";

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

describe("web messenger (bulletproof round 1)", () => {
  it("picks the text color with the higher contrast", () => {
    expect(onColor("#10B981")).toBe("#111827"); // emerald: white would be ~2.5:1
    expect(onColor("#4F46E5")).toBe("#ffffff");
    expect(onColor("#fff")).toBe("#111827"); // 3-digit hex
  });

  it("has no Close button when rendered inline", async () => {
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={makeClient()}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    await screen.findByText("Send us a message");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("moves focus into the panel when opened and back to the opener when closed", async () => {
    const client = makeClient();
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Go to={{ name: "home" }} />
        <Messenger />
      </LiveChatProvider>,
    );
    const opener = screen.getByText("go");
    opener.focus();
    await act(async () => fireEvent.click(opener));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Escape meant for the host page (outside the panel) leaves the messenger alone.
    await act(async () => fireEvent.keyDown(opener, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => fireEvent.keyDown(dialog, { key: "Escape" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("shows an error with retry when the help home fails, not an empty screen", async () => {
    let fail = true;
    const client = makeClient({ "GET /v1/faq/categories": () => (fail ? { status: 503, body: { error: { code: "down", message: "x" } } } : { body: [] }) });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Messenger inline />
      </LiveChatProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a retry when a conversation fails to load", async () => {
    let fail = true;
    const conv = { id: "cv_1", status: "open", assignee: null, lastMessage: null, lastMessageAt: 1, contactLastReadAt: 0, agentLastReadAt: 0, unreadCount: 0, csatScore: null, createdAt: 1 };
    const client = makeClient({
      "GET /v1/conversations/cv_1": () => ({ body: conv }),
      "GET /v1/conversations/cv_1/messages": () => (fail ? { status: 503, body: { error: { code: "down", message: "x" } } } : { body: { items: [], nextCursor: null } }),
      "POST /v1/conversations/cv_1/read": () => ({ status: 204 }),
    });
    render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Go to={{ name: "conversation", id: "cv_1" }} />
        <Messenger inline />
      </LiveChatProvider>,
    );
    await screen.findByText("Send us a message");
    fireEvent.click(screen.getByText("go"));
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("log")).toBeTruthy());
  });

  it("keeps a render crash inside the messenger", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("bad payload");
    };
    render(
      <MessengerErrorBoundary fallback={() => <div>contained</div>}>
        <Boom />
      </MessengerErrorBoundary>,
    );
    expect(screen.getByText("contained")).toBeTruthy();
  });
});
