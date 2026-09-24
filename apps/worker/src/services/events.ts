import type { Context } from "hono";
import type { AppBindings, Env } from "../env";
import { inboxStub } from "../realtime/publish";
import { getAgentConversation } from "./agent-conversations";

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Pushes the latest view of a conversation to every dashboard watching the workspace inbox. */
export async function conversationChanged(env: Env, workspaceId: string, conversationId: string): Promise<void> {
  const { dto } = await getAgentConversation(env.DB, workspaceId, conversationId);
  await inboxStub(env, workspaceId).broadcast({ type: "conversation.updated", conversation: dto });
}

/**
 * Runs a side effect that must not undo or fail a request whose data is already saved
 * (realtime fan-out, inbox updates, auto-replies). Failures are logged, not thrown.
 */
export async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error({ msg: "side effect failed", label, error: errorText(err) });
  }
}

/**
 * Runs best-effort side effects after the response is sent (Workers `waitUntil`), so realtime
 * fan-out and inbox updates don't add latency to every message. Without an execution context
 * (unit tests), runs them inline.
 */
export async function afterResponse(c: Context<AppBindings>, work: () => Promise<void>): Promise<void> {
  const run = work().catch((err) => console.error({ msg: "deferred side effects failed", error: errorText(err) }));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    await run;
  }
}
