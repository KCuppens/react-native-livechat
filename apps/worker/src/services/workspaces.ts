import {
  type Branding,
  isWithinOfficeHours,
  type OfficeHours,
  type WorkspaceConfig,
} from "@kobecuppens/livechat-protocol";
import { encryptString, randomToken } from "../lib/crypto";
import { newId } from "../lib/ids";

export interface WorkspaceRow {
  id: string;
  name: string;
  primary_color: string;
  logo_url: string | null;
  greeting: string;
  default_locale: string;
  locales: string;
  office_hours: string;
  auto_reply: string;
  typical_reply_minutes: number | null;
  allowed_origins: string;
  publishable_key: string;
  identity_secret_enc: string;
  csat_enabled: number;
  contact_token_epoch: number;
  created_at: number;
}

/**
 * Per-isolate cache for the publishable-key lookup, which runs on every public request (unread
 * polls, config, FAQ, sockets). Writes in this isolate invalidate it immediately; other isolates
 * pick up changes within WORKSPACE_CACHE_TTL_MS.
 */
const WORKSPACE_CACHE_TTL_MS = 30_000;
const WORKSPACE_CACHE_MAX = 500;
const workspaceCache = new Map<string, { ws: WorkspaceRow; exp: number }>();

export async function getWorkspaceByKey(db: D1Database, publishableKey: string): Promise<WorkspaceRow | null> {
  const hit = workspaceCache.get(publishableKey);
  if (hit && hit.exp > Date.now()) return hit.ws;
  const ws = await db.prepare("SELECT * FROM workspaces WHERE publishable_key = ?").bind(publishableKey).first<WorkspaceRow>();
  if (ws) {
    if (workspaceCache.size >= WORKSPACE_CACHE_MAX) workspaceCache.delete(workspaceCache.keys().next().value!);
    workspaceCache.set(publishableKey, { ws, exp: Date.now() + WORKSPACE_CACHE_TTL_MS });
  }
  return ws;
}

/**
 * Re-reads a workspace past the cache. For the rare paths that must see the latest secret and
 * token epoch (signing sessions, and a token newer than this isolate's cached copy).
 */
export async function refreshWorkspace(db: D1Database, ws: WorkspaceRow): Promise<WorkspaceRow> {
  invalidateWorkspace(ws.id);
  return (await getWorkspaceByKey(db, ws.publishable_key)) ?? ws;
}

/** Drops a workspace from the key cache after its settings/secrets change. */
export function invalidateWorkspace(workspaceId: string): void {
  for (const [key, entry] of workspaceCache) if (entry.ws.id === workspaceId) workspaceCache.delete(key);
}

export function allowedOrigins(ws: WorkspaceRow): string[] {
  return JSON.parse(ws.allowed_origins) as string[];
}

export function toWorkspaceConfig(ws: WorkspaceRow, now = new Date()): WorkspaceConfig {
  const officeHours = JSON.parse(ws.office_hours) as OfficeHours;
  const branding: Branding = {
    name: ws.name,
    primaryColor: ws.primary_color,
    logoUrl: ws.logo_url,
    greeting: JSON.parse(ws.greeting) as Record<string, string>,
  };
  return {
    workspaceId: ws.id,
    branding,
    defaultLocale: ws.default_locale,
    locales: JSON.parse(ws.locales) as string[],
    officeHours,
    online: isWithinOfficeHours(officeHours, now),
    typicalReplyMinutes: ws.typical_reply_minutes,
  };
}

export interface CreateWorkspaceInput {
  name: string;
  defaultLocale?: string;
  locales?: string[];
  allowedOrigins?: string[];
}

/** Creates a workspace and returns it with the plaintext identity secret (shown to the admin once). */
export async function createWorkspace(db: D1Database, encryptionKey: string, input: CreateWorkspaceInput) {
  const id = newId("ws");
  const publishableKey = `pk_${randomToken(18)}`;
  const identitySecret = `sk_id_${randomToken(24)}`;
  const defaultLocale = input.defaultLocale ?? "en";
  await db
    .prepare(
      `INSERT INTO workspaces (id, name, default_locale, locales, allowed_origins, publishable_key, identity_secret_enc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      defaultLocale,
      JSON.stringify(input.locales ?? [defaultLocale]),
      JSON.stringify(input.allowedOrigins ?? []),
      publishableKey,
      await encryptString(encryptionKey, identitySecret),
      Date.now(),
    )
    .run();
  return { id, publishableKey, identitySecret };
}

/** Nullable lookup for background jobs, where a deleted workspace means "nothing to do". */
export function findWorkspaceById(db: D1Database, id: string): Promise<WorkspaceRow | null> {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<WorkspaceRow>();
}

export async function getWorkspaceById(db: D1Database, id: string): Promise<WorkspaceRow> {
  const ws = await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<WorkspaceRow>();
  if (!ws) throw new Error(`workspace ${id} not found`);
  return ws;
}
