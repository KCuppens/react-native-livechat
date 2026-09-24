import { FaqFeedbackRequest } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { pageLimit, parseJson } from "../../lib/validate";
import { getArticleBySlug, listArticles, listCategories, recordFeedback, recordView, searchArticles } from "../../services/faq";


/** Help center content is public for the workspace (no contact token needed) and cacheable briefly. */
export const faqRoutes = new Hono<AppBindings>()
  .get("/categories", async (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(await listCategories(c.env.DB, c.get("workspace"), c.req.query("locale")));
  })

  .get("/articles", async (c) => {
    const ws = c.get("workspace");
    const q = c.req.query("q")?.trim();
    const locale = c.req.query("locale");
    if (q) {
      const mode = c.req.query("mode") === "any" ? "any" : "all";
      return c.json(await searchArticles(c.env.DB, ws, { q, locale, mode, limit: pageLimit(c.req.query("limit"), 10, 50) }));
    }
    c.header("Cache-Control", "public, max-age=60");
    return c.json(
      await listArticles(c.env.DB, ws, {
        locale,
        categoryId: c.req.query("category"),
        sort: c.req.query("sort") === "popular" ? "popular" : "position",
        limit: pageLimit(c.req.query("limit"), 50, 50),
      }),
    );
  })

  .get("/articles/:slug", async (c) => {
    const ws = c.get("workspace");
    const article = await getArticleBySlug(c.env.DB, ws, c.req.param("slug"), c.req.query("locale"));
    const view = recordView(c.env.DB, ws.id, article.id);
    try {
      c.executionCtx.waitUntil(view);
    } catch {
      await view; // no execution context (tests)
    }
    return c.json(article);
  })

  .post("/articles/:id/feedback", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.MESSAGE_LIMITER.limit({ key: `feedback:${ip}:${c.req.param("id")}` });
    if (!success) throw new ApiException(429, "rate_limited", "Too many requests");
    const { helpful } = await parseJson(c, FaqFeedbackRequest);
    await recordFeedback(c.env.DB, c.get("workspace").id, c.req.param("id"), helpful);
    return c.body(null, 204);
  });
