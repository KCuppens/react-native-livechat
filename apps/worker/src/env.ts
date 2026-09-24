export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  NOTIFICATIONS: Queue<import("./notifications/types").NotificationJob>;
  WORKSPACE_INBOX: DurableObjectNamespace<import("./realtime/workspace-inbox").WorkspaceInbox>;
  CONVERSATION_ROOM: DurableObjectNamespace<import("./realtime/conversation-room").ConversationRoom>;
  SESSION_LIMITER: RateLimit;
  MESSAGE_LIMITER: RateLimit;
  EMAIL?: SendEmail;
  PUBLIC_URL: string;
  /** Required when EMAIL is bound (checked at request time). */
  EMAIL_FROM?: string;
  /** Comma-separated emails that may sign in without an invite and create workspaces. */
  SUPER_ADMIN_EMAILS?: string;
  DEV_EMAIL_LOG?: string;
  CONTACT_JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  /** Signs attachment download URLs (kept separate so rotating contact sessions doesn't break file links). */
  ATTACHMENT_SIGNING_KEY: string;
}

type AppEnv = Env;

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}

export interface ContactAuth {
  contactId: string;
  workspaceId: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    workspace: import("./services/workspaces").WorkspaceRow;
    contact: ContactAuth;
    agent: import("./services/agents").AgentRow;
    membership: { workspaceId: string; role: "admin" | "agent" };
  };
};
