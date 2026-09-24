-- Idempotent conversation start: the first message's clientId, unique per contact, so two
-- concurrent retries can't both create a conversation (agent2-005).
ALTER TABLE conversations ADD COLUMN first_client_id TEXT;
UPDATE conversations SET first_client_id = (
  SELECT m.client_id FROM messages m WHERE m.conversation_id = conversations.id AND m.author_type = 'contact' ORDER BY m.id LIMIT 1
);
-- Backfill before the index: if old data repeats a (contact, clientId) pair, keep it on the oldest
-- conversation only, so the unique index can't fail the migration.
UPDATE conversations SET first_client_id = NULL
WHERE first_client_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM conversations o
  WHERE o.contact_id = conversations.contact_id AND o.first_client_id = conversations.first_client_id AND o.id < conversations.id
);
CREATE UNIQUE INDEX conversations_first_client ON conversations(contact_id, first_client_id) WHERE first_client_id IS NOT NULL;

-- The rating request is claimed with a conditional UPDATE so it's asked at most once (agent2-006).
ALTER TABLE conversations ADD COLUMN csat_requested_at INTEGER;
UPDATE conversations SET csat_requested_at = (
  SELECT MIN(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id AND m.system_event = 'csat_request'
);

-- Contact tokens carry the workspace epoch; bumping it (identity secret rotation) revokes them (agent5-010).
ALTER TABLE workspaces ADD COLUMN contact_token_epoch INTEGER NOT NULL DEFAULT 0;

-- Reports filter by creation time (agent3-001); conversations_resolved was never used (agent3-015).
CREATE INDEX conversations_ws_created ON conversations(workspace_id, created_at);
DROP INDEX conversations_resolved;
