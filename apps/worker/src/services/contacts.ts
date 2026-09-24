import type { Contact, SessionRequest } from "@kobecuppens/livechat-protocol";
import { decryptString, hmacSha256Hex, timingSafeEqualStr } from "../lib/crypto";
import { ApiException } from "../lib/errors";
import { newId } from "../lib/ids";
import type { WorkspaceRow } from "./workspaces";

export interface ContactRow {
  id: string;
  workspace_id: string;
  external_id: string | null;
  device_id: string | null;
  email: string | null;
  name: string | null;
  locale: string | null;
  verified: number;
  merged_into: string | null;
  last_seen_at: number;
  created_at: number;
}

export function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    externalId: row.external_id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    verified: row.verified === 1,
  };
}

async function verifyUserHash(ws: WorkspaceRow, encryptionKey: string, userId: string, userHash: string) {
  const secret = await decryptString(encryptionKey, ws.identity_secret_enc);
  const expected = await hmacSha256Hex(secret, userId);
  if (!timingSafeEqualStr(expected, userHash)) {
    throw new ApiException(401, "invalid_user_hash", "userHash does not match userId");
  }
}

/**
 * Resolves (or creates) the contact for a session request.
 * - Anonymous: one contact per (workspace, deviceId).
 * - Verified: one contact per (workspace, userId). If `previousAnonymousId` is given
 *   (proven by the caller holding its token), its conversations move to the verified
 *   contact and the anonymous contact is detached from the device.
 */
export async function resolveContact(
  db: D1Database,
  ws: WorkspaceRow,
  encryptionKey: string,
  req: SessionRequest,
  previousAnonymousId: string | null,
): Promise<ContactRow> {
  const now = Date.now();

  if (req.userId && req.userHash) {
    await verifyUserHash(ws, encryptionKey, req.userId, req.userHash);
    // Upsert on the partial unique index; profile fields only overwrite when provided.
    await db
      .prepare(
        `INSERT INTO contacts (id, workspace_id, external_id, email, name, locale, verified, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (workspace_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           email = COALESCE(excluded.email, email),
           name = COALESCE(excluded.name, name),
           locale = COALESCE(excluded.locale, locale),
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(newId("ct"), ws.id, req.userId, req.email ?? null, req.name ?? null, req.locale ?? null, now, now)
      .run();
    const contact = await db
      .prepare("SELECT * FROM contacts WHERE workspace_id = ? AND external_id = ?")
      .bind(ws.id, req.userId)
      .first<ContactRow>();
    if (!contact) throw new Error("verified contact upsert failed");

    if (previousAnonymousId && previousAnonymousId !== contact.id) {
      await mergeAnonymousContact(db, ws.id, previousAnonymousId, contact.id);
    }
    return contact;
  }

  await db
    .prepare(
      `INSERT INTO contacts (id, workspace_id, device_id, email, name, locale, verified, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (workspace_id, device_id) WHERE external_id IS NULL AND device_id IS NOT NULL DO UPDATE SET
         email = COALESCE(excluded.email, email),
         name = COALESCE(excluded.name, name),
         locale = COALESCE(excluded.locale, locale),
         last_seen_at = excluded.last_seen_at`,
    )
    .bind(newId("ct"), ws.id, req.deviceId, req.email ?? null, req.name ?? null, req.locale ?? null, now, now)
    .run();
  const contact = await db
    .prepare("SELECT * FROM contacts WHERE workspace_id = ? AND device_id = ? AND external_id IS NULL")
    .bind(ws.id, req.deviceId)
    .first<ContactRow>();
  if (!contact) throw new Error("anonymous contact upsert failed");
  return contact;
}

async function mergeAnonymousContact(db: D1Database, workspaceId: string, fromId: string, intoId: string) {
  const from = await db
    .prepare("SELECT * FROM contacts WHERE id = ? AND workspace_id = ? AND external_id IS NULL AND merged_into IS NULL")
    .bind(fromId, workspaceId)
    .first<ContactRow>();
  if (!from) return;
  await db.batch([
    db.prepare("UPDATE conversations SET contact_id = ? WHERE contact_id = ?").bind(intoId, fromId),
    db.prepare("UPDATE push_devices SET contact_id = ? WHERE contact_id = ?").bind(intoId, fromId),
    // Detach from the device so logging out starts a fresh anonymous contact.
    db.prepare("UPDATE contacts SET merged_into = ?, device_id = NULL WHERE id = ?").bind(intoId, fromId),
    db
      .prepare("UPDATE contacts SET email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE id = ?")
      .bind(from.email, from.name, intoId),
  ]);
}
