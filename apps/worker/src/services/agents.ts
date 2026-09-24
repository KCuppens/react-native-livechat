import type { Agent, AgentMe, AgentRole } from "@kobecuppens/livechat-protocol";
import type { Env } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { newId } from "../lib/ids";
import { emailLayout, sendEmail } from "../lib/mailer";

export interface AgentRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
}

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
/** At most this many sign-in/invite emails per address per window. */
const MAGIC_LINKS_PER_WINDOW = 3;
const MAGIC_LINK_WINDOW_MS = 10 * 60 * 1000;
export const AGENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function toAgent(row: AgentRow): Agent {
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
}

export function isSuperAdmin(env: Env, email: string): boolean {
  return (env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

export function getAgentByEmail(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM agents WHERE email = ?").bind(email).first<AgentRow>();
}

export async function ensureAgent(db: D1Database, email: string, name?: string): Promise<AgentRow> {
  await db
    .prepare("INSERT INTO agents (id, email, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(newId("ag"), email, name ?? email.split("@")[0]!, Date.now())
    .run();
  return (await getAgentByEmail(db, email))!;
}

/**
 * Emails a sign-in link if the address belongs to an agent or super admin. Callers must
 * respond identically either way so the endpoint doesn't reveal who has an account.
 */
export async function sendMagicLink(env: Env, email: string, reason: "login" | "invite", workspaceName?: string): Promise<boolean> {
  const known = (await getAgentByEmail(env.DB, email)) ?? (isSuperAdmin(env, email) ? await ensureAgent(env.DB, email) : null);
  if (!known) return false;

  // Per-recipient cap (the route limit is per IP, which rotating IPs bypass), so nobody can flood
  // an address or burn email quota. Only unused links count: someone who actually signs in can
  // always ask again. Check and insert are one statement, so concurrent requests can't all pass.
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO magic_links (token_hash, email, expires_at)
     SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM magic_links WHERE email = ?2 AND used_at IS NULL AND expires_at > ?4) < ?5`,
  )
    .bind(tokenHash, known.email, now + MAGIC_LINK_TTL_MS, now + MAGIC_LINK_TTL_MS - MAGIC_LINK_WINDOW_MS, MAGIC_LINKS_PER_WINDOW)
    .run();
  if (inserted.meta.changes === 0) {
    console.warn({ msg: "magic link cap reached", reason });
    // Returns false: the login route stays silent (no account enumeration); the invite route
    // tells the admin the email was not sent.
    return false;
  }
  // Token lives in the fragment so it never reaches server logs or Referer headers.
  const url = `${env.PUBLIC_URL}/login/verify#token=${token}`;
  const invite = reason === "invite";
  // A link that was never delivered must not count toward the cap above.
  const forget = () =>
    env.DB.prepare("DELETE FROM magic_links WHERE token_hash = ?")
      .bind(tokenHash)
      .run()
      .catch((e) => console.error({ msg: "undelivered magic link cleanup failed", error: String(e) }));
  await sendEmail(env, {
    to: known.email,
    subject: invite ? `You're invited to ${workspaceName ?? "a support workspace"}` : "Your sign-in link",
    text: `${invite ? `You've been invited to answer support conversations for ${workspaceName}.` : "Use this link to sign in."}\n\n${url}\n\nThe link expires in 15 minutes and can be used once.`,
    html: emailLayout({
      heading: invite ? `Join ${workspaceName ?? "the team"}` : "Sign in to Support",
      paragraphs: [
        invite ? `You've been invited to answer support conversations for ${workspaceName}.` : "Click the button below to sign in.",
        "The link expires in 15 minutes and can be used once.",
      ],
      button: { label: invite ? "Accept invite" : "Sign in", url },
    }),
  }).catch(async (err: unknown) => {
    await forget();
    throw err;
  });
  return true;
}

/** Consumes a magic link and returns a new session token, or null if invalid/expired/used. */
export async function consumeMagicLink(db: D1Database, token: string): Promise<{ agent: AgentRow; sessionToken: string } | null> {
  const hash = await sha256Hex(token);
  const now = Date.now();
  const link = await db
    .prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email")
    .bind(now, hash, now)
    .first<{ email: string }>();
  if (!link) return null;
  const agent = await getAgentByEmail(db, link.email);
  if (!agent) return null;

  const sessionToken = randomToken(32);
  await db.batch([
    db.prepare("INSERT INTO agent_sessions (token_hash, agent_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(sessionToken), agent.id, now + AGENT_SESSION_TTL_MS, now),
    db.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM agent_sessions WHERE expires_at < ?").bind(now),
  ]);
  return { agent, sessionToken };
}

export async function agentForSession(db: D1Database, sessionToken: string): Promise<AgentRow | null> {
  return db
    .prepare("SELECT a.* FROM agent_sessions s JOIN agents a ON a.id = s.agent_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .bind(await sha256Hex(sessionToken), Date.now())
    .first<AgentRow>();
}

/** Short, non-reversible id of a session, used to tag its live sockets. */
export async function sessionTag(sessionToken: string): Promise<string> {
  return `session:${(await sha256Hex(`socket:${sessionToken}`)).slice(0, 24)}`;
}

export async function deleteSession(db: D1Database, sessionToken: string): Promise<void> {
  await db.prepare("DELETE FROM agent_sessions WHERE token_hash = ?").bind(await sha256Hex(sessionToken)).run();
}

export async function agentMe(env: Env, agent: AgentRow): Promise<AgentMe> {
  const { results } = await env.DB.prepare(
    "SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.agent_id = ? ORDER BY w.name",
  )
    .bind(agent.id)
    .all<{ id: string; name: string; role: AgentRole }>();
  return { agent: toAgent(agent), superAdmin: isSuperAdmin(env, agent.email), workspaces: results };
}

export function getMembership(db: D1Database, workspaceId: string, agentId: string) {
  return db
    .prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND agent_id = ?")
    .bind(workspaceId, agentId)
    .first<{ role: AgentRole }>();
}

export async function addMember(db: D1Database, workspaceId: string, agentId: string, role: AgentRole) {
  await db
    .prepare(
      "INSERT INTO workspace_members (workspace_id, agent_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role",
    )
    .bind(workspaceId, agentId, role, Date.now())
    .run();
}
