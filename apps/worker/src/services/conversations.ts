import type {
  Attachment,
  AuthorType,
  Conversation,
  ConversationStatus,
  Message,
  SystemEvent,
} from "@kobecuppens/livechat-protocol";
import { ApiException } from "../lib/errors";
import { newId } from "../lib/ids";

export interface ConversationRow {
  id: string;
  workspace_id: string;
  contact_id: string;
  status: ConversationStatus;
  assignee_id: string | null;
  last_message_id: string | null;
  last_message_at: number;
  contact_last_read_at: number;
  agent_last_read_at: number;
  csat_score: number | null;
  csat_comment: string | null;
  auto_replied_at: number | null;
  last_emailed_at: number | null;
  first_client_id: string | null;
  csat_requested_at: number | null;
  created_at: number;
}

/** Message row joined with author display fields. */
export interface MessageRow {
  id: string;
  conversation_id: string;
  client_id: string | null;
  author_type: AuthorType;
  author_id: string | null;
  body: string;
  attachments: string;
  system_event: SystemEvent | null;
  created_at: number;
  author_name: string | null;
  author_avatar: string | null;
}

const MESSAGE_SELECT = `
  SELECT m.*,
    CASE m.author_type WHEN 'agent' THEN a.name WHEN 'contact' THEN ct.name END AS author_name,
    CASE m.author_type WHEN 'agent' THEN a.avatar_url END AS author_avatar
  FROM messages m
  LEFT JOIN agents a ON m.author_type = 'agent' AND a.id = m.author_id
  LEFT JOIN contacts ct ON m.author_type = 'contact' AND ct.id = m.author_id`;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    clientId: row.client_id,
    authorType: row.author_type,
    author:
      row.author_type === "system"
        ? null
        : { id: row.author_id, name: row.author_name, avatarUrl: row.author_avatar },
    body: row.body,
    attachments: JSON.parse(row.attachments) as Attachment[],
    systemEvent: row.system_event,
    createdAt: row.created_at,
  };
}

export async function getMessage(db: D1Database, id: string): Promise<Message | null> {
  const row = await db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(id).first<MessageRow>();
  return row ? toMessage(row) : null;
}

/**
 * Joins a conversation's last message (and its author) so list views need one query,
 * not one per row. Columns come back prefixed with `lm_`.
 */
export const LAST_MESSAGE_COLUMNS = `
    lm.id AS lm_id, lm.client_id AS lm_client_id, lm.author_type AS lm_author_type, lm.author_id AS lm_author_id,
    lm.body AS lm_body, lm.attachments AS lm_attachments, lm.system_event AS lm_system_event, lm.created_at AS lm_created_at,
    CASE lm.author_type WHEN 'agent' THEN la.name WHEN 'contact' THEN lc.name END AS lm_author_name,
    CASE lm.author_type WHEN 'agent' THEN la.avatar_url END AS lm_author_avatar`;

export const LAST_MESSAGE_JOINS = `
  LEFT JOIN messages lm ON lm.id = c.last_message_id
  LEFT JOIN agents la ON lm.author_type = 'agent' AND la.id = lm.author_id
  LEFT JOIN contacts lc ON lm.author_type = 'contact' AND lc.id = lm.author_id`;

export interface LastMessageColumns {
  lm_id: string | null;
  lm_client_id: string | null;
  lm_author_type: AuthorType | null;
  lm_author_id: string | null;
  lm_body: string | null;
  lm_attachments: string | null;
  lm_system_event: SystemEvent | null;
  lm_created_at: number | null;
  lm_author_name: string | null;
  lm_author_avatar: string | null;
}

export function lastMessageFromRow(row: ConversationRow & LastMessageColumns): Message | null {
  if (!row.lm_id) return null;
  return toMessage({
    id: row.lm_id,
    conversation_id: row.id,
    client_id: row.lm_client_id,
    author_type: row.lm_author_type!,
    author_id: row.lm_author_id,
    body: row.lm_body ?? "",
    attachments: row.lm_attachments ?? "[]",
    system_event: row.lm_system_event,
    created_at: row.lm_created_at ?? 0,
    author_name: row.lm_author_name,
    author_avatar: row.lm_author_avatar,
  });
}

/**
 * Keyset cursor for lists ordered by (last_message_at DESC, id DESC). The id breaks ties so
 * conversations sharing a timestamp are never skipped between pages.
 */
export function parseRecencyCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf(":");
  const at = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (sep <= 0 || !Number.isSafeInteger(at) || !id) throw new ApiException(400, "invalid_cursor", "Invalid cursor");
  return { at, id };
}

/** Row-value comparison: SQLite runs it as a single index range seek (an OR can't be). */
export const RECENCY_CURSOR_WHERE = "(c.last_message_at, c.id) < (?, ?)";

export function recencyCursorBinds(cursor: { at: number; id: string } | null): unknown[] {
  // First page: sort key above any real row ("~" sorts after every id character).
  return cursor ? [cursor.at, cursor.id] : [Number.MAX_SAFE_INTEGER, "~"];
}

export function nextRecencyCursor(page: ConversationRow[], hasMore: boolean): string | null {
  const last = page[page.length - 1];
  return hasMore && last ? `${last.last_message_at}:${last.id}` : null;
}

/** Conversation row plus the fields needed for the contact-facing DTO. */
interface ConversationViewRow extends ConversationRow, LastMessageColumns {
  assignee_name: string | null;
  assignee_avatar: string | null;
  unread_count: number;
}

const CONTACT_CONVERSATION_SELECT = `
  SELECT c.*, a.name AS assignee_name, a.avatar_url AS assignee_avatar,
    (SELECT COUNT(*) FROM messages m
      WHERE m.conversation_id = c.id AND m.author_type != 'contact' AND m.created_at > c.contact_last_read_at) AS unread_count,
    ${LAST_MESSAGE_COLUMNS}
  FROM conversations c
  LEFT JOIN agents a ON a.id = c.assignee_id
  ${LAST_MESSAGE_JOINS}`;

function toConversation(row: ConversationViewRow): Conversation {
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
    createdAt: row.created_at,
  };
}

export async function getContactConversation(db: D1Database, contactId: string, conversationId: string) {
  const row = await db
    .prepare(`${CONTACT_CONVERSATION_SELECT} WHERE c.id = ? AND c.contact_id = ?`)
    .bind(conversationId, contactId)
    .first<ConversationViewRow>();
  if (!row) throw new ApiException(404, "conversation_not_found", "Conversation not found");
  return { row: row as ConversationRow, dto: toConversation(row) };
}

/** Cheap ownership check for routes that only need the raw row. */
export async function getContactConversationRow(db: D1Database, contactId: string, conversationId: string): Promise<ConversationRow> {
  const row = await db
    .prepare("SELECT * FROM conversations WHERE id = ? AND contact_id = ?")
    .bind(conversationId, contactId)
    .first<ConversationRow>();
  if (!row) throw new ApiException(404, "conversation_not_found", "Conversation not found");
  return row;
}

export async function listContactConversations(db: D1Database, contactId: string, cursor: string | null, limit: number) {
  const { results } = await db
    .prepare(`${CONTACT_CONVERSATION_SELECT} WHERE c.contact_id = ? AND ${RECENCY_CURSOR_WHERE} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`)
    .bind(contactId, ...recencyCursorBinds(parseRecencyCursor(cursor)), limit + 1)
    .all<ConversationViewRow>();
  const page = results.slice(0, limit);
  return { items: page.map(toConversation), nextCursor: nextRecencyCursor(page, results.length > limit) };
}

/**
 * Messages in ascending order. `before` pages backwards: it's the id of the oldest message
 * the client already has (ids are time-sortable); nextCursor is set when older messages remain.
 */
export async function listMessages(db: D1Database, conversationId: string, before: string | null, limit: number) {
  // Two statements, not `(? IS NULL OR m.id < ?)`: the OR would stop SQLite from seeking the
  // (conversation_id, id) index to the cursor, making older pages scan every newer message.
  const stmt = before
    ? db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).bind(conversationId, before, limit + 1)
    : db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT ?`).bind(conversationId, limit + 1);
  const { results } = await stmt.all<MessageRow>();
  const page = results.slice(0, limit).reverse();
  return {
    items: page.map(toMessage),
    nextCursor: results.length > limit ? page[0]!.id : null,
  };
}

export async function unreadCountForContact(db: D1Database, contactId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.contact_id = ? AND m.author_type != 'contact' AND m.created_at > c.contact_last_read_at`,
    )
    .bind(contactId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Atomically claims uploaded attachments for message `messageId`. They must belong to the
 * uploader, be in the same workspace and not be on another message. The UPDATE's own
 * `message_id IS NULL` guard makes two concurrent sends unable to claim the same file.
 */
async function claimAttachments(
  db: D1Database,
  messageId: string,
  workspaceId: string,
  uploader: { type: "contact" | "agent"; id: string },
  attachmentIds: string[],
  { reclaimOrphans = false } = {},
): Promise<Attachment[]> {
  const unique = [...new Set(attachmentIds)];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(",");
  // An orphan is a claim for a message that was never saved (the isolate died between claim and
  // insert, or the release failed). Only taken over once a clientId retry proved nobody else holds it.
  const free = reclaimOrphans ? "(message_id IS NULL OR message_id NOT IN (SELECT id FROM messages))" : "message_id IS NULL";
  const { results } = await db
    .prepare(
      `UPDATE attachments SET message_id = ?
       WHERE id IN (${placeholders}) AND workspace_id = ? AND uploader_type = ? AND uploader_id = ? AND ${free}
       RETURNING id, name, content_type, size, width, height`,
    )
    .bind(messageId, ...unique, workspaceId, uploader.type, uploader.id)
    .all<{ id: string; name: string; content_type: string; size: number; width: number | null; height: number | null }>();
  if (results.length !== unique.length) {
    await releaseAttachments(db, messageId, results.map((r) => r.id));
    throw new ApiException(400, "invalid_attachment", "One or more attachments are invalid or already used");
  }
  return unique.map((id) => {
    const a = results.find((r) => r.id === id)!;
    return {
      id: a.id,
      name: a.name,
      contentType: a.content_type,
      size: a.size,
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
    };
  });
}

/**
 * Undoes a claim when the message it was for is not saved. Keyed by primary key (attachments has
 * no message_id index). Never throws: it runs on error paths, where the original error matters more.
 */
async function releaseAttachments(db: D1Database, messageId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare(`UPDATE attachments SET message_id = NULL WHERE message_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(messageId, ...ids)
    .run()
    .catch((e) => console.error({ msg: "attachment release failed", messageId, error: String(e) }));
}

const RETRY_LOOKUP_DELAYS_MS = [100, 250, 500];

export interface InsertMessageInput {
  conversationId: string;
  workspaceId: string;
  authorType: AuthorType;
  authorId: string | null;
  clientId: string | null;
  body: string;
  attachmentIds?: string[];
  systemEvent?: SystemEvent | null;
  /**
   * Extra writes committed atomically with the message (e.g. reopening the conversation). Their
   * results come back as `extraResults` when the message is created.
   */
  extra?: D1PreparedStatement[];
}

/** Finds a message by its client-generated id (retry detection). */
export async function getMessageByClientId(db: D1Database, conversationId: string, clientId: string): Promise<Message | null> {
  const row = await db
    .prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.client_id = ?`)
    .bind(conversationId, clientId)
    .first<MessageRow>();
  return row ? toMessage(row) : null;
}

/**
 * Inserts a message and bumps the conversation, in one batch that also reads the saved message
 * back. Idempotent on (conversation, clientId): a retry returns the existing message with
 * `created: false` (via the unique index, so the common case costs one round trip).
 */
export async function insertMessage(
  db: D1Database,
  input: InsertMessageInput,
): Promise<{ message: Message; created: boolean; extraResults: D1Result[] }> {
  const hasAttachments = (input.attachmentIds?.length ?? 0) > 0;
  // Only needed before claiming attachments: a retry must not try to claim its own files again.
  if (input.clientId && hasAttachments) {
    const existing = await getMessageByClientId(db, input.conversationId, input.clientId);
    if (existing) return { message: existing, created: false, extraResults: [] };
  }

  const id = newId("msg");
  const now = Date.now();
  let attachments: Attachment[] = [];
  if (input.authorType !== "system") {
    const uploader = { type: input.authorType, id: input.authorId! };
    try {
      attachments = await claimAttachments(db, id, input.workspaceId, uploader, input.attachmentIds ?? []);
    } catch (err) {
      if (!input.clientId || !(err instanceof ApiException)) throw err;
      // A concurrent request with the same clientId may hold the files and still be inserting:
      // give it a moment, and answer with its message instead of "invalid attachment".
      for (const delay of RETRY_LOOKUP_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay));
        const existing = await getMessageByClientId(db, input.conversationId, input.clientId);
        if (existing) return { message: existing, created: false, extraResults: [] };
      }
      // Nobody saved it: any claim left on these files is an orphan from a failed attempt.
      attachments = await claimAttachments(db, id, input.workspaceId, uploader, input.attachmentIds ?? [], { reclaimOrphans: true });
    }
  }
  const statements = [
    db
      .prepare(
        `INSERT INTO messages (id, conversation_id, client_id, author_type, author_id, body, attachments, system_event, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.conversationId,
        input.clientId,
        input.authorType,
        input.authorId,
        input.body,
        JSON.stringify(attachments),
        input.systemEvent ?? null,
        now,
      ),
    db
      // Forward-only: ids are time-sortable, so a slower concurrent insert of an older message
      // can't move the preview/ordering backwards.
      .prepare("UPDATE conversations SET last_message_id = ?1, last_message_at = ?2 WHERE id = ?3 AND (last_message_id IS NULL OR last_message_id < ?1)")
      .bind(id, now, input.conversationId),
    ...(input.extra ?? []),
    // Read back in the same batch (author name/avatar joined): no extra round trip.
    db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(id),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (err) {
    await releaseAttachments(db, id, attachments.map((a) => a.id));
    // A parallel retry with the same clientId won the unique index: return its message.
    if (input.clientId && String(err).includes("UNIQUE")) {
      const existing = await getMessageByClientId(db, input.conversationId, input.clientId);
      if (existing) return { message: existing, created: false, extraResults: [] };
    }
    throw err;
  }
  const row = (results.at(-1) as D1Result<MessageRow>).results[0]!;
  return { message: toMessage(row), created: true, extraResults: results.slice(2, -1) };
}

/**
 * Creates a conversation keyed by the first message's clientId. The unique index on
 * (contact_id, first_client_id) makes concurrent retries converge on one conversation:
 * the loser gets `created: false` and the winner's id.
 */
export async function createConversation(
  db: D1Database,
  workspaceId: string,
  contactId: string,
  firstClientId: string,
): Promise<{ id: string; created: boolean }> {
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO conversations (id, workspace_id, contact_id, first_client_id, last_message_at, contact_last_read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (contact_id, first_client_id) WHERE first_client_id IS NOT NULL DO NOTHING
       RETURNING id`,
    )
    .bind(newId("cv"), workspaceId, contactId, firstClientId, now, now, now)
    .first<{ id: string }>();
  if (inserted) return { id: inserted.id, created: true };
  const existing = await findConversationByFirstClientId(db, contactId, firstClientId);
  if (!existing) throw new Error("conversation insert conflicted but no row found");
  return { id: existing, created: false };
}

/** Finds a conversation this contact already started with `clientId` (retry of POST /conversations). */
export async function findConversationByFirstClientId(db: D1Database, contactId: string, clientId: string) {
  const row = await db
    .prepare("SELECT id FROM conversations WHERE contact_id = ? AND first_client_id = ?")
    .bind(contactId, clientId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Claims the right to ask for a rating: true for exactly one caller per conversation, so two
 * agents resolving at the same instant can't both post a rating request.
 */
export async function claimCsatRequest(db: D1Database, conversationId: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE conversations SET csat_requested_at = ? WHERE id = ? AND csat_requested_at IS NULL")
    .bind(Date.now(), conversationId)
    .run();
  return res.meta.changes === 1;
}
