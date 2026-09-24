import { createMemoryStorage, LiveChatClient, type Conversation, type WorkspaceConfig } from "@kobecuppens/livechat-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BackHandler, StyleSheet } from "react-native";
import { LiveChat, LiveChatProvider, SupportScreen, type SupportScreenProps } from "../index";
import { Loading } from "../screens/shared";

// ------------------------------------------------------------ fakes

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

const baseConfig = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en", "fr"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: false,
  typicalReplyMinutes: null,
} as unknown as WorkspaceConfig;

function conversation(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
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

const article = (slug: string, title: string, extra: Record<string, unknown> = {}) => ({ id: `art_${slug}`, categoryId: null, slug, title, excerpt: "", locale: "en", ...extra });

type Reply = { status: number; body?: unknown };
type Route = (body: any, url: URL) => Reply | Promise<Reply>;
const ok = (body?: unknown): Reply => (body === undefined ? { status: 204 } : { status: 200, body });
const fail = (status = 500): Reply => ({ status, body: { error: { code: "server_error", message: "boom" } } });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(opts: { config?: Partial<WorkspaceConfig>; routes?: Record<string, Route>; locale?: string } = {}) {
  const calls: { key: string; url: URL; body?: any }[] = [];
  const routes: Record<string, Route> = {
    "GET /v1/config": () => ok({ ...baseConfig, ...opts.config }),
    "POST /v1/session": () => ok({ token: "tok", expiresAt: Date.now() + 1e9, contact: { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false } }),
    "GET /v1/conversations/unread": () => ok({ count: 0 }),
    "GET /v1/conversations": () => ok({ items: [], nextCursor: null }),
    "GET /v1/faq/categories": () => ok([]),
    "GET /v1/faq/articles": () => ok([]),
    ...opts.routes,
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, body });
    const out = (await routes[key]?.(body, url)) ?? { status: 404, body: { error: { code: "not_found", message: key } } };
    return new Response(out.status === 204 ? null : JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;
  const client = new LiveChatClient({
    apiUrl: "https://api.test",
    workspaceKey: "pk",
    storage: createMemoryStorage(),
    locale: opts.locale ?? "en",
    fetch: fetchImpl,
    WebSocket: NoopSocket as unknown as typeof WebSocket,
  });
  active.push(client);
  return { client, calls };
}

let active: LiveChatClient[] = [];
afterEach(() => {
  for (const c of active) c.destroy();
  active = [];
  jest.restoreAllMocks();
});

async function mount(client: LiveChatClient, props: SupportScreenProps = {}) {
  await render(
    <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
      <SupportScreen {...props} />
    </LiveChatProvider>,
  );
}

async function mountReady(client: LiveChatClient, props: SupportScreenProps = {}) {
  await mount(client, props);
  await waitFor(() => expect(client.state.status).toBe("ready"));
}

const go = (route: Parameters<typeof LiveChat.open>[0]) => act(async () => LiveChat.open(route));
const style = (el: { props: Record<string, any> }) => StyleSheet.flatten(el.props.style) ?? {};
const views = () => screen.container.queryAll((n) => n.type === "View");
// <Loading/> sets accessibilityRole="progressbar" without `accessible`, so getByRole can't see it.
const spinners = () => screen.container.queryAll((n) => n.props.accessibilityRole === "progressbar");

const START_CHAT = "Send us a message";
const OFFLINE = "We're away right now. Leave a message and we'll get back to you.";

// ------------------------------------------------------------ SupportScreen

describe("SupportScreen", () => {
  it("shows an error state when init fails and retries init on Retry", async () => {
    let configCalls = 0;
    const { client, calls } = setup({
      routes: {
        "GET /v1/config": () => (++configCalls === 1 ? fail() : ok(baseConfig)),
      },
    });
    await mount(client);
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(client.state.status).toBe("error");
    expect(screen.queryByText(START_CHAT)).toBeNull();

    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText(START_CHAT)).toBeTruthy();
    expect(client.state.status).toBe("ready");
    expect(calls.filter((c) => c.key === "GET /v1/config")).toHaveLength(2);
  });

  it("shows a loading indicator until the client is ready", async () => {
    const gate = deferred();
    const { client } = setup({
      routes: {
        "GET /v1/config": async () => {
          await gate.promise;
          return ok(baseConfig);
        },
      },
    });
    await mount(client);
    expect(spinners()).not.toHaveLength(0);
    expect(screen.queryByText(START_CHAT)).toBeNull();

    await act(async () => gate.resolve());
    expect(await screen.findByText(START_CHAT)).toBeTruthy();
  });

  it("renders the home screen for the search route", async () => {
    const { client } = setup();
    await mountReady(client);
    await go({ name: "search", query: "reset" });
    expect(await screen.findByText(START_CHAT)).toBeTruthy();
    expect(screen.getByText(OFFLINE)).toBeTruthy();
  });

  it("renders the category route with a back button to home", async () => {
    const { client, calls } = setup({
      routes: {
        "GET /v1/faq/articles": (_b, url) => ok(url.searchParams.get("category") === "cat_1" ? [article("invoices", "Where are my invoices?", { excerpt: "Billing page" })] : []),
      },
    });
    await mountReady(client);
    await go({ name: "category", id: "cat_1", title: "Billing" });
    expect(await screen.findByText("Where are my invoices?")).toBeTruthy();
    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.getByText("Billing page")).toBeTruthy();
    expect(calls.some((c) => c.key === "GET /v1/faq/articles" && c.url.searchParams.get("category") === "cat_1")).toBe(true);

    await fireEvent.press(screen.getByLabelText("Back"));
    expect(await screen.findByText(START_CHAT)).toBeTruthy();
  });

  it("renders the conversations route and opens a conversation from it", async () => {
    const { client } = setup({
      routes: {
        "GET /v1/conversations": () => ok({ items: [conversation({ id: "cv_1", assignee: { id: "ag_2", name: "Robin Park", avatarUrl: null } })], nextCursor: null }),
        "GET /v1/conversations/cv_1": () => ok(conversation({ id: "cv_1", assignee: { id: "ag_2", name: "Robin Park", avatarUrl: null } })),
        "GET /v1/conversations/cv_1/messages": () => ok({ items: [], nextCursor: null }),
        "POST /v1/conversations/cv_1/read": () => ok(),
      },
    });
    await mountReady(client);
    await go({ name: "conversations" });
    expect(await screen.findByText("Your conversations")).toBeTruthy();
    const row = await screen.findByText("Robin Park");
    await fireEvent.press(row);
    expect(await screen.findByPlaceholderText("Write a message…")).toBeTruthy();
    expect(screen.queryByText("Your conversations")).toBeNull();
  });

  it("shows a close button that calls onClose", async () => {
    const onClose = jest.fn();
    const { client } = setup();
    await mountReady(client, { onClose });
    await fireEvent.press(await screen.findByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the close button without onClose", async () => {
    const { client } = setup();
    await mountReady(client);
    await screen.findByText(START_CHAT);
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("walks back through the stack on Android hardware back and returns false at the root", async () => {
    const handlers: ((e: any) => boolean | null | undefined)[] = [];
    const removed = jest.fn();
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: removed };
    });
    const { client } = setup({ routes: { "GET /v1/faq/articles": () => ok([article("reset", "Reset password")]) } });
    await mountReady(client);
    await screen.findByText(START_CHAT);
    const latest = () => handlers[handlers.length - 1]!;

    let handled: boolean | null | undefined;
    await act(async () => {
      handled = latest()({});
    });
    expect(handled).toBe(false);

    await go({ name: "category", id: "cat_1", title: "Billing" });
    expect(await screen.findByText("Billing")).toBeTruthy();
    await act(async () => {
      handled = latest()({});
    });
    expect(handled).toBe(true);
    expect(await screen.findByText(START_CHAT)).toBeTruthy();
    expect(screen.queryByText("Billing")).toBeNull();
    // Re-subscribing on messenger changes removes the stale listener.
    expect(removed).toHaveBeenCalled();
  });

  it("applies theme overrides (dark scheme + custom primary) and safe-area insets", async () => {
    const { client } = setup();
    await mountReady(client, { theme: { scheme: "dark", primary: "#00aa55" }, insets: { top: 44, bottom: 34 } });
    await screen.findByText(START_CHAT);
    const all = views().map(style);
    // Dark background on the root, dark surface on the home scroll area.
    expect(all.some((s) => s.backgroundColor === "#15171c" && s.flex === 1)).toBe(true);
    // Primary override colors the home hero.
    expect(all.some((s) => s.backgroundColor === "#00aa55")).toBe(true);
    expect(all.some((s) => s.backgroundColor === "#4F46E5")).toBe(false);
    // Insets become padding.
    expect(all.some((s) => s.paddingTop === 44 && s.paddingBottom === 34)).toBe(true);
    // Dark text color on the start-chat title.
    expect(style(screen.getByText(START_CHAT)).color).toBe("#f3f4f6");
  });

  it("uses no inset padding and the light palette by default", async () => {
    const { client } = setup();
    await mountReady(client);
    await screen.findByText(START_CHAT);
    const all = views().map(style);
    expect(all.some((s) => s.backgroundColor === "#ffffff" && s.flex === 1)).toBe(true);
    expect(all.some((s) => s.paddingTop === 0 && s.paddingBottom === 0 && s.flex === 1)).toBe(true);
    expect(all.some((s) => s.backgroundColor === "#4F46E5")).toBe(true);
  });
});

// ------------------------------------------------------------ Articles

describe("CategoryScreen", () => {
  it("lists category articles and navigates to an article", async () => {
    const { client } = setup({
      routes: {
        "GET /v1/faq/articles": (_b, url) =>
          ok(url.searchParams.get("category") === "cat_1" ? [article("reset", "Reset password"), article("2fa", "Two-factor login")] : []),
        "GET /v1/faq/articles/reset": () => ok({ ...article("reset", "Reset password"), bodyMd: "Tap **Forgot password**.", updatedAt: 1 }),
      },
    });
    await mountReady(client);
    await go({ name: "category", id: "cat_1", title: "Account" });
    expect(await screen.findByText("Two-factor login")).toBeTruthy();
    await fireEvent.press(screen.getByText("Reset password"));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
    expect(screen.getByText("Was this article helpful?")).toBeTruthy();
  });

  it("shows an error state and reloads on Retry", async () => {
    let n = 0;
    const { client } = setup({
      routes: {
        "GET /v1/faq/articles": (_b, url) => (url.searchParams.get("category") ? (++n === 1 ? fail() : ok([article("reset", "Reset password")])) : ok([])),
      },
    });
    await mountReady(client);
    await go({ name: "category", id: "cat_1", title: "Account" });
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("Reset password")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(n).toBe(2);
  });
});

describe("ArticleScreen", () => {
  const body = { ...article("reset", "Reset password"), bodyMd: "Tap **Forgot password**.", updatedAt: 1 };

  it("shows an error state and reloads the article on Retry", async () => {
    let n = 0;
    const { client } = setup({ routes: { "GET /v1/faq/articles/reset": () => (++n === 1 ? fail(404) : ok(body)) } });
    await mountReady(client);
    await go({ name: "article", slug: "reset" });
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    await fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
    // Title shows in the header and as the page heading.
    expect(screen.getAllByText("Reset password")).toHaveLength(2);
    expect(n).toBe(2);
  });

  it("sends negative feedback and thanks the user", async () => {
    const { client, calls } = setup({
      routes: {
        "GET /v1/faq/articles/reset": () => ok(body),
        "POST /v1/faq/articles/art_reset/feedback": () => ok(),
      },
    });
    await mountReady(client);
    await go({ name: "article", slug: "reset" });
    await fireEvent.press(await screen.findByText("👎 No"));
    expect(await screen.findByText("Thanks for your feedback!")).toBeTruthy();
    expect(screen.queryByText("👍 Yes")).toBeNull();
    await waitFor(() => expect(calls.find((c) => c.key === "POST /v1/faq/articles/art_reset/feedback")?.body).toEqual({ helpful: false }));
  });

  it("navigates to a new conversation from 'Send us a message'", async () => {
    const { client } = setup({ routes: { "GET /v1/faq/articles/reset": () => ok(body) } });
    await mountReady(client);
    await go({ name: "article", slug: "reset" });
    expect(await screen.findByText("Still need help?")).toBeTruthy();
    await fireEvent.press(screen.getByText(START_CHAT));
    expect(await screen.findByPlaceholderText("Write a message…")).toBeTruthy();
    expect(screen.queryByText("Was this article helpful?")).toBeNull();
  });
});

// ------------------------------------------------------------ Home

describe("HomeScreen", () => {
  it("shows the logo image instead of the name when branding.logoUrl is set", async () => {
    const { client } = setup({ config: { branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: "https://cdn.test/logo.png", greeting: {} } } as Partial<WorkspaceConfig> });
    await mountReady(client);
    await screen.findByText(START_CHAT);
    const logo = screen.getByLabelText("Acme");
    expect(logo.type).toBe("Image");
    expect(logo.props.source).toEqual({ uri: "https://cdn.test/logo.png" });
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("shows the workspace name and default greeting without a logo or custom greeting", async () => {
    const { client } = setup();
    await mountReady(client);
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("Hi there 👋 How can we help?")).toBeTruthy();
  });

  it("uses the branding greeting for the negotiated locale", async () => {
    const branding = { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: { en: "Welcome to Acme!", fr: "Bienvenue chez Acme !" } };
    const { client } = setup({ locale: "fr-FR", config: { branding } as Partial<WorkspaceConfig> });
    await mountReady(client);
    expect(await screen.findByText("Bienvenue chez Acme !")).toBeTruthy();
    expect(screen.queryByText("Welcome to Acme!")).toBeNull();
  });

  it("searches as you type, shows results and opens a result", async () => {
    const { client, calls } = setup({
      routes: {
        "GET /v1/faq/articles": (_b, url) => ok(url.searchParams.get("q") === "reset" ? [article("reset", "Reset password", { excerpt: "Forgot your password?" })] : []),
        "GET /v1/faq/articles/reset": () => ok({ ...article("reset", "Reset password"), bodyMd: "Tap **Forgot password**.", updatedAt: 1 }),
      },
    });
    await mountReady(client);
    await screen.findByText(START_CHAT);
    await fireEvent.changeText(screen.getByLabelText("Search for help"), "reset");
    expect(await screen.findByText("Forgot your password?")).toBeTruthy();
    // The home cards are hidden while searching.
    expect(screen.queryByText(START_CHAT)).toBeNull();
    expect(calls.find((c) => c.url.searchParams.get("q") === "reset")?.url.searchParams.get("mode")).toBe("all");

    await fireEvent.press(screen.getByText("Reset password"));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
  });

  it("does not search for a single character", async () => {
    const { client, calls } = setup();
    await mountReady(client);
    await screen.findByText(START_CHAT);
    await fireEvent.changeText(screen.getByLabelText("Search for help"), "r");
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 300));
    });
    expect(screen.getByText(START_CHAT)).toBeTruthy();
    expect(calls.some((c) => c.url.searchParams.has("q"))).toBe(false);
  });

  it("shows a loading indicator while a search is pending, then the no-results text", async () => {
    const gate = deferred();
    const { client } = setup({
      routes: {
        "GET /v1/faq/articles": async (_b, url) => {
          if (url.searchParams.get("q")) await gate.promise;
          return ok([]);
        },
      },
    });
    await mountReady(client);
    await screen.findByText(START_CHAT);
    await waitFor(() => expect(spinners()).toHaveLength(0));
    await fireEvent.changeText(screen.getByLabelText("Search for help"), "  zzz  ");
    expect(spinners()).not.toHaveLength(0);
    await act(async () => gate.resolve());
    expect(await screen.findByText("No articles found for “zzz”")).toBeTruthy();
    expect(spinners()).toHaveLength(0);
  });

  it("shows the typical reply time when online", async () => {
    const { client } = setup({ config: { online: true, typicalReplyMinutes: 5 } });
    await mountReady(client);
    expect(await screen.findByText("Typically replies in 5 min")).toBeTruthy();
  });

  it("shows a plain online status without a typical reply time", async () => {
    const { client } = setup({ config: { online: true, typicalReplyMinutes: null } });
    await mountReady(client);
    expect(await screen.findByText("We're online")).toBeTruthy();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  it("starts a new conversation from the start-chat card", async () => {
    const { client } = setup();
    await mountReady(client);
    await fireEvent.press(await screen.findByText(START_CHAT));
    expect(await screen.findByPlaceholderText("Write a message…")).toBeTruthy();
  });

  it("lists up to three recent conversations with unread dots and links to the full list", async () => {
    const items = [
      conversation({ id: "cv_a", assignee: { id: "ag_a", name: "Alice Adams", avatarUrl: null }, unreadCount: 2, lastMessage: { body: "See you soon" } as Conversation["lastMessage"] }),
      conversation({ id: "cv_b", assignee: { id: "ag_b", name: "Bob Brown", avatarUrl: null } }),
      conversation({ id: "cv_c", assignee: null }),
      conversation({ id: "cv_d", assignee: { id: "ag_d", name: "Dana Diaz", avatarUrl: null } }),
    ];
    const { client } = setup({ routes: { "GET /v1/conversations": () => ok({ items, nextCursor: null }) } });
    await mountReady(client);
    expect(await screen.findByText("Alice Adams")).toBeTruthy();
    expect(screen.getByText("See you soon")).toBeTruthy();
    expect(screen.getByText("Bob Brown")).toBeTruthy();
    // Unassigned conversation falls back to the workspace name ("Acme" also shows in the hero).
    expect(screen.getAllByText("Acme")).toHaveLength(2);
    expect(screen.queryByText("Dana Diaz")).toBeNull();
    expect(screen.getAllByLabelText("Unread")).toHaveLength(1);
    // Section title + "see all" row.
    const links = screen.getAllByText("Your conversations");
    expect(links).toHaveLength(2);

    await fireEvent.press(links[1]!);
    expect(await screen.findByText("Dana Diaz")).toBeTruthy();
    expect(screen.getByLabelText("Back")).toBeTruthy();
  });

  it("omits the 'see all' row with three or fewer conversations", async () => {
    const items = [conversation({ id: "cv_a", assignee: { id: "ag_a", name: "Alice Adams", avatarUrl: null } })];
    const { client } = setup({ routes: { "GET /v1/conversations": () => ok({ items, nextCursor: null }) } });
    await mountReady(client);
    expect(await screen.findByText("Alice Adams")).toBeTruthy();
    expect(screen.getAllByText("Your conversations")).toHaveLength(1);
    expect(screen.queryByLabelText("Unread")).toBeNull();
  });

  it("shows popular articles and categories that navigate to their screens", async () => {
    const { client, calls } = setup({
      routes: {
        "GET /v1/faq/categories": () =>
          ok([
            { id: "cat_1", slug: "billing", title: "Billing", description: null, icon: null, articleCount: 3 },
            { id: "cat_2", slug: "account", title: "Account", description: "Login and security", icon: null, articleCount: 1 },
          ]),
        "GET /v1/faq/articles": (_b, url) =>
          ok(url.searchParams.get("sort") === "popular" ? [article("reset", "Reset password")] : url.searchParams.get("category") === "cat_1" ? [article("refund", "Get a refund")] : []),
        "GET /v1/faq/articles/reset": () => ok({ ...article("reset", "Reset password"), bodyMd: "Tap **Forgot password**.", updatedAt: 1 }),
      },
    });
    await mountReady(client);
    expect(await screen.findByText("Popular articles")).toBeTruthy();
    expect(screen.getByText("Browse topics")).toBeTruthy();
    expect(screen.getByText("3 articles")).toBeTruthy();
    expect(screen.getByText("Login and security")).toBeTruthy();
    expect(calls.find((c) => c.url.searchParams.get("sort") === "popular")?.url.searchParams.get("limit")).toBe("5");

    await fireEvent.press(screen.getByText("Reset password"));
    expect(await screen.findByText("Forgot password")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Back"));

    await fireEvent.press(await screen.findByText("Billing"));
    expect(await screen.findByText("Get a refund")).toBeTruthy();
  });

  it("hides the popular and categories sections when the help center is empty", async () => {
    const { client } = setup();
    await mountReady(client);
    await screen.findByText(START_CHAT);
    await waitFor(() => expect(spinners()).toHaveLength(0));
    expect(screen.queryByText("Popular articles")).toBeNull();
    expect(screen.queryByText("Browse topics")).toBeNull();
  });
});

describe("loading spinner accessibility (regression)", () => {
  it("is exposed to screen readers as a labelled progressbar", async () => {
    const { client } = setup();
    await render(
      <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
        <Loading />
      </LiveChatProvider>,
    );
    expect(screen.getByRole("progressbar", { name: "Loading…" })).toBeTruthy();
  });
});
