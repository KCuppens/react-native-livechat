import { SessionRequest, type SessionResponse } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { parseJson } from "../../lib/validate";
import { verifyContactToken } from "../../middleware/public";
import { resolveContact, toContact } from "../../services/contacts";
import { refreshWorkspace } from "../../services/workspaces";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const sessionRoutes = new Hono<AppBindings>().post("/", async (c) => {
  const cached = c.get("workspace");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.SESSION_LIMITER.limit({ key: `${cached.id}:${ip}` });
  if (!success) throw new ApiException(429, "rate_limited", "Too many session requests");
  // Sessions are signed with the current token epoch and identity secret, never a cached copy:
  // a stale isolate would otherwise mint tokens that are revoked as soon as its cache refreshes.
  const ws = await refreshWorkspace(c.env.DB, cached);
  c.set("workspace", ws);

  const body = await parseJson(c, SessionRequest);

  // A previous anonymous token proves ownership of that contact, which allows merging it.
  let previousAnonymousId: string | null = null;
  if (body.previousToken && body.userId) {
    const prev = await verifyContactToken(body.previousToken, c.env.CONTACT_JWT_SECRET);
    if (prev && prev.ws === ws.id && (prev.ep ?? 0) === ws.contact_token_epoch) previousAnonymousId = prev.sub;
  }

  const contact = await resolveContact(c.env.DB, ws, c.env.ENCRYPTION_KEY, body, previousAnonymousId);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  // `ep` ties the token to the workspace's token epoch, so rotating the identity secret revokes it.
  const token = await sign({ sub: contact.id, ws: ws.id, ep: ws.contact_token_epoch, exp }, c.env.CONTACT_JWT_SECRET, "HS256");

  return c.json({ token, expiresAt: exp * 1000, contact: toContact(contact) } satisfies SessionResponse);
});
