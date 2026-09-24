import type { ServerEvent } from "@kobecuppens/livechat-protocol";
import type { Env } from "../env";
import { presentMessage } from "../services/attachments";
import type { ParticipantRole } from "./conversation-room";

export function roomStub(env: Env, conversationId: string) {
  return env.CONVERSATION_ROOM.get(env.CONVERSATION_ROOM.idFromName(conversationId));
}

export async function publishToConversation(
  env: Env,
  conversationId: string,
  event: ServerEvent,
  onlyRole?: ParticipantRole,
): Promise<void> {
  const out = event.type === "message.created" ? { ...event, message: await presentMessage(env, event.message) } : event;
  await roomStub(env, conversationId).broadcast(out, onlyRole);
}

export function inboxStub(env: Env, workspaceId: string) {
  return env.WORKSPACE_INBOX.get(env.WORKSPACE_INBOX.idFromName(workspaceId));
}
