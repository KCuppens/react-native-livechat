import type { AgentFaqArticle, AgentFaqCategory, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui";
import { match, Router, useRouter } from "../router";
import { FaqPage } from "./Faq";

// ---------------------------------------------------------------- fakes

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (init: RequestInit) => Reply | Promise<Reply>;

interface Call {
  method: string;
  url: string;
  init: RequestInit;
}

/** Fake backend keyed by "METHOD /path"; anything unrouted answers 404. */
function stubApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
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
  const find = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);
  const bodies = (method: string, url: string) => find(method, url).map((c) => JSON.parse(c.init.body as string));
  return { calls, find, bodies };
}

// ---------------------------------------------------------------- fixtures

const W = "/agent/w/ws_1";

const settings: WorkspaceSettings = {
  id: "ws_1",
  name: "Acme",
  primaryColor: "#112233",
  logoUrl: null,
  greeting: {},
  defaultLocale: "en",
  locales: ["en", "nl"],
  officeHours: { enabled: false, timezone: "Europe/Brussels", windows: [] },
  autoReply: {},
  typicalReplyMinutes: null,
  allowedOrigins: [],
  csatEnabled: true,
  publishableKey: "pk_1",
  push: { fcmUpdatedAt: null, apnsUpdatedAt: null },
};

function category(id: string, titles: Record<string, string>, over: Partial<AgentFaqCategory> = {}): AgentFaqCategory {
  return { id, slug: `slug-${id}`, icon: null, position: 0, titles, descriptions: {}, ...over };
}

function tr(title: string, published: boolean, over: Partial<{ slug: string; bodyMd: string }> = {}) {
  return { title, slug: title.toLowerCase().replace(/\s+/g, "-"), bodyMd: `Body of ${title}`, published, updatedAt: 1, ...over };
}

function article(id: string, over: Partial<AgentFaqArticle> = {}): AgentFaqArticle {
  return {
    id,
    categoryId: null,
    position: 0,
    helpfulCount: 0,
    unhelpfulCount: 0,
    viewCount: 0,
    createdAt: 1,
    translations: { en: tr(`Article ${id}`, true) },
    ...over,
  };
}

/** Mutable server state so reloads after a mutation return fresh data. */
interface Db {
  articles: AgentFaqArticle[];
  categories: AgentFaqCategory[];
}

const routes = (db: Db, over: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`GET ${W}/faq/articles`]: () => ({ body: db.articles }),
  [`GET ${W}/faq/categories`]: () => ({ body: db.categories }),
  [`GET ${W}/settings`]: () => ({ body: settings }),
  ...over,
});

function Harness() {
  const { path } = useRouter();
  const m = match("/w/:ws/faq/:id?", path);
  return (
    <>
      <FaqPage workspaceId="ws_1" articleId={m?.id ?? null} />
      <Toaster />
    </>
  );
}

function renderFaq(url = "/w/ws_1/faq") {
  history.replaceState(null, "", url);
  return render(
    <Router>
      <Harness />
    </Router>,
  );
}

let confirmMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

// ---------------------------------------------------------------- list

describe("FaqPage list", () => {
  it("loads articles, categories and settings and groups articles by category", async () => {
    const db: Db = {
      categories: [category("cat_1", { en: "Billing", nl: "Facturatie" }), category("cat_2", { nl: "Leeg" }, { slug: "empty-cat" })],
      articles: [
        article("a1", { categoryId: "cat_1", translations: { en: tr("Pay invoices", true), nl: tr("Facturen betalen", false) }, viewCount: 12, helpfulCount: 3, unhelpfulCount: 1 }),
        article("a2", { translations: { nl: tr("Alleen Nederlands", false) }, viewCount: 0 }),
      ],
    };
    const api = stubApi(routes(db));
    renderFaq();

    expect(await screen.findByRole("heading", { name: "Help center" })).toBeTruthy();
    expect(api.calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([`GET ${W}/faq/articles`, `GET ${W}/faq/categories`, `GET ${W}/settings`]);

    // Only categories with articles get a group; the default-locale title is used, uncategorized comes last.
    const groupHeadings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(groupHeadings).toEqual(["Categories", "Billing", "Uncategorized"]);

    const billing = screen.getByRole("heading", { name: "Billing" }).closest(".card") as HTMLElement;
    const row1 = within(billing).getByText("Pay invoices").closest("tr")!;
    expect(within(row1).getByText("en").getAttribute("title")).toBe("Published");
    expect(within(row1).getByText("en").className).toBe("badge badge-open");
    expect(within(row1).getByText("nl").getAttribute("title")).toBe("Draft");
    expect(within(row1).getByText("nl").className).toBe("badge");
    expect(within(row1).getByText("12")).toBeTruthy();
    expect(within(row1).getByText("75% of 4")).toBeTruthy();

    // Falls back to another translation's title when the default locale is missing.
    const uncategorized = screen.getByRole("heading", { name: "Uncategorized" }).closest(".card") as HTMLElement;
    const row2 = within(uncategorized).getByText("Alleen Nederlands").closest("tr")!;
    expect(within(row2).getByText("en").getAttribute("title")).toBe("Missing");
    expect((within(row2).getByText("en") as HTMLElement).style.opacity).toBe("0.4");
    expect(within(row2).getByText("—")).toBeTruthy();

    // Category rows expose per-locale title inputs.
    expect(screen.getAllByLabelText("Title (en)").map((i) => (i as HTMLInputElement).value)).toEqual(["Billing", ""]);
    expect(screen.getAllByLabelText("Title (nl)").map((i) => (i as HTMLInputElement).value)).toEqual(["Facturatie", "Leeg"]);
  });

  it("shows the empty state when there are no articles", async () => {
    stubApi(routes({ articles: [], categories: [] }));
    renderFaq();
    expect(await screen.findByText("No articles yet. Start with your most common question.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Uncategorized" })).toBeNull();
  });

  it("adds a category in the default locale and reloads", async () => {
    const db: Db = { articles: [], categories: [category("cat_1", { en: "Billing" })] };
    const api = stubApi(
      routes(db, {
        [`POST ${W}/faq/categories`]: (init) => {
          const b = JSON.parse(init.body as string);
          const c = category("cat_2", b.titles, { position: b.position });
          db.categories = [...db.categories, c];
          return { body: c };
        },
      }),
    );
    renderFaq();
    const input = (await screen.findByPlaceholderText("New category title (en)")) as HTMLInputElement;

    // Blank titles are ignored.
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));
    expect(api.find("POST", `${W}/faq/categories`)).toHaveLength(0);

    fireEvent.change(input, { target: { value: "  Shipping " } });
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));

    await waitFor(() => expect(screen.getAllByLabelText("Title (en)")).toHaveLength(2));
    expect(api.bodies("POST", `${W}/faq/categories`)).toEqual([{ titles: { en: "Shipping" }, position: 1 }]);
    expect(input.value).toBe("");
    expect(api.find("GET", `${W}/faq/categories`)).toHaveLength(2);
  });

  it("toasts when adding a category fails", async () => {
    stubApi(
      routes(
        { articles: [], categories: [] },
        { [`POST ${W}/faq/categories`]: () => ({ status: 409, body: { error: { code: "conflict", message: "Slug already used" } } }) },
      ),
    );
    renderFaq();
    fireEvent.change(await screen.findByPlaceholderText("New category title (en)"), { target: { value: "Billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByText("Slug already used")).toBeTruthy();
  });

  it("saves edited category titles without empty locales", async () => {
    const db: Db = { articles: [], categories: [category("cat_1", { en: "Billing", nl: "Facturatie" })] };
    const api = stubApi(
      routes(db, {
        [`PATCH ${W}/faq/categories/cat_1`]: (init) => {
          const b = JSON.parse(init.body as string);
          db.categories = [category("cat_1", b.titles)];
          return { body: db.categories[0] };
        },
      }),
    );
    renderFaq();
    const en = (await screen.findByLabelText("Title (en)")) as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(en, { target: { value: "Payments" } });
    fireEvent.change(screen.getByLabelText("Title (nl)"), { target: { value: "  " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(await screen.findByText("Category saved")).toBeTruthy();
    expect(api.bodies("PATCH", `${W}/faq/categories/cat_1`)).toEqual([{ titles: { en: "Payments" } }]);
    await waitFor(() => expect(api.find("GET", `${W}/faq/categories`)).toHaveLength(2));
  });

  it("deletes a category after confirmation only", async () => {
    const db: Db = { articles: [], categories: [category("cat_1", { en: "Billing" })] };
    const api = stubApi(
      routes(db, {
        [`DELETE ${W}/faq/categories/cat_1`]: () => {
          db.categories = [];
          return { status: 204 };
        },
      }),
    );
    renderFaq();
    await screen.findByLabelText("Title (en)");

    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmMock).toHaveBeenCalledWith("Delete this category? Its articles become uncategorized.");
    expect(api.find("DELETE", `${W}/faq/categories/cat_1`)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByLabelText("Title (en)")).toBeNull());
    expect(api.find("DELETE", `${W}/faq/categories/cat_1`)).toHaveLength(1);
  });

  it("navigates to the new article editor and to an article on row click", async () => {
    stubApi(routes({ articles: [article("a1")], categories: [] }));
    renderFaq();
    await screen.findByText("Article a1");

    fireEvent.click(screen.getByText("Article a1"));
    expect(location.pathname).toBe("/w/ws_1/faq/a1");
    expect(await screen.findByRole("heading", { name: "Article a1", level: 1 })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(location.pathname).toBe("/w/ws_1/faq");
    fireEvent.click(await screen.findByRole("button", { name: "New article" }));
    expect(location.pathname).toBe("/w/ws_1/faq/new");
    expect(await screen.findByRole("heading", { name: "New article", level: 1 })).toBeTruthy();
  });
});

// ---------------------------------------------------------------- editor

const titleInput = () => screen.getByLabelText("Title") as HTMLInputElement;
const slugInput = () => screen.getByLabelText(/^URL slug/) as HTMLInputElement;
const bodyInput = () => screen.getByLabelText(/^Body \(Markdown\)/) as HTMLTextAreaElement;
const publish = () => screen.getByRole("checkbox") as HTMLInputElement;
const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent);
const preview = (container: HTMLElement) => container.querySelector(".preview") as HTMLElement;

describe("FaqPage article editor", () => {
  it("shows 'Article not found' for an unknown article id", async () => {
    stubApi(routes({ articles: [article("a1")], categories: [] }));
    renderFaq("/w/ws_1/faq/nope");
    expect(await screen.findByText(/Article not found/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the help center" }).getAttribute("href")).toBe("/w/ws_1/faq");
  });

  it("edits a new article with a live preview and POSTs it, then replaces the URL with the new id", async () => {
    const db: Db = { articles: [], categories: [category("cat_1", { en: "Billing" })] };
    const api = stubApi(
      routes(db, {
        [`POST ${W}/faq/articles`]: (init) => {
          const b = JSON.parse(init.body as string);
          const created = article("a_new", {
            categoryId: b.categoryId,
            translations: Object.fromEntries(Object.entries(b.translations).map(([l, t]) => [l, { ...(t as object), slug: "how-to-pay", updatedAt: 1 }])) as AgentFaqArticle["translations"],
          });
          db.articles = [created];
          return { body: created };
        },
      }),
    );
    const { container } = renderFaq("/w/ws_1/faq/new");
    await screen.findByRole("heading", { name: "New article", level: 1 });

    expect(tabNames()).toEqual(["EN", "NL"]);
    expect(screen.getByRole("tab", { name: "EN" }).getAttribute("aria-selected")).toBe("true");
    expect(publish().disabled).toBe(true);
    expect(preview(container).querySelector("h2")!.textContent).toBe("Untitled");

    fireEvent.change(titleInput(), { target: { value: "  How to pay  " } });
    fireEvent.change(slugInput(), { target: { value: "How-To-Pay" } });
    fireEvent.change(bodyInput(), { target: { value: "Use **cards** or *cash*." } });

    expect(slugInput().value).toBe("how-to-pay");
    expect(tabNames()).toEqual(["EN ○ (Draft)", "NL"]);
    expect(preview(container).querySelector("h2")!.textContent).toBe("  How to pay  ");
    expect(preview(container).querySelector(".lc-md strong")!.textContent).toBe("cards");
    expect(preview(container).querySelector(".lc-md em")!.textContent).toBe("cash");

    expect(publish().disabled).toBe(false);
    fireEvent.click(publish());
    expect(tabNames()).toEqual(["EN ● (Published)", "NL"]);

    // A locale with a body but no title blocks the save and is pointed out (not silently dropped).
    fireEvent.click(screen.getByRole("tab", { name: "NL" }));
    expect(titleInput().value).toBe("");
    fireEvent.change(bodyInput(), { target: { value: "alleen tekst" } });
    expect(screen.getByText("Published in NL")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "cat_1" } });
    const replace = vi.spyOn(history, "replaceState");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Add a title for NL");
    expect(api.find("POST", `${W}/faq/articles`)).toHaveLength(0);

    // Clearing that body leaves NL out, and the save goes through.
    fireEvent.change(bodyInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("POST", `${W}/faq/articles`)).toEqual([
      { categoryId: "cat_1", translations: { en: { title: "How to pay", slug: "how-to-pay", bodyMd: "Use **cards** or *cash*.", published: true } } },
    ]);
    await waitFor(() => expect(location.pathname).toBe("/w/ws_1/faq/a_new"));
    expect(replace).toHaveBeenCalledWith(null, "", "/w/ws_1/faq/a_new");
    expect(await screen.findByRole("heading", { name: "How to pay", level: 1 })).toBeTruthy();
  });

  it("omits an empty slug so the server generates one", async () => {
    const api = stubApi(routes({ articles: [], categories: [] }, { [`POST ${W}/faq/articles`]: () => ({ body: article("a_new") }) }));
    renderFaq("/w/ws_1/faq/new");
    await screen.findByRole("heading", { name: "New article", level: 1 });

    fireEvent.change(titleInput(), { target: { value: "Refunds" } });
    fireEvent.change(slugInput(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.find("POST", `${W}/faq/articles`)).toHaveLength(1));
    expect(api.bodies("POST", `${W}/faq/articles`)[0]).toEqual({ categoryId: null, translations: { en: { title: "Refunds", bodyMd: "", published: false } } });
  });

  it("asks for a title before saving a new article without one", async () => {
    const api = stubApi(routes({ articles: [], categories: [] }));
    renderFaq("/w/ws_1/faq/new");
    await screen.findByRole("heading", { name: "New article", level: 1 });

    fireEvent.change(bodyInput(), { target: { value: "Just a body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Content without a title is pointed out inline instead of being dropped.
    expect((await screen.findByRole("alert")).textContent).toContain("Add a title for EN");
    expect(api.find("POST", `${W}/faq/articles`)).toHaveLength(0);
    expect(location.pathname).toBe("/w/ws_1/faq/new");
  });

  it("toasts the API error when saving fails", async () => {
    stubApi(
      routes(
        { articles: [], categories: [] },
        { [`POST ${W}/faq/articles`]: () => ({ status: 409, body: { error: { code: "slug_taken", message: "Slug already in use" } } }) },
      ),
    );
    renderFaq("/w/ws_1/faq/new");
    await screen.findByRole("heading", { name: "New article", level: 1 });

    fireEvent.change(titleInput(), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Slug already in use")).toBeTruthy();
    expect(location.pathname).toBe("/w/ws_1/faq/new");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads an existing article and PATCHes the category and edited translations", async () => {
    const db: Db = {
      categories: [category("cat_1", { en: "Billing" })],
      articles: [article("a1", { categoryId: "cat_1", translations: { en: tr("Pay invoices", true), nl: tr("Facturen betalen", false) } })],
    };
    const api = stubApi(routes(db, { [`PATCH ${W}/faq/articles/a1`]: () => ({ body: db.articles[0] }) }));
    const { container } = renderFaq("/w/ws_1/faq/a1");
    await screen.findByRole("heading", { name: "Pay invoices", level: 1 });

    expect(tabNames()).toEqual(["EN ● (Published)", "NL ○ (Draft)"]);
    expect(titleInput().value).toBe("Pay invoices");
    expect(slugInput().value).toBe("pay-invoices");
    expect(publish().checked).toBe(true);
    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("cat_1");
    expect(preview(container).querySelector(".lc-md")!.textContent).toBe("Body of Pay invoices");

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "" } });
    fireEvent.change(bodyInput(), { target: { value: "Updated body" } });
    fireEvent.click(publish());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(api.bodies("PATCH", `${W}/faq/articles/a1`)).toEqual([
      {
        categoryId: null,
        translations: {
          en: { title: "Pay invoices", slug: "pay-invoices", bodyMd: "Updated body", published: false },
          nl: { title: "Facturen betalen", slug: "facturen-betalen", bodyMd: "Body of Facturen betalen", published: false },
        },
      },
    ]);
    expect(location.pathname).toBe("/w/ws_1/faq/a1");
  });

  it("sends null for a removed translation", async () => {
    const db: Db = { categories: [], articles: [article("a1", { translations: { en: tr("Pay invoices", true), nl: tr("Facturen betalen", false) } })] };
    const api = stubApi(routes(db, { [`PATCH ${W}/faq/articles/a1`]: () => ({ body: db.articles[0] }) }));
    renderFaq("/w/ws_1/faq/a1");
    await screen.findByRole("heading", { name: "Pay invoices", level: 1 });

    fireEvent.click(screen.getByRole("tab", { name: /^NL/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove NL translation" }));

    expect(screen.queryByRole("button", { name: "Remove NL translation" })).toBeNull();
    expect(titleInput().value).toBe("");
    expect(tabNames()).toEqual(["EN ● (Published)", "NL"]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.find("PATCH", `${W}/faq/articles/a1`)).toHaveLength(1));
    expect(api.bodies("PATCH", `${W}/faq/articles/a1`)[0].translations).toEqual({
      en: { title: "Pay invoices", slug: "pay-invoices", bodyMd: "Body of Pay invoices", published: true },
      nl: null,
    });
  });

  it("un-removes a translation when the agent types in it again", async () => {
    const db: Db = { categories: [], articles: [article("a1", { translations: { en: tr("Pay invoices", true), nl: tr("Facturen betalen", true) } })] };
    const api = stubApi(routes(db, { [`PATCH ${W}/faq/articles/a1`]: () => ({ body: db.articles[0] }) }));
    renderFaq("/w/ws_1/faq/a1");
    await screen.findByRole("heading", { name: "Pay invoices", level: 1 });

    fireEvent.click(screen.getByRole("tab", { name: /^NL/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove NL translation" }));
    fireEvent.change(titleInput(), { target: { value: "Nieuwe titel" } });

    expect(screen.getByRole("button", { name: "Remove NL translation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.find("PATCH", `${W}/faq/articles/a1`)).toHaveLength(1));
    expect(api.bodies("PATCH", `${W}/faq/articles/a1`)[0].translations.nl).toEqual({ title: "Nieuwe titel", bodyMd: "", published: false });
  });

  it("deletes the article after confirmation and returns to the list", async () => {
    const db: Db = { categories: [], articles: [article("a1", { translations: { en: tr("Pay invoices", true) } })] };
    const api = stubApi(
      routes(db, {
        [`DELETE ${W}/faq/articles/a1`]: () => {
          db.articles = [];
          return { status: 204 };
        },
      }),
    );
    renderFaq("/w/ws_1/faq/a1");
    await screen.findByRole("heading", { name: "Pay invoices", level: 1 });

    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmMock).toHaveBeenCalledWith("Delete this article in all languages?");
    expect(api.find("DELETE", `${W}/faq/articles/a1`)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(location.pathname).toBe("/w/ws_1/faq"));
    expect(await screen.findByText("No articles yet. Start with your most common question.")).toBeTruthy();
    expect(api.find("DELETE", `${W}/faq/articles/a1`)).toHaveLength(1);
  });
});

describe("FaqPage regressions", () => {
  const boom = () => ({ status: 500, body: { error: { code: "internal_error", message: "Server exploded" } } });

  it("shows an error with Retry when the help center fails to load", async () => {
    let fail = true;
    const db: Db = { articles: [], categories: [] };
    stubApi({ ...routes(db), [`GET ${W}/faq/articles`]: () => (fail ? boom() : { body: db.articles }) });
    renderFaq();
    expect(await screen.findByText(/Couldn't load the help center\./)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "New article" })).toBeTruthy();
  });

  it("toasts when saving or deleting a category fails", async () => {
    const db: Db = { articles: [], categories: [category("cat_1", { en: "Billing" })] };
    stubApi({ ...routes(db), [`PATCH ${W}/faq/categories/cat_1`]: boom, [`DELETE ${W}/faq/categories/cat_1`]: boom });
    renderFaq();
    const input = (await screen.findByDisplayValue("Billing")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Payments" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Server exploded")).toBeTruthy();
    expect(screen.queryByText("Category saved")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getAllByText("Server exploded").length).toBeGreaterThan(0));
  });

  it("stays on the article when deleting it fails", async () => {
    const db: Db = { articles: [article("art_1")], categories: [] };
    stubApi({ ...routes(db), [`DELETE ${W}/faq/articles/art_1`]: boom });
    renderFaq("/w/ws_1/faq/art_1");
    await screen.findByDisplayValue("Article art_1");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Server exploded")).toBeTruthy();
    expect(location.pathname).toBe("/w/ws_1/faq/art_1");
  });
});
