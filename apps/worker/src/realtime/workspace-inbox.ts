import { DurableObject } from "cloudflare:workers";
import type { InboxEvent } from "@kobecuppens/livechat-protocol";
import { CLOSE_ACCESS_REVOKED } from "@kobecuppens/livechat-protocol/constants";
import type { Env } from "../env";
import { closeSafely } from "./conversation-room";
import { roomStub } from "./publish";

/** Rooms remembered per agent; the oldest drop off (a dashboard only has a few open at once). */
const MAX_TRACKED_ROOMS = 100;
/**
 * Rooms where contacts connected, one storage key each (`contactRoom:<id>` → last seen), so a
 * rotation can reach their sockets. Keys not refreshed for this long are pruned: sockets
 * reconnect far more often than that.
 */
const CONTACT_ROOM_PREFIX = "contactRoom:";
const CONTACT_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A tracked room's timestamp is refreshed at most this often (reconnects mostly cost no write). */
const CONTACT_ROOM_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Parallel room RPCs when disconnecting contacts. */
const DISCONNECT_BATCH = 50;

export class WorkspaceInbox extends DurableObject<Env> {
  /** When this instance last wrote each room's key (avoids a storage write per reconnect). */
  private contactRoomWrites = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  override async fetch(request: Request): Promise<Response> {
    const agentId = request.headers.get("X-Agent-Id");
    if (request.headers.get("Upgrade") !== "websocket" || !agentId) return new Response("Bad request", { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    const session = request.headers.get("X-Session-Tag");
    this.ctx.acceptWebSocket(server, session ? [agentId, session] : [agentId]);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    closeSafely(ws, code);
    this.broadcastPresence(ws);
  }

  /** RPC: remember that an agent opened a conversation socket. */
  async trackRoom(agentId: string, conversationId: string): Promise<void> {
    const key = `rooms:${agentId}`;
    const rooms = ((await this.ctx.storage.get<string[]>(key)) ?? []).filter((id) => id !== conversationId);
    rooms.push(conversationId);
    await this.ctx.storage.put(key, rooms.slice(-MAX_TRACKED_ROOMS));
  }

  /** RPC: remember that a contact connected to a conversation's room. */
  async trackContactRoom(conversationId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.contactRoomWrites.get(conversationId) ?? 0) < CONTACT_ROOM_REFRESH_MS) return;
    this.contactRoomWrites.set(conversationId, now);
    await this.ctx.storage.put(CONTACT_ROOM_PREFIX + conversationId, now);
  }

  /**
   * RPC: close contact sockets authorized before `minEpoch` in every tracked room (the identity
   * secret was rotated, which revokes those tokens). Clients get a new session and reconnect.
   * Rooms that couldn't be reached stay tracked, so a later call retries them.
   */
  async disconnectContacts(minEpoch: number): Promise<void> {
    const cutoff = Date.now() - CONTACT_ROOM_TTL_MS;
    const failed: string[] = [];
    let total = 0;
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list<number>({ prefix: CONTACT_ROOM_PREFIX, startAfter, limit: 500 });
      if (page.size === 0) break;
      const stale: string[] = [];
      const live: string[] = [];
      for (const [key, seenAt] of page) (seenAt < cutoff ? stale : live).push(key);
      for (let i = 0; i < live.length; i += DISCONNECT_BATCH) {
        const keys = live.slice(i, i + DISCONNECT_BATCH);
        const results = await Promise.allSettled(keys.map((k) => roomStub(this.env, k.slice(CONTACT_ROOM_PREFIX.length)).disconnectContacts(minEpoch)));
        results.forEach((r, j) => {
          if (r.status === "rejected") failed.push(keys[j]!.slice(CONTACT_ROOM_PREFIX.length));
        });
      }
      total += live.length;
      if (stale.length > 0) await this.ctx.storage.delete(stale);
      startAfter = [...page.keys()].at(-1);
    }
    if (failed.length > 0) console.error({ msg: "disconnectContacts failed for rooms", rooms: failed.slice(0, 50), failed: failed.length, total });
  }

  /**
   * RPC: close the live sockets of one signed-out session (inbox + the rooms its agent joined),
   * leaving the agent's other sessions connected.
   */
  async disconnectSession(agentId: string, tag: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(tag)) closeSafely(ws, CLOSE_ACCESS_REVOKED, "signed out");
    const rooms = (await this.ctx.storage.get<string[]>(`rooms:${agentId}`)) ?? [];
    await Promise.allSettled(rooms.map((id) => roomStub(this.env, id).disconnectTag(tag)));
    this.broadcastPresence();
  }

  /** RPC: close every live socket of an agent who lost access to the workspace. */
  async disconnectAgent(agentId: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets(agentId)) closeSafely(ws, CLOSE_ACCESS_REVOKED, "access revoked");
    const key = `rooms:${agentId}`;
    const rooms = (await this.ctx.storage.get<string[]>(key)) ?? [];
    // allSettled: one unreachable room must not keep the others connected or skip presence.
    const results = await Promise.allSettled(rooms.map((id) => roomStub(this.env, id).disconnectAgent(agentId)));
    const failed = rooms.filter((_, i) => results[i]!.status === "rejected");
    if (failed.length > 0) {
      console.error({ msg: "disconnectAgent failed for rooms", agentId, rooms: failed });
      await this.ctx.storage.put(key, failed);
    } else {
      await this.ctx.storage.delete(key);
    }
    this.broadcastPresence();
  }

  broadcast(event: InboxEvent): void {
    this.send(event);
  }

  onlineAgentIds(except?: WebSocket): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      for (const tag of this.ctx.getTags(ws)) if (!tag.startsWith("session:")) ids.add(tag);
    }
    return [...ids];
  }

  private broadcastPresence(except?: WebSocket) {
    this.send({ type: "presence", onlineAgentIds: this.onlineAgentIds(except) }, except);
  }

  private send(event: InboxEvent, except?: WebSocket) {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        // Socket already closing; the runtime will call webSocketClose.
      }
    }
  }
}
