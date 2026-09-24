import { sha256Hex } from "../lib/crypto";
import { importEcKey, signJwt } from "./jwt";
import { InvalidPushToken, PUSH_TIMEOUT_MS, type ApnsCredentials, type PushPayload } from "./types";

/** Provider tokens keyed by a hash of the full key material (see fcm.ts for why), promise-cached. */
const jwtCache = new Map<string, { promise: Promise<string>; iat: number }>();

/** APNs provider tokens are valid up to 60 min; Apple rejects refreshes more often than every 20. */
async function providerToken(creds: ApnsCredentials): Promise<string> {
  const key = await sha256Hex(JSON.stringify([creds.teamId, creds.keyId, creds.keyP8]));
  const cached = jwtCache.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.iat < 50 * 60) return cached.promise;
  const entry = {
    promise: importEcKey(creds.keyP8).then((k) => signJwt("ES256", k, { iss: creds.teamId, iat: now }, { kid: creds.keyId })),
    iat: now,
  };
  jwtCache.set(key, entry);
  entry.promise.catch(() => jwtCache.get(key) === entry && jwtCache.delete(key));
  return entry.promise;
}

export async function sendApns(
  creds: ApnsCredentials,
  device: { token: string; appId: string; sandbox: boolean },
  payload: PushPayload,
): Promise<void> {
  const host = device.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const res = await fetch(`${host}/3/device/${encodeURIComponent(device.token)}`, {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: {
      authorization: `bearer ${await providerToken(creds)}`,
      "apns-topic": device.appId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": payload.data.conversationId ?? "livechat",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: "default",
        ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
        "thread-id": payload.data.conversationId,
      },
      ...payload.data,
    }),
  });
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 410 || text.includes("BadDeviceToken") || text.includes("Unregistered") || text.includes("DeviceTokenNotForTopic")) {
    throw new InvalidPushToken(text);
  }
  throw new Error(`APNs send failed: ${res.status} ${text}`);
}
