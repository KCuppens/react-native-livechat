export type NotificationJob =
  /** An agent replied: push to the contact's devices if they aren't watching the conversation. */
  | {
      type: "agent_reply";
      workspaceId: string;
      conversationId: string;
      messageId: string;
      /** Follow-up for transient failures: only these device tokens, on attempt `pushAttempt`. */
      onlyTokens?: string[];
      pushAttempt?: number;
    }
  /** Delayed check: email the contact if the reply is still unread. */
  | { type: "email_digest"; workspaceId: string; conversationId: string; since: number }
  /** A contact started a conversation: email agents when nobody is online in the dashboard. */
  | { type: "new_conversation"; workspaceId: string; conversationId: string };

export interface FcmCredentials {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface ApnsCredentials {
  /** Contents of the .p8 file (PKCS#8 PEM). */
  keyP8: string;
  keyId: string;
  teamId: string;
}

export interface PushPayload {
  title: string;
  body: string;
  badge?: number;
  data: Record<string, string>;
}

/** A send result that tells the caller to forget the device token. */
export class InvalidPushToken extends Error {}

/** Upper bound for any call to FCM/APNs; a slow upstream must not stall the queue batch. */
export const PUSH_TIMEOUT_MS = 10_000;
