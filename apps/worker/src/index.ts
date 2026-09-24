import { Hono } from "hono";
import type { AppBindings, Env } from "./env";
import { onError } from "./lib/errors";
import { consumeNotifications } from "./notifications/consumer";
import { serveAttachment, verifySignedUrl } from "./services/attachments";
import { agentApi } from "./routes/agent";
import { publicApi } from "./routes/public";

export { ConversationRoom } from "./realtime/conversation-room";
export { WorkspaceInbox } from "./realtime/workspace-inbox";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUIRED_SECRETS = ["CONTACT_JWT_SECRET", "ENCRYPTION_KEY", "ATTACHMENT_SIGNING_KEY"] as const;

/** A missing secret or a non-https PUBLIC_URL would otherwise surface as scattered 500s or silent bugs. */
function configProblem(env: Env, hostname: string): string | null {
  const missing = REQUIRED_SECRETS.filter((k) => !env[k]);
  if (missing.length > 0) return `missing secrets: ${missing.join(", ")}`;
  if (env.EMAIL && !env.EMAIL_FROM) return "EMAIL_FROM must be set when the EMAIL binding is configured";
  if (LOCAL_HOSTS.has(hostname)) return null;
  if (!env.PUBLIC_URL?.startsWith("https://")) return "PUBLIC_URL must be the Worker's https URL";
  // Dev email logging prints sign-in links (credentials) to logs: never on a deployed host.
  if (env.DEV_EMAIL_LOG === "true") return "DEV_EMAIL_LOG must not be enabled outside local development";
  return null;
}

export const app = new Hono<AppBindings>()
  // PUBLIC_URL builds sign-in links, file URLs, the cookie's Secure flag and the socket origin
  // check. A deployed Worker left on the localhost default would fail quietly in all four places.
  .use(async (c, next) => {
    const problem = configProblem(c.env, new URL(c.req.url).hostname);
    if (problem) {
      console.error({ msg: "misconfigured", problem });
      return c.json({ error: { code: "misconfigured", message: "Server is misconfigured" } }, 500);
    }
    await next();
  })
  // Probes D1 with schema-dependent queries so a missing or unmigrated database reports 503.
  .get("/health", async (c) => {
    const started = Date.now();
    try {
      // Selects columns from the latest migration (0004): a deploy that skipped it reports 503.
      // Update this when adding a migration.
      await c.env.DB.prepare("SELECT contact_token_epoch FROM workspaces LIMIT 1").first();
      await c.env.DB.prepare("SELECT first_client_id, csat_requested_at FROM conversations LIMIT 1").first();
      return c.json({ ok: true, checks: { d1: { ok: true, ms: Date.now() - started } } });
    } catch (err) {
      console.error({ msg: "health: d1 failed", error: err instanceof Error ? err.message : String(err) });
      return c.json({ ok: false, checks: { d1: { ok: false } } }, 503);
    }
  })
  .get("/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await verifySignedUrl(c.env, id, c.req.query("exp"), c.req.query("sig")))) {
      return c.json({ error: { code: "invalid_signature", message: "Link expired or invalid" } }, 403);
    }
    return serveAttachment(c.env, id);
  })
  .route("/v1", publicApi)
  .route("/agent", agentApi)
  .notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404))
  .onError(onError);

export default {
  fetch: app.fetch,
  queue: consumeNotifications,
} satisfies ExportedHandler<Env, import("./notifications/types").NotificationJob>;
