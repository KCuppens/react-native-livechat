-- All timestamps are milliseconds since epoch (INTEGER).

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_color TEXT NOT NULL DEFAULT '#4F46E5',
  logo_url TEXT,
  greeting TEXT NOT NULL DEFAULT '{}',              -- JSON { locale: text }
  default_locale TEXT NOT NULL DEFAULT 'en',
  locales TEXT NOT NULL DEFAULT '["en"]',           -- JSON array
  office_hours TEXT NOT NULL DEFAULT '{"enabled":false,"timezone":"UTC","windows":[]}',
  auto_reply TEXT NOT NULL DEFAULT '{}',            -- JSON { locale: text } sent outside office hours
  typical_reply_minutes INTEGER,
  allowed_origins TEXT NOT NULL DEFAULT '[]',       -- JSON array; "*" allows any origin
  publishable_key TEXT NOT NULL UNIQUE,
  identity_secret_enc TEXT NOT NULL,                -- AES-GCM encrypted HMAC secret
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE agent_sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id TEXT,                                 -- host app user id, set only when verified
  device_id TEXT,                                   -- binds anonymous contacts to a device
  email TEXT,
  name TEXT,
  locale TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT REFERENCES contacts(id),
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX contacts_external ON contacts(workspace_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX contacts_anon_device ON contacts(workspace_id, device_id) WHERE external_id IS NULL AND device_id IS NOT NULL;

CREATE TABLE push_devices (
  token TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_id TEXT NOT NULL,
  sandbox INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX push_devices_contact ON push_devices(contact_id);

CREATE TABLE push_credentials (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fcm', 'apns')),
  secret_enc TEXT NOT NULL,                         -- AES-GCM encrypted JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, kind)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  last_message_id TEXT,
  last_message_at INTEGER NOT NULL,
  contact_last_read_at INTEGER NOT NULL DEFAULT 0,
  agent_last_read_at INTEGER NOT NULL DEFAULT 0,
  csat_score INTEGER CHECK (csat_score BETWEEN 1 AND 5),
  csat_comment TEXT,
  auto_replied_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX conversations_contact ON conversations(contact_id, last_message_at DESC);
CREATE INDEX conversations_inbox ON conversations(workspace_id, status, last_message_at DESC);
CREATE INDEX conversations_assignee ON conversations(workspace_id, assignee_id, status, last_message_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_id TEXT,
  author_type TEXT NOT NULL CHECK (author_type IN ('contact', 'agent', 'system')),
  author_id TEXT,
  body TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',           -- JSON Attachment[]
  system_event TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, id);
CREATE UNIQUE INDEX messages_client_id ON messages(conversation_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  uploader_type TEXT NOT NULL CHECK (uploader_type IN ('contact', 'agent')),
  uploader_id TEXT NOT NULL,
  message_id TEXT,                                  -- NULL until attached to a message
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE canned_replies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, shortcut)
);

CREATE TABLE faq_categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  icon TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  titles TEXT NOT NULL DEFAULT '{}',                -- JSON { locale: title }
  descriptions TEXT NOT NULL DEFAULT '{}',          -- JSON { locale: description }
  UNIQUE (workspace_id, slug)
);

CREATE TABLE faq_articles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES faq_categories(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  unhelpful_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE faq_article_translations (
  article_id TEXT NOT NULL REFERENCES faq_articles(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, locale),
  UNIQUE (workspace_id, locale, slug)
);

-- Full-text index over translations; kept in sync by triggers.
CREATE VIRTUAL TABLE faq_fts USING fts5(
  title, body_md,
  article_id UNINDEXED, locale UNINDEXED, workspace_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER faq_fts_insert AFTER INSERT ON faq_article_translations BEGIN
  INSERT INTO faq_fts (title, body_md, article_id, locale, workspace_id)
  VALUES (new.title, new.body_md, new.article_id, new.locale, new.workspace_id);
END;
CREATE TRIGGER faq_fts_delete AFTER DELETE ON faq_article_translations BEGIN
  DELETE FROM faq_fts WHERE article_id = old.article_id AND locale = old.locale;
END;
CREATE TRIGGER faq_fts_update AFTER UPDATE OF title, body_md ON faq_article_translations BEGIN
  DELETE FROM faq_fts WHERE article_id = old.article_id AND locale = old.locale;
  INSERT INTO faq_fts (title, body_md, article_id, locale, workspace_id)
  VALUES (new.title, new.body_md, new.article_id, new.locale, new.workspace_id);
END;
