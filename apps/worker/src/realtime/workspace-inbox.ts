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
/** Bound on the in-memory write log (an evicted room only costs one extra write on reconnect). */
const CONTACT_ROOM_WRITES_MAX = 5000;
/** Durable Object storage deletes at most 128 keys per call. */
const STORAGE_DELETE_BATCH = 128;
/** Rooms whose contact disconnect failed, retried by alarm() (see scheduleDisconnectRetry). */
const PENDING_DISCONNECT_KEY = "pendingDisconnect";
/** 30s, 1m, 2m, … capped at 30m: about 2 hours of retrying before a room is dead-lettered. */
const DISCONNECT_RETRY_ATTEMPTS = 10;
const DISCONNECT_RETRY_BASE_MS = 30_000;
const DISCONNECT_RETRY_MAX_MS = 30 * 60_000;
/** Rooms still unreachable after all retries; the next rotation tries them again. */
const DEAD_DISCONNECT_KEY = "deadDisconnect";
/** Parallel room RPCs when disconnecting contacts. */
const DISCONNECT_BATCH = 50;

interface PendingDisconnect {
  minEpoch: number;
  rooms: string[];
  attempt: number;
}

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
    await this.ctx.storage.put(CONTACT_ROOM_PREFIX + conversationId, now);
    // Only after the write succeeded (a failed put must be retried on the next connect), and
    // delete-then-set keeps insertion order = recency, so the oldest entry is evicted first.
    this.contactRoomWrites.delete(conversationId);
    this.contactRoomWrites.set(conversationId, now);
    if (this.contactRoomWrites.size > CONTACT_ROOM_WRITES_MAX) this.contactRoomWrites.delete(this.contactRoomWrites.keys().next().value!);
  }

  /**
   * RPC: close contact sockets authorized before `minEpoch` in every tracked room (the identity
   * secret was rotated, which revokes those tokens). Clients get a new session and reconnect.
   * Rooms that couldn't be reached are retried by the alarm with backoff.
   */
  async disconnectContacts(minEpoch: number): Promise<void> {
    // Rooms given up on earlier (tracked or not anymore): the new epoch covers their old tokens too.
    const dead = await this.ctx.storage.get<string[]>(DEAD_DISCONNECT_KEY);
    if (dead) await this.ctx.storage.delete(DEAD_DISCONNECT_KEY);
    const failed = [...(await this.disconnectTrackedRooms(minEpoch)), ...(dead ? await this.disconnectRooms(dead, minEpoch) : [])];
    if (failed.length > 0) await this.scheduleDisconnectRetry(minEpoch, [...new Set(failed)], 1);
  }

  /** Alarm: retries rooms whose contact disconnect failed, with backoff, then gives up (logged). */
  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingDisconnect>(PENDING_DISCONNECT_KEY);
    if (!pending) return;
    // Take the entry before the RPCs: a rotation during them queues (and merges) a new one,
    // which a delete afterwards would wipe out.
    await this.ctx.storage.delete(PENDING_DISCONNECT_KEY);
    let failed: string[];
    try {
      failed = await this.disconnectRooms(pending.rooms, pending.minEpoch);
    } catch (err) {
      await this.scheduleDisconnectRetry(pending.minEpoch, pending.rooms, pending.attempt);
      throw err;
    }
    if (failed.length === 0) return;
    if (pending.attempt >= DISCONNECT_RETRY_ATTEMPTS) {
      const dead = (await this.ctx.storage.get<string[]>(DEAD_DISCONNECT_KEY)) ?? [];
      await this.ctx.storage.put(DEAD_DISCONNECT_KEY, [...new Set([...dead, ...failed])]);
      console.error({ msg: "disconnectContacts gave up on rooms (kept for the next rotation)", rooms: failed.slice(0, 50), failed: failed.length, minEpoch: pending.minEpoch });
      return;
    }
    await this.scheduleDisconnectRetry(pending.minEpoch, failed, pending.attempt + 1);
  }

  private async scheduleDisconnectRetry(minEpoch: number, rooms: string[], attempt: number): Promise<void> {
    // Merge with a retry that's already queued (e.g. an earlier rotation): the newest epoch
    // closes everything older too.
    const queued = await this.ctx.storage.get<PendingDisconnect>(PENDING_DISCONNECT_KEY);
    const merged: PendingDisconnect = {
      minEpoch: Math.max(minEpoch, queued?.minEpoch ?? 0),
      rooms: [...new Set([...(queued?.rooms ?? []), ...rooms])],
      attempt: queued ? Math.min(queued.attempt, attempt) : attempt,
    };
    await this.ctx.storage.put(PENDING_DISCONNECT_KEY, merged);
    const delay = Math.min(DISCONNECT_RETRY_MAX_MS, DISCONNECT_RETRY_BASE_MS * 2 ** (merged.attempt - 1));
    await this.ctx.storage.setAlarm(Date.now() + delay + Math.random() * delay * 0.2);
  }

  /** Closes stale-epoch contact sockets in `rooms`; returns the rooms that couldn't be reached. */
  private async disconnectRooms(rooms: string[], minEpoch: number): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < rooms.length; i += DISCONNECT_BATCH) {
      const batch = rooms.slice(i, i + DISCONNECT_BATCH);
      const results = await Promise.allSettled(batch.map((id) => roomStub(this.env, id).disconnectContacts(minEpoch)));
      results.forEach((r, j) => {
        if (r.status === "rejected") failed.push(batch[j]!);
      });
    }
    return failed;
  }

  private async disconnectTrackedRooms(minEpoch: number): Promise<string[]> {
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
      failed.push(...(await this.disconnectRooms(live.map((k) => k.slice(CONTACT_ROOM_PREFIX.length)), minEpoch)));
      total += live.length;
      // Pruning must never stop the disconnect pass over later pages.
      for (let i = 0; i < stale.length; i += STORAGE_DELETE_BATCH) {
        await this.ctx.storage
          .delete(stale.slice(i, i + STORAGE_DELETE_BATCH))
          .catch((e) => console.error({ msg: "contact room prune failed", error: String(e) }));
      }
      for (const key of stale) this.contactRoomWrites.delete(key.slice(CONTACT_ROOM_PREFIX.length));
      startAfter = [...page.keys()].at(-1);
    }
    if (failed.length > 0) console.error({ msg: "disconnectContacts failed for rooms (will retry)", rooms: failed.slice(0, 50), failed: failed.length, total });
    return failed;
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
