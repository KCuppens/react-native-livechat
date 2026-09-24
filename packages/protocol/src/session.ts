import { z } from "zod";
import { Locale } from "./common";

/**
 * POST /v1/session
 * Anonymous: send only deviceId. Verified: also send userId + userHash, where
 * userHash = hex(HMAC-SHA256(identitySecret, userId)) computed on the host app's server.
 */
export const SessionRequest = z.object({
  // The anonymous contact's only credential: must be a random id (SDKs send 128-bit hex).
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/, "deviceId must be a random id of at least 128 bits"),
  userId: z.string().min(1).max(256).optional(),
  userHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  email: z.string().email().max(320).optional(),
  // No control characters: names end up in agent emails and the dashboard.
  name: z.string().max(200).regex(/^[^\p{Cc}]*$/u, "name must not contain control characters").optional(),
  locale: Locale.optional(),
  /** Token of a previous anonymous session; its conversations are merged into the verified contact. */
  previousToken: z.string().optional(),
}).refine((v) => (v.userId === undefined) === (v.userHash === undefined), {
  message: "userId and userHash must be provided together",
});
export type SessionRequest = z.infer<typeof SessionRequest>;

export const Contact = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  locale: Locale.nullable(),
  verified: z.boolean(),
});
export type Contact = z.infer<typeof Contact>;

export const SessionResponse = z.object({
  token: z.string(),
  expiresAt: z.number().int(),
  contact: Contact,
});
export type SessionResponse = z.infer<typeof SessionResponse>;
