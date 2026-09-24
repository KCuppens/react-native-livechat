import { z } from "zod";
import { Timestamp } from "./common";

export const ConversationStatus = z.enum(["open", "pending", "resolved"]);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const AuthorType = z.enum(["contact", "agent", "system"]);
export type AuthorType = z.infer<typeof AuthorType>;

export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  /** Image dimensions, when known. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Signed, time-limited download URL. Present on messages served by the API. */
  url: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const SystemEvent = z.enum(["auto_reply", "resolved", "reopened", "csat_request", "assigned"]);
export type SystemEvent = z.infer<typeof SystemEvent>;

export const Author = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type Author = z.infer<typeof Author>;

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Client-generated id for idempotent sends; null for agent/system messages created server-side. */
  clientId: z.string().nullable(),
  authorType: AuthorType,
  author: Author.nullable(),
  body: z.string(),
  attachments: z.array(Attachment),
  systemEvent: SystemEvent.nullable(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const Conversation = z.object({
  id: z.string(),
  status: ConversationStatus,
  assignee: Author.nullable(),
  lastMessage: Message.nullable(),
  lastMessageAt: Timestamp,
  /** Last time the contact read the conversation. */
  contactLastReadAt: Timestamp,
  /** Last time any agent read the conversation (drives "Seen"). */
  agentLastReadAt: Timestamp,
  unreadCount: z.number().int().nonnegative(),
  csatScore: z.number().int().min(1).max(5).nullable(),
  createdAt: Timestamp,
});
export type Conversation = z.infer<typeof Conversation>;

import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH } from "./constants";
export { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_LENGTH } from "./constants";

export const SendMessageRequest = z.object({
  clientId: z.string().min(8).max(64),
  body: z.string().max(MAX_MESSAGE_LENGTH),
  attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
}).refine((v) => v.body.trim().length > 0 || v.attachmentIds.length > 0, {
  message: "message must have a body or attachments",
});
export type SendMessageRequest = z.input<typeof SendMessageRequest>;

/** POST /v1/conversations — starts a conversation with its first message. */
export const StartConversationRequest = SendMessageRequest;
export type StartConversationRequest = SendMessageRequest;

export const CsatRequest = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});
export type CsatRequest = z.infer<typeof CsatRequest>;

export const PushDeviceRequest = z.object({
  platform: z.enum(["ios", "android"]),
  /** Native push token: hex for APNs, [A-Za-z0-9_:-] for FCM. Goes into URLs, so the charset is strict. */
  token: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_:.-]+$/, "invalid push token"),
  /** iOS bundle id / Android package name; selects the APNs topic. */
  appId: z.string().min(1).max(256),
  /** iOS only: true when the build uses the APNs sandbox (development). */
  sandbox: z.boolean().default(false),
});
export type PushDeviceRequest = z.input<typeof PushDeviceRequest>;

export const Page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
