import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { requireAgent, requireMember } from "../../middleware/agent";
import { agentMe } from "../../services/agents";
import { authRoutes } from "./auth";
import { agentAttachmentRoute, agentConversationRoutes, inboxSocketRoute } from "./conversations";
import { agentFaqRoutes } from "./faq";
import { cannedRoutes, reportRoutes, settingsRoutes } from "./settings";
import { workspaceRoutes } from "./workspaces";

export const agentApi = new Hono<AppBindings>()
  .route("/auth", authRoutes)
  .use(requireAgent)
  .get("/me", async (c) => c.json(await agentMe(c.env, c.get("agent"))))
  .route("/workspaces", workspaceRoutes)
  .use("/w/:workspaceId/*", requireMember())
  .route("/w/:workspaceId/conversations", agentConversationRoutes)
  .route("/w/:workspaceId/inbox/ws", inboxSocketRoute)
  .route("/w/:workspaceId/faq", agentFaqRoutes)
  .route("/w/:workspaceId/attachments", agentAttachmentRoute)
  .route("/w/:workspaceId/settings", settingsRoutes)
  .route("/w/:workspaceId/canned-replies", cannedRoutes)
  .route("/w/:workspaceId/reports", reportRoutes);
