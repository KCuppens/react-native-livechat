import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { LoginPage, VerifyPage } from "./Login";

type Reply = { status?: number; body?: unknown } | Error;

/** Stubs global fetch; `reply` decides the response per request. */
function stubFetch(reply: (url: string, init: RequestInit) => Reply | Promise<Reply>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = await reply(url, init);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setUrl(url: string) {
  history.replaceState(null, "", url);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setUrl("/");
});

describe("LoginPage", () => {
  it("requests a magic link for the trimmed email and confirms it was sent", async () => {
    const fetchMock = stubFetch(() => ({ status: 204 }));
    setUrl("/login");
    const { container } = render(
      <Router>
        <LoginPage />
      </Router>,
    );
    const input = container.querySelector("input[type=email]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  sam@example.com " } });
    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByText(/a sign-in link is on its way/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init = {}] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/auth/magic-link");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "sam@example.com" });
    expect(container.querySelector("input")).toBeNull();
  });

  it("shows a sending state while the request is in flight", async () => {
    let resolve!: (r: Reply) => void;
    stubFetch(() => new Promise<Reply>((r) => (resolve = r)));
    const { container } = render(
      <Router>
        <LoginPage />
      </Router>,
    );
    fireEvent.change(container.querySelector("input")!, { target: { value: "sam@example.com" } });
    fireEvent.submit(container.querySelector("form")!);

    const button = await screen.findByRole("button", { name: "Sending…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve({ status: 204 });
    expect(await screen.findByText(/a sign-in link is on its way/)).toBeTruthy();
  });

  it("shows an error and keeps the form when the request fails", async () => {
    stubFetch(() => ({ status: 429, body: { error: { code: "rate_limited", message: "slow down" } } }));
    const { container } = render(
      <Router>
        <LoginPage />
      </Router>,
    );
    fireEvent.change(container.querySelector("input")!, { target: { value: "sam@example.com" } });
    fireEvent.submit(container.querySelector("form")!);

    expect(await screen.findByText("Couldn't send the link. Try again in a minute.")).toBeTruthy();
    expect(container.querySelector("input")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Email me a link" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("VerifyPage", () => {
  it("verifies the token from the hash, signs in and navigates home", async () => {
    const fetchMock = stubFetch(() => ({ body: { agent: { id: "ag_1" } } }));
    const replaceSpy = vi.spyOn(history, "replaceState");
    setUrl("/verify#token=abc%2B123");
    replaceSpy.mockClear();
    const onSignedIn = vi.fn();
    render(
      <Router>
        <VerifyPage onSignedIn={onSignedIn} />
      </Router>,
    );

    expect(screen.getByText("Signing you in…")).toBeTruthy();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    const [url, init = {}] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/agent/auth/verify");
    expect(JSON.parse(init.body as string)).toEqual({ token: "abc+123" });
    // First the token is stripped from the address bar, then the router replaces to "/".
    expect(replaceSpy.mock.calls.map((c) => c[2])).toEqual(["/verify", "/"]);
    expect(location.pathname).toBe("/");
    expect(location.hash).toBe("");
  });

  it("verifies only once under StrictMode", async () => {
    const fetchMock = stubFetch(() => ({ body: { agent: { id: "ag_1" } } }));
    setUrl("/verify#token=once");
    const onSignedIn = vi.fn();
    render(
      <StrictMode>
        <Router>
          <VerifyPage onSignedIn={onSignedIn} />
        </Router>
      </StrictMode>,
    );

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it("shows an incomplete-link error when there is no token", async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));
    setUrl("/verify#foo=bar");
    const onSignedIn = vi.fn();
    render(
      <Router>
        <VerifyPage onSignedIn={onSignedIn} />
      </Router>,
    );

    expect(await screen.findByText("This link is incomplete.")).toBeTruthy();
    expect(screen.getByText("Link expired")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/verify");
    expect(location.hash).toBe("");
  });

  it("shows the API error message when verification fails", async () => {
    stubFetch(() => ({ status: 400, body: { error: { code: "invalid_link", message: "This link was already used." } } }));
    setUrl("/verify#token=used");
    const onSignedIn = vi.fn();
    render(
      <Router>
        <VerifyPage onSignedIn={onSignedIn} />
      </Router>,
    );

    expect(await screen.findByText("This link was already used.")).toBeTruthy();
    expect(screen.getByText("Link expired")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Request a new link" })).toBeTruthy();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/verify");
    expect(location.hash).toBe("");
  });

  it("shows a generic message when verification fails without an ApiError", async () => {
    stubFetch(() => new TypeError("Failed to fetch"));
    setUrl("/verify#token=abc");
    render(
      <Router>
        <VerifyPage onSignedIn={vi.fn()} />
      </Router>,
    );

    expect(await screen.findByText("Sign-in failed.")).toBeTruthy();
  });
});
