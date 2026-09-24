import {
  ApnsCredentialsRequest,
  FcmCredentialsRequest,
  FcmServiceAccount,
  SaveCannedReplyRequest,
  UpdateWorkspaceSettingsRequest,
  type CannedReply,
  type CsatReport,
  type OfficeHours,
  type WorkspaceSettings,
} from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { encryptString, randomToken } from "../../lib/crypto";
import { ApiException, conflictOnUnique } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { parseJson } from "../../lib/validate";
import { requireMember } from "../../middleware/agent";
import { inboxStub } from "../../realtime/publish";
import { afterResponse, bestEffort } from "../../services/events";
import { pushCredentialStatus, savePushCredentials } from "../../notifications/credentials";
import { allowedOrigins, getWorkspaceById, invalidateWorkspace, type WorkspaceRow } from "../../services/workspaces";

async function toSettings(c: { env: AppBindings["Bindings"] }, ws: WorkspaceRow): Promise<WorkspaceSettings> {
  const push = await pushCredentialStatus(c.env, ws.id);
  return {
    id: ws.id,
    name: ws.name,
    primaryColor: ws.primary_color,
    logoUrl: ws.logo_url,
    greeting: JSON.parse(ws.greeting),
    defaultLocale: ws.default_locale,
    locales: JSON.parse(ws.locales),
    officeHours: JSON.parse(ws.office_hours) as OfficeHours,
    autoReply: JSON.parse(ws.auto_reply),
    typicalReplyMinutes: ws.typical_reply_minutes,
    allowedOrigins: allowedOrigins(ws),
    csatEnabled: ws.csat_enabled === 1,
    publishableKey: ws.publishable_key,
    push: { fcmUpdatedAt: push.fcm, apnsUpdatedAt: push.apns },
  };
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const settingsRoutes = new Hono<AppBindings>()
  .get("/", async (c) => c.json(await toSettings(c, await getWorkspaceById(c.env.DB, c.get("membership").workspaceId))))

  .patch("/", requireMember("admin"), async (c) => {
    const ws = await getWorkspaceById(c.env.DB, c.get("membership").workspaceId);
    const body = await parseJson(c, UpdateWorkspaceSettingsRequest);
    const locales = body.locales ?? (JSON.parse(ws.locales) as string[]);
    const defaultLocale = body.defaultLocale ?? ws.default_locale;
    if (!locales.includes(defaultLocale)) throw new ApiException(400, "invalid_locales", "The default language must be one of the enabled languages");
    if (body.officeHours && !validTimezone(body.officeHours.timezone)) throw new ApiException(400, "invalid_timezone", "Unknown timezone");

    const fields: Record<string, unknown> = {
      name: body.name,
      primary_color: body.primaryColor,
      logo_url: body.logoUrl,
      greeting: body.greeting && JSON.stringify(body.greeting),
      default_locale: body.defaultLocale,
      locales: body.locales && JSON.stringify(body.locales),
      office_hours: body.officeHours && JSON.stringify(body.officeHours),
      auto_reply: body.autoReply && JSON.stringify(body.autoReply),
      typical_reply_minutes: body.typicalReplyMinutes,
      allowed_origins: body.allowedOrigins && JSON.stringify(body.allowedOrigins),
      csat_enabled: body.csatEnabled === undefined ? undefined : body.csatEnabled ? 1 : 0,
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      await c.env.DB.prepare(`UPDATE workspaces SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
        .bind(...entries.map(([, v]) => v), ws.id)
        .run();
      invalidateWorkspace(ws.id);
    }
    return c.json(await toSettings(c, await getWorkspaceById(c.env.DB, ws.id)));
  })

  .post("/rotate-identity-secret", requireMember("admin"), async (c) => {
    const secret = `sk_id_${randomToken(24)}`;
    // Bumping the epoch also revokes every contact token issued so far (the SDKs re-create
    // sessions transparently on 401 invalid_token; verified users need the new hash).
    const workspaceId = c.get("membership").workspaceId;
    const { contact_token_epoch: epoch } = (await c.env.DB.prepare(
      "UPDATE workspaces SET identity_secret_enc = ?, contact_token_epoch = contact_token_epoch + 1 WHERE id = ? RETURNING contact_token_epoch",
    )
      .bind(await encryptString(c.env.ENCRYPTION_KEY, secret), workspaceId)
      .first<{ contact_token_epoch: number }>())!;
    invalidateWorkspace(workspaceId);
    // Open contact sockets were authorized with now-revoked tokens: close them (they reconnect
    // with a new session). Sockets already on the new epoch stay.
    await afterResponse(c, () => bestEffort("disconnect contacts", () => inboxStub(c.env, workspaceId).disconnectContacts(epoch)));
    return c.json({ identitySecret: secret });
  })

  .put("/push/fcm", requireMember("admin"), async (c) => {
    const { serviceAccountJson } = await parseJson(c, FcmCredentialsRequest);
    let raw: unknown;
    try {
      raw = JSON.parse(serviceAccountJson);
    } catch {
      throw new ApiException(400, "invalid_json", "Service account must be valid JSON");
    }
    const account = FcmServiceAccount.safeParse(raw);
    if (!account.success) {
      throw new ApiException(400, "invalid_service_account", "Missing project_id, client_email or private_key");
    }
    const parsed = account.data;
    await savePushCredentials(c.env, c.get("membership").workspaceId, "fcm", {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key: parsed.private_key,
    });
    return c.body(null, 204);
  })

  .put("/push/apns", requireMember("admin"), async (c) => {
    const body = await parseJson(c, ApnsCredentialsRequest);
    await savePushCredentials(c.env, c.get("membership").workspaceId, "apns", body);
    return c.body(null, 204);
  })

  .delete("/push/:kind{fcm|apns}", requireMember("admin"), async (c) => {
    await c.env.DB.prepare("DELETE FROM push_credentials WHERE workspace_id = ? AND kind = ?")
      .bind(c.get("membership").workspaceId, c.req.param("kind"))
      .run();
    return c.body(null, 204);
  });

interface CannedRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
}
const toCanned = (r: CannedRow): CannedReply => ({ id: r.id, shortcut: r.shortcut, title: r.title, body: r.body });

export const cannedRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM canned_replies WHERE workspace_id = ? ORDER BY shortcut")
      .bind(c.get("membership").workspaceId)
      .all<CannedRow>();
    return c.json(results.map(toCanned));
  })
  .post("/", async (c) => {
    const body = await parseJson(c, SaveCannedReplyRequest);
    const id = newId("cr");
    await c.env.DB.prepare("INSERT INTO canned_replies (id, workspace_id, shortcut, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, c.get("membership").workspaceId, body.shortcut, body.title, body.body, Date.now())
      .run()
      .catch(conflictOnUnique("shortcut_taken", "That shortcut is already used"));
    return c.json({ id, ...body }, 201);
  })
  .put("/:id", async (c) => {
    const body = await parseJson(c, SaveCannedReplyRequest);
    const res = await c.env.DB.prepare("UPDATE canned_replies SET shortcut = ?, title = ?, body = ? WHERE id = ? AND workspace_id = ?")
      .bind(body.shortcut, body.title, body.body, c.req.param("id"), c.get("membership").workspaceId)
      .run()
      .catch(conflictOnUnique("shortcut_taken", "That shortcut is already used"));
    if (res.meta.changes === 0) throw new ApiException(404, "not_found", "Canned reply not found");
    return c.json({ id: c.req.param("id"), ...body });
  })
  .delete("/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM canned_replies WHERE id = ? AND workspace_id = ?")
      .bind(c.req.param("id"), c.get("membership").workspaceId)
      .run();
    return c.body(null, 204);
  });

/** Most recent conversations used for the median first-reply time. */
const MEDIAN_SAMPLE = 2_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const reportRoutes = new Hono<AppBindings>().get("/", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 365);
  const since = Date.now() - days * 86_400_000;
  const workspaceId = c.get("membership").workspaceId;
  // Counts are aggregated in SQL (uses conversations_ws_created); only the reply-time sample
  // for the median comes back as rows, capped so busy workspaces stay within D1/Worker limits.
  const [totals, { results: replyTimes }, { results: comments }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS conversations,
         COALESCE(SUM(status = 'resolved'), 0) AS resolved,
         COUNT(csat_score) AS responses,
         AVG(csat_score) AS average,
         COALESCE(SUM(csat_score = 1), 0) AS s1, COALESCE(SUM(csat_score = 2), 0) AS s2, COALESCE(SUM(csat_score = 3), 0) AS s3,
         COALESCE(SUM(csat_score = 4), 0) AS s4, COALESCE(SUM(csat_score = 5), 0) AS s5
       FROM conversations WHERE workspace_id = ? AND created_at >= ?`,
    )
      .bind(workspaceId, since)
      .first<{ conversations: number; resolved: number; responses: number; average: number | null; s1: number; s2: number; s3: number; s4: number; s5: number }>(),
    c.env.DB.prepare(
      `SELECT first_reply_at - created_at AS delta FROM (
         SELECT c.created_at,
           (SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'agent') AS first_reply_at
         FROM conversations c WHERE c.workspace_id = ? AND c.created_at >= ?
         ORDER BY c.created_at DESC LIMIT ?
       ) WHERE first_reply_at IS NOT NULL`,
    )
      .bind(workspaceId, since, MEDIAN_SAMPLE)
      .all<{ delta: number }>(),
    c.env.DB.prepare(
      `SELECT id, csat_score, csat_comment, last_message_at FROM conversations
       WHERE workspace_id = ? AND csat_comment IS NOT NULL AND created_at >= ? ORDER BY last_message_at DESC LIMIT 20`,
    )
      .bind(workspaceId, since)
      .all<{ id: string; csat_score: number; csat_comment: string; last_message_at: number }>(),
  ]);
  const t = totals!;
  const report: CsatReport = {
    days,
    responses: t.responses,
    average: t.average === null ? null : Math.round(t.average * 100) / 100,
    distribution: [t.s1, t.s2, t.s3, t.s4, t.s5],
    conversations: t.conversations,
    resolved: t.resolved,
    medianFirstResponseMinutes: median(replyTimes.map((r) => Math.round((r.delta / 60_000) * 10) / 10)),
    recentComments: comments.map((r) => ({ conversationId: r.id, score: r.csat_score, comment: r.csat_comment, at: r.last_message_at })),
  };
  return c.json(report);
});
