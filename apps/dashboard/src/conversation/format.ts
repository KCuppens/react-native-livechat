import type { AgentConversation, Message } from "@kobecuppens/livechat-protocol";

export const contactName = (c: AgentConversation) => c.contact.name ?? c.contact.email ?? `Visitor ${c.contact.id.slice(-4)}`;

/** Adds messages by id and keeps the thread in id (= time) order, whatever order they arrive in. */
export function mergeById(prev: Message[] | null, incoming: Message[]): Message[] {
  const byId = new Map((prev ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
