import { sha256Hex } from "../lib/crypto";
import { importRsaKey, signJwt } from "./jwt";
import { InvalidPushToken, PUSH_TIMEOUT_MS, type FcmCredentials, type PushPayload } from "./types";

/**
 * OAuth access tokens, keyed by a hash of the full credentials (not client_email): another
 * workspace can't ride on a cached token by reusing a public identifier, and rotated keys
 * miss the cache. The in-flight promise is cached so concurrent sends share one token fetch.
 */
const tokenCache = new Map<string, { promise: Promise<string>; exp: number }>();

async function fetchAccessToken(creds: FcmCredentials): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt("RS256", await importRsaKey(creds.private_key), {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  return { token: data.access_token, expiresIn: data.expires_in };
}

async function accessToken(creds: FcmCredentials): Promise<string> {
  const key = await sha256Hex(JSON.stringify([creds.project_id, creds.client_email, creds.private_key]));
  const cached = tokenCache.get(key);
  if (cached && cached.exp - Date.now() > 60_000) return cached.promise;
  const pending = fetchAccessToken(creds);
  // Provisional expiry until the real one is known; failures are evicted so the next send retries.
  const entry = { promise: pending.then((r) => r.token), exp: Date.now() + 5 * 60_000 };
  tokenCache.set(key, entry);
  pending.then(
    (r) => (entry.exp = Date.now() + r.expiresIn * 1000),
    () => tokenCache.get(key) === entry && tokenCache.delete(key),
  );
  return entry.promise;
}

export async function sendFcm(creds: FcmCredentials, deviceToken: string, payload: PushPayload): Promise<void> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${await accessToken(creds)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: { priority: "HIGH", notification: { tag: payload.data.conversationId, channel_id: "livechat" } },
      },
    }),
  });
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 404 || text.includes("UNREGISTERED") || (res.status === 400 && text.includes("registration token"))) {
    throw new InvalidPushToken(text);
  }
  throw new Error(`FCM send failed: ${res.status} ${text}`);
}
