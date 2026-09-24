-- Unread counters filter messages by time and author inside one conversation.
CREATE INDEX messages_conv_created ON messages(conversation_id, created_at, author_type);

-- Inbox keyset paging: (last_message_at, id) < (?, ?) needs both columns, ascending, after the
-- equality filters, or the planner seeks on recency and filters status row by row (scanning
-- every resolved conversation to fill the Open tab). One pair with status, one without.
DROP INDEX conversations_inbox;
DROP INDEX conversations_assignee;
CREATE INDEX conversations_ws_status_recent ON conversations(workspace_id, status, last_message_at, id);
CREATE INDEX conversations_ws_assignee_status_recent ON conversations(workspace_id, assignee_id, status, last_message_at, id);
CREATE INDEX conversations_ws_recent ON conversations(workspace_id, last_message_at, id);
CREATE INDEX conversations_ws_assignee_recent ON conversations(workspace_id, assignee_id, last_message_at, id);

CREATE INDEX faq_articles_workspace ON faq_articles(workspace_id, position);
CREATE INDEX workspace_members_agent ON workspace_members(agent_id);
CREATE INDEX magic_links_expires ON magic_links(expires_at);
CREATE INDEX agent_sessions_expires ON agent_sessions(expires_at);

-- Rebuild search as an external-content index keyed by the translation id, so trigger
-- deletes hit one row instead of scanning every workspace's index by UNINDEXED columns.
DROP TRIGGER faq_fts_insert;
DROP TRIGGER faq_fts_delete;
DROP TRIGGER faq_fts_update;
DROP TABLE faq_fts;

-- The content table gets an INTEGER PRIMARY KEY: FTS points at rows by rowid, and an implicit
-- rowid (composite TEXT primary key) may be renumbered by VACUUM or an export/import, which
-- would silently point search hits at other articles.
CREATE TABLE faq_article_translations_new (
  id INTEGER PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES faq_articles(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE (article_id, locale),
  UNIQUE (workspace_id, locale, slug)
);
INSERT INTO faq_article_translations_new (article_id, workspace_id, locale, slug, title, body_md, published, updated_at)
  SELECT article_id, workspace_id, locale, slug, title, body_md, published, updated_at FROM faq_article_translations;
DROP TABLE faq_article_translations;
ALTER TABLE faq_article_translations_new RENAME TO faq_article_translations;

-- workspace_id is an indexed column so a search can be scoped to one tenant inside the MATCH
-- itself (see searchArticles), instead of matching every tenant and filtering afterwards.
CREATE VIRTUAL TABLE faq_fts USING fts5(
  title, body_md, workspace_id,
  article_id UNINDEXED, locale UNINDEXED,
  content = 'faq_article_translations', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO faq_fts (faq_fts) VALUES ('rebuild');
-- Default ranking (title weighs 5x body; workspace_id is only a filter). With it, ORDER BY rank
-- runs inside FTS5, so LIMIT stops early and snippet() is only built for returned rows.
INSERT INTO faq_fts (faq_fts, rank) VALUES ('rank', 'bm25(5.0, 1.0, 0.0)');

CREATE TRIGGER faq_fts_insert AFTER INSERT ON faq_article_translations BEGIN
  INSERT INTO faq_fts (rowid, title, body_md, workspace_id, article_id, locale)
  VALUES (new.id, new.title, new.body_md, new.workspace_id, new.article_id, new.locale);
END;
CREATE TRIGGER faq_fts_delete AFTER DELETE ON faq_article_translations BEGIN
  INSERT INTO faq_fts (faq_fts, rowid, title, body_md, workspace_id, article_id, locale)
  VALUES ('delete', old.id, old.title, old.body_md, old.workspace_id, old.article_id, old.locale);
END;
CREATE TRIGGER faq_fts_update AFTER UPDATE OF title, body_md, workspace_id, article_id, locale ON faq_article_translations BEGIN
  INSERT INTO faq_fts (faq_fts, rowid, title, body_md, workspace_id, article_id, locale)
  VALUES ('delete', old.id, old.title, old.body_md, old.workspace_id, old.article_id, old.locale);
  INSERT INTO faq_fts (rowid, title, body_md, workspace_id, article_id, locale)
  VALUES (new.id, new.title, new.body_md, new.workspace_id, new.article_id, new.locale);
END;
