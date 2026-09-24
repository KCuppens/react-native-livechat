import type { AgentFaqArticle, AgentFaqCategory, FaqArticle, FaqArticleSummary, FaqCategory } from "@kobecuppens/livechat-protocol";
import { describe, expect, it } from "vitest";
import { ftsQuery } from "../src/services/faq";
import { signIn } from "./agent-helpers";
import { json } from "./helpers";
import { app } from "../src/index";
import { env } from "cloudflare:test";

async function setupFaq() {
  const admin = await signIn("owner@acme.com");
  const ws = (await (
    await admin.call("/agent/workspaces", { method: "POST", body: json({ name: "Acme", defaultLocale: "en", locales: ["en", "nl"], allowedOrigins: ["*"] }) })
  ).json()) as { id: string; publishableKey: string };
  const pub = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Livechat-Key", ws.publishableKey);
    if (init.body) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers }, env);
  };
  const base = `/agent/w/${ws.id}/faq`;
  const category = (await (
    await admin.call(`${base}/categories`, { method: "POST", body: json({ titles: { en: "Billing", nl: "Facturatie" }, icon: "credit-card" }) })
  ).json()) as AgentFaqCategory;

  const refund = (await (
    await admin.call(`${base}/articles`, {
      method: "POST",
      body: json({
        categoryId: category.id,
        translations: {
          en: { title: "How do I get a refund?", bodyMd: "Go to **Settings → Billing** and tap *Request refund*.", published: true },
          nl: { title: "Hoe krijg ik mijn geld terug?", bodyMd: "Ga naar **Instellingen → Facturatie** en tik op *Terugbetaling*.", published: true },
        },
      }),
    })
  ).json()) as AgentFaqArticle;
  const password = (await (
    await admin.call(`${base}/articles`, {
      method: "POST",
      body: json({ translations: { en: { title: "Resetting your password", bodyMd: "Use the *Forgot password* link on the login screen.", published: true } } }),
    })
  ).json()) as AgentFaqArticle;
  const draft = (await (
    await admin.call(`${base}/articles`, {
      method: "POST",
      body: json({ categoryId: category.id, translations: { en: { title: "Refund policy draft", bodyMd: "Secret refund draft", published: false } } }),
    })
  ).json()) as AgentFaqArticle;
  return { admin, ws, pub, base, category, refund, password, draft };
}

describe("ftsQuery", () => {
  it("quotes terms so FTS syntax can't be injected, prefix-matching the last term", () => {
    expect(ftsQuery('refund" OR title:*', "all")).toBe('"refund" AND "or" AND "title"*');
    expect(ftsQuery("   ", "all")).toBeNull();
  });

  it("uses OR over significant words in 'any' mode", () => {
    expect(ftsQuery("I want a refund please", "any")).toBe('"want" OR "refund" OR "please"');
  });
});

describe("public help center", () => {
  it("lists categories with localized titles and published counts only", async () => {
    const { pub } = await setupFaq();
    const nl = (await (await pub("/v1/faq/categories?locale=nl-BE")).json()) as FaqCategory[];
    expect(nl).toEqual([expect.objectContaining({ title: "Facturatie", articleCount: 1, icon: "credit-card" })]);
  });

  it("falls back to the default locale per article", async () => {
    const { pub } = await setupFaq();
    const list = (await (await pub("/v1/faq/articles?locale=nl")).json()) as FaqArticleSummary[];
    expect(list.map((a) => [a.title, a.locale])).toEqual(
      expect.arrayContaining([
        ["Hoe krijg ik mijn geld terug?", "nl"],
        ["Resetting your password", "en"],
      ]),
    );
    expect(list).toHaveLength(2); // draft excluded
  });

  it("searches as you type with prefix matching and hides drafts", async () => {
    const { pub, refund } = await setupFaq();
    const hits = (await (await pub("/v1/faq/articles?q=refu")).json()) as FaqArticleSummary[];
    expect(hits.map((h) => h.id)).toEqual([refund.id]);
    const accent = (await (await pub("/v1/faq/articles?q=facturatie&locale=nl")).json()) as FaqArticleSummary[];
    expect(accent.map((h) => h.id)).toEqual([refund.id]);
  });

  it("suggests articles from a chat message in 'any' mode", async () => {
    const { pub, password } = await setupFaq();
    const hits = (await (await pub(`/v1/faq/articles?mode=any&q=${encodeURIComponent("hi, I forgot my password and can't log in")}`)).json()) as FaqArticleSummary[];
    expect(hits[0]?.id).toBe(password.id);
  });

  it("serves an article by any locale's slug in the requested locale and counts views", async () => {
    const { pub, admin, base, refund } = await setupFaq();
    const article = (await (await pub(`/v1/faq/articles/how-do-i-get-a-refund?locale=nl`)).json()) as FaqArticle;
    expect(article).toMatchObject({ id: refund.id, locale: "nl", title: "Hoe krijg ik mijn geld terug?" });
    expect(article.bodyMd).toContain("Instellingen");
    expect((await pub("/v1/faq/articles/refund-policy-draft")).status).toBe(404);

    await pub(`/v1/faq/articles/${refund.id}/feedback`, { method: "POST", body: json({ helpful: true }) });
    const stats = (await (await admin.call(`${base}/articles/${refund.id}`)).json()) as AgentFaqArticle;
    expect(stats).toMatchObject({ viewCount: 1, helpfulCount: 1 });
  });
});

describe("dashboard FAQ editing", () => {
  it("updates translations, keeps the search index in sync and deletes", async () => {
    const { pub, admin, base, password } = await setupFaq();
    await admin.call(`${base}/articles/${password.id}`, {
      method: "PATCH",
      body: json({ translations: { en: { title: "Change your passphrase", bodyMd: "Profile → Security", published: true } } }),
    });
    expect(((await (await pub("/v1/faq/articles?q=passphrase")).json()) as unknown[]).length).toBe(1);
    expect(((await (await pub("/v1/faq/articles?q=forgot")).json()) as unknown[]).length).toBe(0);

    await admin.call(`${base}/articles/${password.id}`, { method: "DELETE" });
    expect(((await (await pub("/v1/faq/articles?q=passphrase")).json()) as unknown[]).length).toBe(0);
  });

  it("rejects duplicate slugs and unsupported locales", async () => {
    const { admin, base } = await setupFaq();
    const dup = await admin.call(`${base}/articles`, {
      method: "POST",
      body: json({ translations: { en: { title: "How do I get a refund?", bodyMd: "x" } } }),
    });
    expect(dup.status).toBe(409);
    const fr = await admin.call(`${base}/articles`, { method: "POST", body: json({ translations: { fr: { title: "Bonjour", bodyMd: "x" } } }) });
    expect(fr.status).toBe(400);
  });

  it("lists, renames and validates categories", async () => {
    const { admin, base, category } = await setupFaq();
    const list = (await (await admin.call(`${base}/categories`)).json()) as AgentFaqCategory[];
    expect(list.map((c) => c.id)).toEqual([category.id]);

    const renamed = await admin.call(`${base}/categories/${category.id}`, { method: "PATCH", body: json({ titles: { en: "Payments" }, icon: null }) });
    expect(await renamed.json()).toMatchObject({ titles: { en: "Payments" }, icon: null, slug: "billing" });

    const other = (await (await admin.call(`${base}/categories`, { method: "POST", body: json({ titles: { en: "Account" } }) })).json()) as AgentFaqCategory;
    expect((await admin.call(`${base}/categories/${other.id}`, { method: "PATCH", body: json({ slug: "billing" }) })).status).toBe(409);
    expect((await admin.call(`${base}/categories/cat_missing`, { method: "PATCH", body: json({ titles: { en: "x" } }) })).status).toBe(404);
  });

  it("lists all articles with every translation, including drafts", async () => {
    const { admin, base, refund, draft } = await setupFaq();
    const all = (await (await admin.call(`${base}/articles`)).json()) as AgentFaqArticle[];
    expect(all.map((a) => a.id)).toEqual(expect.arrayContaining([refund.id, draft.id]));
    expect(all.find((a) => a.id === refund.id)!.translations).toHaveProperty("nl");
    expect((await admin.call(`${base}/articles/art_missing`)).status).toBe(404);
  });

  it("deleting a category keeps its articles uncategorized", async () => {
    const { admin, base, category, refund } = await setupFaq();
    await admin.call(`${base}/categories/${category.id}`, { method: "DELETE" });
    const article = (await (await admin.call(`${base}/articles/${refund.id}`)).json()) as AgentFaqArticle;
    expect(article.categoryId).toBeNull();
  });
});
