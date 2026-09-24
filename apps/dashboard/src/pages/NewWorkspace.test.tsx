import type { AgentMe } from "@kobecuppens/livechat-protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { NewWorkspacePage } from "./NewWorkspace";

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (init: RequestInit) => Reply | Promise<Reply>;

function stubApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, init });
      const handler = routes[`${method} ${url}`];
      const r: Reply = handler ? await handler(init) : { status: 404, body: { error: { code: "not_found", message: `unrouted ${method} ${url}` } } };
      if (r instanceof Error) throw r;
      const status = r.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
    }),
  );
  return calls;
}

const me = (superAdmin: boolean): AgentMe => ({
  agent: { id: "ag_me", email: "alex@acme.test", name: "Alex Agent", avatarUrl: null },
  superAdmin,
  workspaces: [],
});

function renderPage(superAdmin = true) {
  history.replaceState(null, "", "/new-workspace");
  const onCreated = vi.fn();
  render(
    <Router>
      <NewWorkspacePage me={me(superAdmin)} onCreated={onCreated} />
    </Router>,
  );
  return { onCreated };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("NewWorkspacePage", () => {
  it("tells non-super-admins they can't create workspaces", () => {
    const calls = stubApi({});
    renderPage(false);
    expect(screen.getByText("Only super admins can create workspaces.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("creates the workspace, shows its keys once and continues to install settings", async () => {
    const calls = stubApi({
      "POST /agent/workspaces": () => ({ body: { id: "ws_new", publishableKey: "pk_live_123", identitySecret: "sk_secret_456" } }),
    });
    const { onCreated } = renderPage();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  1% Better  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("heading", { name: "Workspace created" })).toBeTruthy();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "1% Better" });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Publishable key") as HTMLInputElement).value).toBe("pk_live_123");
    expect((screen.getByLabelText("Identity secret (server only)") as HTMLInputElement).value).toBe("sk_secret_456");

    fireEvent.click(screen.getByRole("button", { name: "Continue to setup" }));
    expect(location.pathname).toBe("/w/ws_new/settings/install");
  });

  it("shows the API error message and stays on the form", async () => {
    stubApi({ "POST /agent/workspaces": () => ({ status: 409, body: { error: { code: "conflict", message: "Name already taken" } } }) });
    const { onCreated } = renderPage();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByText("Name already taken")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
  });

  it("shows a generic message when the request fails without an API error", async () => {
    stubApi({ "POST /agent/workspaces": () => new TypeError("network down") });
    renderPage();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByText("Couldn't create workspace")).toBeTruthy();
  });
});
