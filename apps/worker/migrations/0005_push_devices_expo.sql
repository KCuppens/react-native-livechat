-- Expo push tokens (platform 'expo'): SQLite can't alter a CHECK constraint in place.
CREATE TABLE push_devices_new (
  token TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'expo')),
  app_id TEXT NOT NULL,
  sandbox INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT INTO push_devices_new (token, contact_id, workspace_id, platform, app_id, sandbox, updated_at)
  SELECT token, contact_id, workspace_id, platform, app_id, sandbox, updated_at FROM push_devices;
DROP TABLE push_devices;
ALTER TABLE push_devices_new RENAME TO push_devices;
CREATE INDEX push_devices_contact ON push_devices(contact_id);
