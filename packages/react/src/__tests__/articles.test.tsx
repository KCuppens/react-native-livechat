import { LiveChatClient, createMemoryStorage } from "@kobecuppens/livechat-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LiveChatProvider, Messenger, useMessenger, type MessengerRoute } from "../index";

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

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

type Handler = (body: any, url: URL) => unknown;
const FAIL = Symbol("fail");

const refundArticle = { id: "art_1", categoryId: "cat_1", slug: "refunds", title: "Getting a refund", excerpt: "", locale: "en", bodyMd: "Go to **Billing**.", updatedAt: 1 };

function server(extra: Record<string, Handler> = {}) {
  const calls: string[] = [];
  const urls: URL[] = [];
  const routes: Record<string, Handler> = {
    "GET /v1/config": () => config,
    "POST /v1/session": () => ({ token: "tok", expiresAt: Date.now() + 1e9, contact }),
    "GET /v1/conversations/unread": () => ({ count: 0 }),
    "GET /v1/conversations": () => ({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => [],
    "GET /v1/faq/articles": (_b, url) =>
      url.searchParams.get("category") === "cat_1"
        ? [
            { id: "art_1", categoryId: "cat_1", slug: "refunds", title: "Getting a refund", excerpt: "How refunds work", locale: "en" },
            { id: "art_3", categoryId: "cat_1", slug: "invoices", title: "Invoices", excerpt: "", locale: "en" },
          ]
        : [],
    "GET /v1/faq/articles/refunds": () => refundArticle,
    "POST /v1/faq/articles/art_1/feedback": () => undefined,
    ...extra,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    urls.push(url);
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: key } }), { status: 404 });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const out = handler(body, url);
    if (out === FAIL) return new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), { status: 500 });
    return out === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls, urls };
}

function Go({ route }: { route: MessengerRoute }) {
  const messenger = useMessenger();
  return <button type="button" onClick={() => messenger.open(route)}>go</button>;
}

async function setup(route: MessengerRoute, s = server()) {
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage: createMemoryStorage(),
    locale: "en",
    fetch: s.fetch,
    WebSocket: NoopSocket as unknown as typeof WebSocket,
  });
  render(
    <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
      <Go route={route} />
      <Messenger inline />
    </LiveChatProvider>,
  );
  // Wait for the client to be ready (home screen rendered) before navigating.
  await screen.findByPlaceholderText("Search for help");
  fireEvent.click(screen.getByText("go"));
  return { client, ...s };
}

/** Fails the first `n` calls to a handler, then delegates. */
function failing(n: number, then: Handler): Handler & { count: () => number } {
  let calls = 0;
  const h = ((body: any, url: URL) => (++calls <= n ? FAIL : then(body, url))) as Handler & { count: () => number };
  h.count = () => calls;
  return h;
}

afterEach(cleanup);

describe("CategoryScreen", () => {
  it("lists the category's articles and opens one on click", async () => {
    const { urls } = await setup({ name: "category", id: "cat_1", title: "Billing" });
    expect(await screen.findByText("Billing", { selector: ".lc-header-title strong" })).toBeTruthy();
    expect(await screen.findByText("Getting a refund")).toBeTruthy();
    expect(screen.getByText("How refunds work")).toBeTruthy();
    expect(screen.getByText("Invoices")).toBeTruthy();
    const listCall = urls.find((u) => u.pathname === "/v1/faq/articles" && u.searchParams.get("category"));
    expect(listCall?.searchParams.get("category")).toBe("cat_1");
    expect(listCall?.searchParams.get("locale")).toBe("en");

    fireEvent.click(screen.getByText("Getting a refund"));
    expect(await screen.findByText("Billing", { selector: ".lc-article strong" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Getting a refund");
  });

  it("shows an error state and refetches on Retry", async () => {
    const list = failing(1, (_b, url) =>
      url.searchParams.get("category")
        ? [{ id: "art_1", categoryId: "cat_1", slug: "refunds", title: "Getting a refund", excerpt: "", locale: "en" }]
        : [],
    );
    // Home's popular list also hits this endpoint; only fail category requests.
    const s = server({
      "GET /v1/faq/articles": (b, url) => (url.searchParams.get("category") ? list(b, url) : []),
    });
    await setup({ name: "category", id: "cat_1", title: "Billing" }, s);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Getting a refund")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(list.count()).toBe(2);
  });

  it("renders an empty list when the category has no articles", async () => {
    await setup({ name: "category", id: "cat_empty", title: "Empty topic" });
    expect(await screen.findByText("Empty topic", { selector: ".lc-header-title strong" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(document.querySelectorAll(".lc-row")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ArticleScreen", () => {
  it("shows an error state and loads the article on Retry", async () => {
    const article = failing(1, () => refundArticle);
    await setup({ name: "article", slug: "refunds" }, server({ "GET /v1/faq/articles/refunds": article }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Billing", { selector: ".lc-article strong" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(article.count()).toBe(2);
  });

  it("sends negative feedback with 'No' and only once", async () => {
    let feedbackBody: unknown;
    let feedbackCalls = 0;
    await setup(
      { name: "article", slug: "refunds" },
      server({
        "POST /v1/faq/articles/art_1/feedback": (body) => {
          feedbackCalls++;
          feedbackBody = body;
          return undefined;
        },
      }),
    );
    expect(await screen.findByText("Was this article helpful?")).toBeTruthy();
    fireEvent.click(screen.getByText(/No/));
    expect(await screen.findByText("Thanks for your feedback!")).toBeTruthy();
    expect(screen.queryByText(/Yes/)).toBeNull();
    await waitFor(() => expect(feedbackBody).toEqual({ helpful: false }));
    expect(feedbackCalls).toBe(1);
  });

  it("still shows thanks when the feedback request fails", async () => {
    await setup({ name: "article", slug: "refunds" }, server({ "POST /v1/faq/articles/art_1/feedback": () => FAIL }));
    fireEvent.click(await screen.findByText(/Yes/));
    expect(await screen.findByText("Thanks for your feedback!")).toBeTruthy();
  });

  it("'Still need help?' → Send us a message opens a new conversation", async () => {
    await setup({ name: "article", slug: "refunds" });
    expect(await screen.findByText("Still need help?")).toBeTruthy();
    fireEvent.click(screen.getByText("Send us a message", { selector: ".lc-still button" }));
    expect(await screen.findByText("New conversation", { selector: ".lc-header-title strong" })).toBeTruthy();
    expect(await screen.findByLabelText("Write a message…")).toBeTruthy();
  });
});
