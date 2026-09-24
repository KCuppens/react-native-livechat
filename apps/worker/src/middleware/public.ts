import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { AppBindings } from "../env";
import { ApiException } from "../lib/errors";
import { allowedOrigins, getWorkspaceByKey, refreshWorkspace } from "../services/workspaces";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Livechat-Key",
  "Access-Control-Max-Age": "86400",
};

/**
 * CORS for the public SDK API. Preflights are answered for any origin because the
 * workspace (and so its allow-list) is only known on the real request; `requireWorkspace`
 * then rejects disallowed origins before any work is done.
 */
export const publicCors = createMiddleware<AppBindings>(async (c, next) => {
  const origin = c.req.header("Origin");
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: origin ? { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" } : CORS_HEADERS,
    });
  }
  await next();
  // WebSocket upgrade responses (101) come from the Durable Object with immutable headers.
  if (c.res.status !== 101) {
    // Responses depend on the workspace key header; caches must not mix workspaces.
    c.res.headers.append("Vary", "X-Livechat-Key");
  }
  if (origin && c.res.status !== 101) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.append("Vary", "Origin");
  }
});

/** Resolves the workspace from the publishable key (header, or `key` query param for WebSockets). */
export const requireWorkspace = createMiddleware<AppBindings>(async (c, next) => {
  const key = c.req.header("X-Livechat-Key") ?? c.req.query("key");
  if (!key) throw new ApiException(401, "missing_key", "X-Livechat-Key header is required");
  const ws = await getWorkspaceByKey(c.env.DB, key);
  if (!ws) throw new ApiException(401, "invalid_key", "Unknown publishable key");

  const origin = c.req.header("Origin");
  if (origin) {
    const allowed = allowedOrigins(ws);
    if (!allowed.includes("*") && !allowed.includes(origin)) {
      throw new ApiException(403, "origin_not_allowed", `Origin ${origin} is not allowed for this workspace`);
    }
  }
  c.set("workspace", ws);
  await next();
});

export interface ContactTokenPayload {
  sub: string;
  ws: string;
  /** Workspace token epoch at issue time (absent on tokens issued before epochs existed = 0). */
  ep?: number;
  exp: number;
  [key: string]: unknown;
}

export async function verifyContactToken(token: string, secret: string): Promise<ContactTokenPayload | null> {
  try {
    return (await verify(token, secret, "HS256")) as ContactTokenPayload;
  } catch {
    return null;
  }
}

/** Requires a contact session token (Bearer header, or `token` query param for WebSockets). */
export const requireContact = createMiddleware<AppBindings>(async (c, next) => {
  const header = c.req.header("Authorization");
  // Query tokens only for WebSocket handshakes (browsers can't set headers there); URLs end up in logs.
  const queryToken = c.req.header("Upgrade") === "websocket" ? c.req.query("token") : undefined;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (!token) throw new ApiException(401, "missing_token", "Contact session token is required");
  const payload = await verifyContactToken(token, c.env.CONTACT_JWT_SECRET);
  let ws = c.get("workspace");
  // A token from a newer epoch than this isolate's cached row means the cache is stale (another
  // isolate signed it after a rotation): re-read instead of revoking a valid session.
  if (payload && payload.ws === ws.id && (payload.ep ?? 0) > ws.contact_token_epoch) {
    ws = await refreshWorkspace(c.env.DB, ws);
    c.set("workspace", ws);
  }
  if (!payload || payload.ws !== ws.id || (payload.ep ?? 0) !== ws.contact_token_epoch) {
    throw new ApiException(401, "invalid_token", "Session token is invalid or expired");
  }
  c.set("contact", { contactId: payload.sub, workspaceId: payload.ws, epoch: payload.ep ?? 0 });
  await next();
});
