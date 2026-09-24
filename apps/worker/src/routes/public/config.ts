import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { toWorkspaceConfig } from "../../services/workspaces";

export const configRoutes = new Hono<AppBindings>().get("/", (c) => {
  c.header("Cache-Control", "public, max-age=60");
  return c.json(toWorkspaceConfig(c.get("workspace")));
});
