import { MagicLinkRequest, VerifyMagicLinkRequest } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { parseJson } from "../../lib/validate";
import { SESSION_COOKIE } from "../../middleware/agent";
import { AGENT_SESSION_TTL_MS, agentForSession, consumeMagicLink, deleteSession, sendMagicLink, sessionTag, toAgent } from "../../services/agents";
import { inboxStub } from "../../realtime/publish";

export const authRoutes = new Hono<AppBindings>()
  .use(async (c, next) => {
    if (c.req.header("X-Livechat-Dashboard") !== "1") throw new ApiException(403, "csrf", "Missing X-Livechat-Dashboard header");
    await next();
  })
  .post("/magic-link", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.SESSION_LIMITER.limit({ key: `magic:${ip}` });
    if (!success) throw new ApiException(429, "rate_limited", "Too many requests");
    const { email } = await parseJson(c, MagicLinkRequest);
    await sendMagicLink(c.env, email.trim(), "login");
    return c.body(null, 204);
  })

  .post("/verify", async (c) => {
    const { token } = await parseJson(c, VerifyMagicLinkRequest);
    const result = await consumeMagicLink(c.env.DB, token);
    if (!result) throw new ApiException(400, "invalid_link", "This sign-in link is invalid or has expired");
    setCookie(c, SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: c.env.PUBLIC_URL.startsWith("https://"),
      sameSite: "Lax",
      path: "/",
      maxAge: AGENT_SESSION_TTL_MS / 1000,
    });
    return c.json({ agent: toAgent(result.agent) });
  })

  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const agent = await agentForSession(c.env.DB, token);
      await deleteSession(c.env.DB, token);
      if (agent) {
        // Hibernated sockets never re-check auth: close this session's ones now.
        const tag = await sessionTag(token);
        const { results } = await c.env.DB.prepare("SELECT workspace_id FROM workspace_members WHERE agent_id = ?")
          .bind(agent.id)
          .all<{ workspace_id: string }>();
        await Promise.allSettled(results.map((m) => inboxStub(c.env, m.workspace_id).disconnectSession(agent.id, tag)));
      }
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });
