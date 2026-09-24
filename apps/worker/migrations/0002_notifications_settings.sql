ALTER TABLE workspaces ADD COLUMN csat_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN last_emailed_at INTEGER;
CREATE INDEX conversations_resolved ON conversations(workspace_id, status, csat_score);
