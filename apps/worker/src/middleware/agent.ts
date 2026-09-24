import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../env";
import { ApiException } from "../lib/errors";
import { agentForSession, getMembership } from "../services/agents";

export const SESSION_COOKIE = "lc_session";

/**
 * Dashboard requests are same-origin and cookie-authenticated. Mutations must carry a
 * custom header, which a cross-site form or simple request cannot set (CSRF guard).
 */
export const requireAgent = createMiddleware<AppBindings>(async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.header("X-Livechat-Dashboard") !== "1") {
    throw new ApiException(403, "csrf", "Missing X-Livechat-Dashboard header");
  }
  // Cross-site WebSocket hijacking guard: a dashboard socket must come from the dashboard's own origin.
  const origin = c.req.header("Origin");
  if (c.req.header("Upgrade") === "websocket" && origin && origin !== new URL(c.env.PUBLIC_URL).origin) {
    throw new ApiException(403, "origin_not_allowed", "Cross-origin dashboard socket");
  }
  const token = getCookie(c, SESSION_COOKIE);
  const agent = token ? await agentForSession(c.env.DB, token) : null;
  if (!agent) throw new ApiException(401, "unauthenticated", "Sign in required");
  c.set("agent", agent);
  await next();
});

/** Requires membership of the `:workspaceId` route param; `admin` additionally requires the admin role. */
export const requireMember = (level: "agent" | "admin" = "agent") =>
  createMiddleware<AppBindings>(async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) throw new ApiException(400, "missing_workspace", "Workspace id required");
    const membership = await getMembership(c.env.DB, workspaceId, c.get("agent").id);
    if (!membership) throw new ApiException(404, "workspace_not_found", "Workspace not found");
    if (level === "admin" && membership.role !== "admin") throw new ApiException(403, "forbidden", "Admin role required");
    c.set("membership", { workspaceId, role: membership.role });
    await next();
  });
