import { SaveFaqArticleRequest, SaveFaqCategoryRequest } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { parseJson } from "../../lib/validate";
import {
  deleteArticle,
  deleteCategory,
  getAgentArticle,
  listAgentArticles,
  listAgentCategories,
  saveArticle,
  saveCategory,
} from "../../services/faq";
import { getWorkspaceById } from "../../services/workspaces";

export const agentFaqRoutes = new Hono<AppBindings>()
  .get("/categories", async (c) => c.json(await listAgentCategories(c.env.DB, c.get("membership").workspaceId)))
  .post("/categories", async (c) => {
    const body = await parseJson(c, SaveFaqCategoryRequest);
    return c.json(await saveCategory(c.env.DB, c.get("membership").workspaceId, null, body), 201);
  })
  .patch("/categories/:id", async (c) => {
    const body = await parseJson(c, SaveFaqCategoryRequest);
    return c.json(await saveCategory(c.env.DB, c.get("membership").workspaceId, c.req.param("id"), body));
  })
  .delete("/categories/:id", async (c) => {
    await deleteCategory(c.env.DB, c.get("membership").workspaceId, c.req.param("id"));
    return c.body(null, 204);
  })

  .get("/articles", async (c) => c.json(await listAgentArticles(c.env.DB, c.get("membership").workspaceId)))
  .get("/articles/:id", async (c) => c.json(await getAgentArticle(c.env.DB, c.get("membership").workspaceId, c.req.param("id"))))
  .post("/articles", async (c) => {
    const body = await parseJson(c, SaveFaqArticleRequest);
    const ws = await getWorkspaceById(c.env.DB, c.get("membership").workspaceId);
    return c.json(await saveArticle(c.env.DB, ws, null, body), 201);
  })
  .patch("/articles/:id", async (c) => {
    const body = await parseJson(c, SaveFaqArticleRequest);
    const ws = await getWorkspaceById(c.env.DB, c.get("membership").workspaceId);
    return c.json(await saveArticle(c.env.DB, ws, c.req.param("id"), body));
  })
  .delete("/articles/:id", async (c) => {
    await deleteArticle(c.env.DB, c.get("membership").workspaceId, c.req.param("id"));
    return c.body(null, 204);
  });
