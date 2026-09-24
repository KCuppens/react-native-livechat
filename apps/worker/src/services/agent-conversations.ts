import type { AgentConversation, ConversationStatus } from "@kobecuppens/livechat-protocol";
import { ApiException } from "../lib/errors";
import {
  LAST_MESSAGE_COLUMNS,
  LAST_MESSAGE_JOINS,
  lastMessageFromRow,
  nextRecencyCursor,
  parseRecencyCursor,
  RECENCY_CURSOR_WHERE,
  recencyCursorBinds,
  type ConversationRow,
  type LastMessageColumns,
} from "./conversations";

interface AgentConversationRow extends ConversationRow, LastMessageColumns {
  assignee_name: string | null;
  assignee_avatar: string | null;
  contact_external_id: string | null;
  contact_email: string | null;
  contact_name: string | null;
  contact_locale: string | null;
  contact_verified: number;
  contact_last_seen_at: number;
  unread_count: number;
}

const SELECT = `
  SELECT c.*, a.name AS assignee_name, a.avatar_url AS assignee_avatar,
    ct.external_id AS contact_external_id, ct.email AS contact_email, ct.name AS contact_name,
    ct.locale AS contact_locale, ct.verified AS contact_verified, ct.last_seen_at AS contact_last_seen_at,
    (SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id = c.id AND m.author_type = 'contact' AND m.created_at > c.agent_last_read_at) AS unread_count,
    ${LAST_MESSAGE_COLUMNS}
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN agents a ON a.id = c.assignee_id
  ${LAST_MESSAGE_JOINS}`;

function toAgentConversation(row: AgentConversationRow): AgentConversation {
  return {
    id: row.id,
    status: row.status,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, avatarUrl: row.assignee_avatar } : null,
    lastMessage: lastMessageFromRow(row),
    lastMessageAt: row.last_message_at,
    contactLastReadAt: row.contact_last_read_at,
    agentLastReadAt: row.agent_last_read_at,
    unreadCount: row.unread_count,
    csatScore: row.csat_score,
    csatComment: row.csat_comment,
    createdAt: row.created_at,
    contact: {
      id: row.contact_id,
      externalId: row.contact_external_id,
      email: row.contact_email,
      name: row.contact_name,
      locale: row.contact_locale,
      verified: row.contact_verified === 1,
      lastSeenAt: row.contact_last_seen_at,
    },
  };
}

export async function getAgentConversation(db: D1Database, workspaceId: string, conversationId: string) {
  const row = await db
    .prepare(`${SELECT} WHERE c.id = ? AND c.workspace_id = ?`)
    .bind(conversationId, workspaceId)
    .first<AgentConversationRow>();
  if (!row) throw new ApiException(404, "conversation_not_found", "Conversation not found");
  return { row: row as ConversationRow, dto: toAgentConversation(row) };
}

/** Cheap tenancy check for routes that only need the raw row. */
export async function getAgentConversationRow(db: D1Database, workspaceId: string, conversationId: string): Promise<ConversationRow> {
  const row = await db
    .prepare("SELECT * FROM conversations WHERE id = ? AND workspace_id = ?")
    .bind(conversationId, workspaceId)
    .first<ConversationRow>();
  if (!row) throw new ApiException(404, "conversation_not_found", "Conversation not found");
  return row;
}

export async function listInbox(
  db: D1Database,
  workspaceId: string,
  agentId: string,
  filter: { status?: ConversationStatus; assignee: "me" | "unassigned" | "all"; cursor?: string },
  limit = 30,
) {
  const where = ["c.workspace_id = ?", RECENCY_CURSOR_WHERE];
  const binds: unknown[] = [workspaceId, ...recencyCursorBinds(parseRecencyCursor(filter.cursor))];
  if (filter.status) {
    where.push("c.status = ?");
    binds.push(filter.status);
  }
  if (filter.assignee === "me") {
    where.push("c.assignee_id = ?");
    binds.push(agentId);
  } else if (filter.assignee === "unassigned") {
    where.push("c.assignee_id IS NULL");
  }
  const { results } = await db
    .prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<AgentConversationRow>();
  const page = results.slice(0, limit);
  return { items: page.map(toAgentConversation), nextCursor: nextRecencyCursor(page, results.length > limit) };
}
