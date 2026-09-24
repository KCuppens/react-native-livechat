import { DurableObject } from "cloudflare:workers";
import { ClientEvent, type ServerEvent } from "@kobecuppens/livechat-protocol";
import { CLOSE_ACCESS_REVOKED, CLOSE_SESSION_REVOKED } from "@kobecuppens/livechat-protocol/constants";
import type { Env } from "../env";

export type ParticipantRole = "contact" | "agent";

/**
 * Echoing the peer's close code can throw: 1005/1006/1015 are reserved and may not be sent.
 * Only 1000 and the 3000-4999 application range are safe to pass to close().
 */
export function closeSafely(ws: WebSocket, code: number, reason = "closing"): void {
  try {
    ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason);
  } catch {
    // Already closed.
  }
}

interface SocketMeta {
  role: ParticipantRole;
  name: string | null;
}

/**
 * Realtime fan-out for one conversation. D1 stays the source of truth: this object
 * only relays events between connected sockets, using the hibernation API so idle
 * rooms cost nothing.
 */
export class ConversationRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const role = request.headers.get("X-Participant-Role") as ParticipantRole | null;
    if (role !== "contact" && role !== "agent") return new Response("Missing role", { status: 400 });

    const agentId = request.headers.get("X-Agent-Id");
    const session = request.headers.get("X-Session-Tag");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [role, ...(agentId ? [`agent:${agentId}`] : []), ...(session ? [session] : [])]);
    server.serializeAttachment({ role, name: request.headers.get("X-Participant-Name") } satisfies SocketMeta);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 1024) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = ClientEvent.safeParse(parsed);
    if (!event.success) return;

    if (event.data.type === "typing") {
      const meta = ws.deserializeAttachment() as SocketMeta;
      const out: ServerEvent = { type: "typing", authorType: meta.role, name: meta.name, typing: event.data.typing };
      // Contacts' typing goes to agents only; agents' typing goes to everyone else.
      this.send(out, meta.role === "contact" ? "agent" : undefined, ws);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    closeSafely(ws, code);
  }

  /** RPC: drop an agent's sockets (they were removed from the workspace). */
  disconnectAgent(agentId: string): void {
    this.disconnectTag(`agent:${agentId}`);
  }

  /** RPC: drop every socket carrying `tag` (e.g. one signed-out session). */
  disconnectTag(tag: string): void {
    for (const ws of this.ctx.getWebSockets(tag)) closeSafely(ws, CLOSE_ACCESS_REVOKED, "access revoked");
  }

  /** RPC: the workspace's contact tokens were revoked; clients get a new session and reconnect. */
  disconnectContacts(): void {
    for (const ws of this.ctx.getWebSockets("contact")) closeSafely(ws, CLOSE_SESSION_REVOKED, "session revoked");
  }

  /** RPC: push an event to connected participants, optionally only to one role. */
  broadcast(event: ServerEvent, onlyRole?: ParticipantRole): void {
    this.send(event, onlyRole);
  }

  /** RPC: whether the contact currently has a live connection (used to skip push notifications). */
  isContactConnected(): boolean {
    return this.ctx.getWebSockets("contact").length > 0;
  }

  private send(event: ServerEvent, onlyRole?: ParticipantRole, except?: WebSocket) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets(onlyRole)) {
      if (socket === except) continue;
      try {
        socket.send(payload);
      } catch {
        // Socket already closing; the runtime will call webSocketClose.
      }
    }
  }
}
