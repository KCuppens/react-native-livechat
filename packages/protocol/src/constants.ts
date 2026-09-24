// Zod-free runtime values, importable by browser/mobile bundles via "@kobecuppens/livechat-protocol/constants"
// without pulling in the schema library.

export const MAX_MESSAGE_LENGTH = 5000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "application/pdf",
] as const;

/** WebSocket close codes (4000-4499 are terminal: the client stops instead of retrying as-is). */
export const CLOSE_ACCESS_REVOKED = 4003;
/** The contact's session was revoked (identity secret rotated): get a new session, then reconnect. */
export const CLOSE_SESSION_REVOKED = 4401;

export { isWithinOfficeHours, zonedClock } from "./office-hours";
