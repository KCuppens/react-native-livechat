import { InvalidPushToken, PUSH_TIMEOUT_MS, type PushPayload } from "./types";

/**
 * Expo's push service: for apps that already send their own notifications through Expo (it holds
 * their APNs key and FCM credentials), so the workspace needs no push credentials of its own.
 * `accessToken` is only needed when the Expo project has enhanced push security on.
 */
export async function sendExpo(deviceToken: string, payload: PushPayload, accessToken?: string): Promise<void> {
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      to: deviceToken,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
      priority: "high",
      channelId: "livechat",
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Expo push failed: ${res.status} ${text}`);
  let ticket: { status?: string; message?: string; details?: { error?: string } } | undefined;
  try {
    ticket = (JSON.parse(text) as { data?: typeof ticket }).data;
  } catch {
    throw new Error(`Expo push: unreadable response ${text.slice(0, 200)}`);
  }
  if (ticket?.status === "ok") return;
  if (ticket?.details?.error === "DeviceNotRegistered") throw new InvalidPushToken(ticket.message ?? "DeviceNotRegistered");
  throw new Error(`Expo push rejected: ${ticket?.details?.error ?? ""} ${ticket?.message ?? text.slice(0, 200)}`);
}
