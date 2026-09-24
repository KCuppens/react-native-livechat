import type { Env } from "../env";
import { decryptString, encryptString } from "../lib/crypto";
import type { ApnsCredentials, FcmCredentials } from "./types";

export async function savePushCredentials(env: Env, workspaceId: string, kind: "fcm" | "apns", value: FcmCredentials | ApnsCredentials) {
  await env.DB.prepare(
    `INSERT INTO push_credentials (workspace_id, kind, secret_enc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, kind) DO UPDATE SET secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, kind, await encryptString(env.ENCRYPTION_KEY, JSON.stringify(value)), Date.now())
    .run();
}

export async function loadPushCredentials(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare("SELECT kind, secret_enc FROM push_credentials WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ kind: "fcm" | "apns"; secret_enc: string }>();
  const out: { fcm?: FcmCredentials; apns?: ApnsCredentials } = {};
  for (const r of results) {
    const value = JSON.parse(await decryptString(env.ENCRYPTION_KEY, r.secret_enc));
    if (r.kind === "fcm") out.fcm = value;
    else out.apns = value;
  }
  return out;
}

export async function pushCredentialStatus(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare("SELECT kind, updated_at FROM push_credentials WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ kind: "fcm" | "apns"; updated_at: number }>();
  return {
    fcm: results.find((r) => r.kind === "fcm")?.updated_at ?? null,
    apns: results.find((r) => r.kind === "apns")?.updated_at ?? null,
  };
}
