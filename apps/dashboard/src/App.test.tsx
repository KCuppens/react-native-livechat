import type { AgentConversation, AgentMe, CsatReport } from "@kobecuppens/livechat-protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "./api";
import { App } from "./App";
import { Router } from "./router";

type Reply = { status?: number; body?: unknown };

/** Fake backend keyed by "METHOD /path" (query ignored); unrouted requests answer 404. */
function stubApi(routes: Record<string, () => Reply>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
    const r = routes[key]?.() ?? { status: 404, body: { error: { code: "not_found", message: key } } };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  const urls = () => fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}`);
  return { fetchMock, urls };
}

/** Inbox opens a live socket; a silent stand-in keeps it from touching the network. */
class SilentWebSocket {
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}

const agent = { id: "ag_1", email: "sam@acme.test", name: "Sam Agent", avatarUrl: null };
const meWith = (over: Partial<AgentMe> = {}): AgentMe => ({ agent, superAdmin: false, workspaces: [{ id: "ws_1", name: "Acme", role: "agent" }], ...over });

const report: CsatReport = {
  days: 30,
  responses: 4,
  average: 4.5,
  distribution: [0, 0, 0, 2, 2],
  conversations: 12,
  resolved: 9,
  medianFirstResponseMinutes: 3,
  recentComments: [],
};

const unreadConversation: AgentConversation = {
  id: "cv_1",
  status: "open",
  assignee: null,
  lastMessage: null,
  lastMessageAt: Date.now(),
  contactLastReadAt: 0,
  agentLastReadAt: 0,
  unreadCount: 2,
  csatScore: null,
  createdAt: Date.now(),
  csatComment: null,
  contact: { id: "ct_1", externalId: null, email: null, name: "Jane", locale: null, verified: false, lastSeenAt: Date.now() },
};

const workspaceRoutes = {
  "GET /agent/workspaces/ws_1/members": () => ({ body: [] }),
  "GET /agent/w/ws_1/conversations": () => ({ body: { items: [], nextCursor: null } }),
  "GET /agent/w/ws_1/reports": () => ({ body: report }),
};

function renderApp(url: string) {
  history.replaceState(null, "", url);
  return render(
    <Router>
      <App />
    </Router>,
  );
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", SilentWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("App routing", () => {
  it("renders the login page on /login without asking who is signed in", async () => {
    const { fetchMock } = stubApi({});
    renderApp("/login");
    expect(screen.getByRole("heading", { name: "Sign in to Support" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the verify page on /login/verify", async () => {
    stubApi({});
    renderApp("/login/verify");
    expect(await screen.findByRole("heading", { name: "Link expired" })).toBeTruthy();
  });

  it("redirects to /login when the session is missing", async () => {
    const replace = vi.spyOn(history, "replaceState");
    const { urls } = stubApi({ "GET /agent/me": () => ({ status: 401, body: { error: { code: "unauthorized", message: "no" } } }) });
    renderApp("/w/ws_1/inbox");

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Sign in to Support" })).toBeTruthy();
    expect(location.pathname).toBe("/login");
    expect(replace).toHaveBeenLastCalledWith(null, "", "/login");
    expect(urls()).toEqual(["GET /agent/me"]);
  });

  it("sends a signed-in agent from / to their first workspace's inbox", async () => {
    stubApi({
      "GET /agent/me": () => ({ body: meWith({ workspaces: [{ id: "ws_1", name: "Acme", role: "agent" }, { id: "ws_2", name: "Beta", role: "admin" }] }) }),
      ...workspaceRoutes,
    });
    renderApp("/");

    await waitFor(() => expect(location.pathname).toBe("/w/ws_1/inbox"));
    expect(await screen.findByText("No open conversations 🎉")).toBeTruthy();
    expect((screen.getByLabelText("Workspace") as HTMLSelectElement).value).toBe("ws_1");
    expect(screen.getByText("Sam Agent")).toBeTruthy();
  });

  it("redirects an unknown workspace id to the first workspace", async () => {
    stubApi({ "GET /agent/me": () => ({ body: meWith() }), ...workspaceRoutes });
    renderApp("/w/ws_gone/reports");
    await waitFor(() => expect(location.pathname).toBe("/w/ws_1/inbox"));
  });

  it("sends a super admin without workspaces to /new-workspace", async () => {
    stubApi({ "GET /agent/me": () => ({ body: meWith({ superAdmin: true, workspaces: [] }) }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "New workspace" })).toBeTruthy();
    expect(location.pathname).toBe("/new-workspace");
  });

  it("tells an agent without workspaces to ask for an invite", async () => {
    stubApi({ "GET /agent/me": () => ({ body: meWith({ workspaces: [] }) }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "No workspaces yet" })).toBeTruthy();
    expect(screen.getByText("Ask an admin to invite you to a workspace.")).toBeTruthy();
    expect(location.pathname).toBe("/");
  });

  it("renders the reports section for /w/:ws/reports", async () => {
    const { urls } = stubApi({ "GET /agent/me": () => ({ body: meWith() }), ...workspaceRoutes });
    renderApp("/w/ws_1/reports");

    expect(await screen.findByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(await screen.findByText("4.5 / 5")).toBeTruthy();
    expect(urls()).toContain("GET /agent/w/ws_1/reports?days=30");
    expect(screen.getByRole("link", { name: /Reports/ }).className).toBe("nav-link active");
  });

  it("shows the inbox unread count in the sidebar", async () => {
    stubApi({
      "GET /agent/me": () => ({ body: meWith() }),
      ...workspaceRoutes,
      "GET /agent/w/ws_1/conversations": () => ({ body: { items: [unreadConversation], nextCursor: null } }),
    });
    const { container } = renderApp("/w/ws_1/inbox");
    await waitFor(() => expect(container.querySelector(".nav-count")?.textContent).toBe("1"));
  });

  it("returns to /login when any request reports the session expired", async () => {
    stubApi({ "GET /agent/me": () => ({ body: meWith() }), ...workspaceRoutes });
    renderApp("/w/ws_1/reports");
    await screen.findByRole("heading", { name: "Reports" });

    act(() => {
      onUnauthorized.dispatchEvent(new Event("unauthorized"));
    });

    expect(await screen.findByRole("heading", { name: "Sign in to Support" })).toBeTruthy();
    expect(location.pathname).toBe("/login");
  });
});

describe("App (bulletproof round 1)", () => {
  it("shows a retryable error instead of logging out when /agent/me fails with a 5xx", async () => {
    let fail = true;
    stubApi({
      "GET /agent/me": () => (fail ? { status: 503, body: { error: { code: "unavailable", message: "down" } } } : { body: meWith() }),
      ...workspaceRoutes,
    });
    renderApp("/w/ws_1/reports");
    expect(await screen.findByText("Can't reach the server")).toBeTruthy();
    expect(location.pathname).toBe("/w/ws_1/reports");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Can't reach the server")).toBeNull());
  });
});

describe("ErrorBoundary", () => {
  it("renders a recoverable screen instead of a blank page", async () => {
    const { ErrorBoundary } = await import("./components/ErrorBoundary");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("bad payload");
    };
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
  });
});
