import { AgentRole, CreateWorkspaceRequest } from "@kobecuppens/livechat-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../env";
import { ApiException } from "../../lib/errors";
import { parseJson } from "../../lib/validate";
import { requireMember } from "../../middleware/agent";
import { inboxStub } from "../../realtime/publish";
import { addMember, ensureAgent, isSuperAdmin, sendMagicLink, toAgent, type AgentRow } from "../../services/agents";
import { createWorkspace } from "../../services/workspaces";



const InviteMember = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(100).optional(),
  role: AgentRole.default("agent"),
});

export const workspaceRoutes = new Hono<AppBindings>()
  .post("/", async (c) => {
    const agent = c.get("agent");
    if (!isSuperAdmin(c.env, agent.email)) throw new ApiException(403, "forbidden", "Only super admins can create workspaces");
    const body = await parseJson(c, CreateWorkspaceRequest);
    const ws = await createWorkspace(c.env.DB, c.env.ENCRYPTION_KEY, body);
    await addMember(c.env.DB, ws.id, agent.id, "admin");
    // The identity secret is returned once; afterwards it can only be rotated.
    return c.json(ws, 201);
  })

  .get("/:workspaceId/members", requireMember(), async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT a.*, m.role FROM workspace_members m JOIN agents a ON a.id = m.agent_id WHERE m.workspace_id = ? ORDER BY a.name",
    )
      .bind(c.req.param("workspaceId"))
      .all<AgentRow & { role: "admin" | "agent" }>();
    const online = new Set(await inboxStub(c.env, c.req.param("workspaceId")).onlineAgentIds());
    return c.json(results.map((r) => ({ ...toAgent(r), role: r.role, online: online.has(r.id) })));
  })

  .post("/:workspaceId/members", requireMember("admin"), async (c) => {
    const body = await parseJson(c, InviteMember);
    const workspaceId = c.req.param("workspaceId");
    const agent = await ensureAgent(c.env.DB, body.email.trim(), body.name);
    await addMember(c.env.DB, workspaceId, agent.id, body.role);
    const ws = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
    // The member is added either way; the email is skipped if this address was mailed several
    // times recently (per-address cap), and the dashboard says so.
    const inviteEmailSent = await sendMagicLink(c.env, agent.email, "invite", ws?.name);
    return c.json({ ...toAgent(agent), role: body.role, inviteEmailSent }, 201);
  })

  .delete("/:workspaceId/members/:agentId", requireMember("admin"), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const agentId = c.req.param("agentId");
    if (agentId === c.get("agent").id) throw new ApiException(400, "cannot_remove_self", "You can't remove yourself");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND agent_id = ?").bind(workspaceId, agentId),
      c.env.DB.prepare("UPDATE conversations SET assignee_id = NULL WHERE workspace_id = ? AND assignee_id = ?").bind(workspaceId, agentId),
    ]);
    // Open dashboard sockets were authorized at connect time; cut them off now.
    await inboxStub(c.env, workspaceId).disconnectAgent(agentId);
    return c.body(null, 204);
  });
