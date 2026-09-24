import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { publicCors, requireContact, requireWorkspace } from "../../middleware/public";
import { storeAttachment } from "../../services/attachments";
import { PushDeviceRequest } from "@kobecuppens/livechat-protocol";
import { parseJson } from "../../lib/validate";
import { configRoutes } from "./config";
import { conversationRoutes } from "./conversations";
import { faqRoutes } from "./faq";
import { sessionRoutes } from "./session";

export const publicApi = new Hono<AppBindings>()
  .use(publicCors)
  .use(requireWorkspace)
  .route("/config", configRoutes)
  .route("/session", sessionRoutes)
  .route("/conversations", conversationRoutes)
  .route("/faq", faqRoutes)
  .post("/attachments", requireContact, async (c) => {
    const { contactId, workspaceId } = c.get("contact");
    const { success } = await c.env.MESSAGE_LIMITER.limit({ key: `upload:${contactId}` });
    if (!success) throw new ApiException(429, "rate_limited", "Too many uploads");
    return c.json(await storeAttachment(c.env, c.req.raw, workspaceId, { type: "contact", id: contactId }), 201);
  })
  .post("/push-devices", requireContact, async (c) => {
    const { contactId, workspaceId } = c.get("contact");
    const body = await parseJson(c, PushDeviceRequest);
    // A token belongs to one device; re-registering moves it to the current contact (e.g. after login).
    await c.env.DB.prepare(
      `INSERT INTO push_devices (token, contact_id, workspace_id, platform, app_id, sandbox, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET contact_id = excluded.contact_id, workspace_id = excluded.workspace_id,
         platform = excluded.platform, app_id = excluded.app_id, sandbox = excluded.sandbox, updated_at = excluded.updated_at`,
    )
      .bind(body.token, contactId, workspaceId, body.platform, body.appId, body.sandbox ? 1 : 0, Date.now())
      .run();
    return c.body(null, 204);
  })
  .delete("/push-devices/:token", requireContact, async (c) => {
    await c.env.DB.prepare("DELETE FROM push_devices WHERE token = ? AND contact_id = ?")
      .bind(c.req.param("token"), c.get("contact").contactId)
      .run();
    return c.body(null, 204);
  });
