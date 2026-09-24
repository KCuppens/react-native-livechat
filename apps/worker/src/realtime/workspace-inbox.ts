import { DurableObject } from "cloudflare:workers";
import type { InboxEvent } from "@kobecuppens/livechat-protocol";
import { CLOSE_ACCESS_REVOKED } from "@kobecuppens/livechat-protocol/constants";
import type { Env } from "../env";
import { closeSafely } from "./conversation-room";
import { roomStub } from "./publish";

/** Rooms remembered per agent; the oldest drop off (a dashboard only has a few open at once). */
const MAX_TRACKED_ROOMS = 100;
/** Rooms where contacts connected recently, so revoking contact sessions can reach their sockets. */
const MAX_CONTACT_ROOMS = 1000;
const CONTACT_ROOMS_KEY = "contactRooms";
/** Parallel room RPCs when disconnecting contacts. */
const DISCONNECT_BATCH = 50;

/** Live feed of conversation changes + agent presence for one workspace's dashboard. */
export class WorkspaceInbox extends DurableObject<Env> {
  /** In-memory copy of CONTACT_ROOMS_KEY: reconnects to a known room cost no storage write. */
  private contactRooms: string[] | null = null;

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
    this.contactRooms ??= (await this.ctx.storage.get<string[]>(CONTACT_ROOMS_KEY)) ?? [];
    if (this.contactRooms.includes(conversationId)) return;
    this.contactRooms = [...this.contactRooms, conversationId].slice(-MAX_CONTACT_ROOMS);
    await this.ctx.storage.put(CONTACT_ROOMS_KEY, this.contactRooms);
  }

  /**
   * RPC: close contact sockets in every tracked room (the identity secret was rotated, which
   * revokes their tokens). Clients get a new session and reconnect.
   */
  async disconnectContacts(): Promise<void> {
    const rooms = this.contactRooms ?? (await this.ctx.storage.get<string[]>(CONTACT_ROOMS_KEY)) ?? [];
    this.contactRooms = [];
    await this.ctx.storage.delete(CONTACT_ROOMS_KEY);
    let failed = 0;
    for (let i = 0; i < rooms.length; i += DISCONNECT_BATCH) {
      const results = await Promise.allSettled(rooms.slice(i, i + DISCONNECT_BATCH).map((id) => roomStub(this.env, id).disconnectContacts()));
      failed += results.filter((r) => r.status === "rejected").length;
    }
    if (failed > 0) console.error({ msg: "disconnectContacts failed for rooms", failed, total: rooms.length });
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
