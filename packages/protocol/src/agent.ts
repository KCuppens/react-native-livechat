import { z } from "zod";
import { Contact } from "./session";
import { Conversation, ConversationStatus, MAX_MESSAGE_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE } from "./chat";
import { Timestamp } from "./common";
import { OfficeHours } from "./workspace";

export const AgentRole = z.enum(["admin", "agent"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const Agent = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentMe = z.object({
  agent: Agent,
  superAdmin: z.boolean(),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: AgentRole })),
});
export type AgentMe = z.infer<typeof AgentMe>;

export const MagicLinkRequest = z.object({ email: z.string().email().max(320) });
export const VerifyMagicLinkRequest = z.object({ token: z.string().min(16).max(128) });

/** Conversation as the dashboard sees it: includes the contact and last activity. */
export const AgentConversation = Conversation.omit({ unreadCount: true }).extend({
  contact: Contact.extend({ lastSeenAt: Timestamp }),
  /** Contact messages newer than agentLastReadAt. */
  unreadCount: z.number().int().nonnegative(),
  csatComment: z.string().nullable(),
});
export type AgentConversation = z.infer<typeof AgentConversation>;

export const InboxFilter = z.object({
  status: ConversationStatus.optional(),
  assignee: z.enum(["me", "unassigned", "all"]).default("all"),
  cursor: z.string().optional(),
});
export type InboxFilter = z.input<typeof InboxFilter>;

export const AgentReplyRequest = z.object({
  clientId: z.string().min(8).max(64),
  body: z.string().max(MAX_MESSAGE_LENGTH),
  attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
}).refine((v) => v.body.trim().length > 0 || v.attachmentIds.length > 0, { message: "message must have a body or attachments" });
export type AgentReplyRequest = z.input<typeof AgentReplyRequest>;

export const UpdateConversationRequest = z.object({
  status: ConversationStatus.optional(),
  /** null unassigns. */
  assigneeId: z.string().nullable().optional(),
});
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequest>;

/** Events on the workspace inbox socket (agents only). */
export const InboxEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation.updated"), conversation: AgentConversation }),
  z.object({ type: z.literal("presence"), onlineAgentIds: z.array(z.string()) }),
  z.object({ type: z.literal("pong") }),
]);
export type InboxEvent = z.infer<typeof InboxEvent>;

// ---------------------------------------------------------------- settings

export const WorkspaceSettings = z.object({
  id: z.string(),
  name: z.string(),
  primaryColor: z.string(),
  logoUrl: z.string().nullable(),
  greeting: z.record(z.string(), z.string()),
  defaultLocale: z.string(),
  locales: z.array(z.string()),
  officeHours: OfficeHours,
  autoReply: z.record(z.string(), z.string()),
  typicalReplyMinutes: z.number().int().nullable(),
  allowedOrigins: z.array(z.string()),
  csatEnabled: z.boolean(),
  publishableKey: z.string(),
  push: z.object({ fcmUpdatedAt: z.number().nullable(), apnsUpdatedAt: z.number().nullable() }),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

const LocaleCode = z.string().regex(/^[a-z]{2}$/);

export const UpdateWorkspaceSettingsRequest = z.object({
  name: z.string().min(1).max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logoUrl: z.string().url().startsWith("https://").nullable().optional(),
  greeting: z.record(LocaleCode, z.string().max(200)).optional(),
  defaultLocale: LocaleCode.optional(),
  locales: z.array(LocaleCode).min(1).max(20).optional(),
  officeHours: OfficeHours.optional(),
  autoReply: z.record(LocaleCode, z.string().max(1000)).optional(),
  typicalReplyMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  allowedOrigins: z
    .array(z.string().refine((o) => o === "*" || /^https?:\/\/[^/]+$/.test(o), "origin must be scheme://host[:port] or *"))
    .max(50)
    .optional(),
  csatEnabled: z.boolean().optional(),
});
export type UpdateWorkspaceSettingsRequest = z.infer<typeof UpdateWorkspaceSettingsRequest>;

export const FcmCredentialsRequest = z.object({
  /** The Firebase service account JSON file contents. */
  serviceAccountJson: z.string().min(10).max(20_000),
});
export const ApnsCredentialsRequest = z.object({
  keyP8: z.string().includes("PRIVATE KEY").max(5_000),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
});

export const CannedReply = z.object({
  id: z.string(),
  shortcut: z.string(),
  title: z.string(),
  body: z.string(),
});
export type CannedReply = z.infer<typeof CannedReply>;

export const SaveCannedReplyRequest = z.object({
  shortcut: z.string().regex(/^[a-z0-9-]{1,32}$/),
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(5000),
});
export type SaveCannedReplyRequest = z.infer<typeof SaveCannedReplyRequest>;

export const CsatReport = z.object({
  days: z.number().int(),
  responses: z.number().int(),
  average: z.number().nullable(),
  /** Count per score, index 0 = score 1. */
  distribution: z.array(z.number().int()).length(5),
  conversations: z.number().int(),
  resolved: z.number().int(),
  /** Median minutes from first contact message to first agent reply. */
  medianFirstResponseMinutes: z.number().nullable(),
  recentComments: z.array(z.object({ conversationId: z.string(), score: z.number().int(), comment: z.string(), at: z.number() })),
});
export type CsatReport = z.infer<typeof CsatReport>;

/** POST /agent/workspaces: same locale/origin rules as settings, and the default must be enabled. */
export const CreateWorkspaceRequest = z
  .object({
    name: z.string().min(1).max(100),
    defaultLocale: LocaleCode.default("en"),
    locales: z.array(LocaleCode).min(1).max(20).optional(),
    allowedOrigins: UpdateWorkspaceSettingsRequest.shape.allowedOrigins.unwrap().default([]),
  })
  .refine((v) => !v.locales || v.locales.includes(v.defaultLocale), {
    message: "The default language must be one of the enabled languages",
    path: ["defaultLocale"],
  });
export type CreateWorkspaceRequest = z.input<typeof CreateWorkspaceRequest>;

/** Firebase service account JSON as uploaded in settings (only the fields we use). */
export const FcmServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().includes("PRIVATE KEY"),
});
