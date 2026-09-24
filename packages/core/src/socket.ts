import type { ClientEvent, ServerEvent } from "@kobecuppens/livechat-protocol";

export type SocketState = "connecting" | "open" | "closed";

export interface SocketOptions<In = ServerEvent> {
  url: () => Promise<string>;
  onEvent: (event: In) => void;
  /**
   * Called when the server closes with an application code (4000-4499, e.g. 4003 "access
   * revoked"): retrying can't succeed, so the socket stops instead of reconnecting forever.
   */
  onTerminalClose?: (code: number) => void;
  onStateChange: (state: SocketState) => void;
  /** Called after a reconnect (not the first connect) so callers can backfill missed events. */
  onReconnect: () => void;
  WebSocket?: typeof WebSocket;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
}

/** WebSocket with exponential backoff + jitter and keepalive pings. Generic over the event types. */
export class ReconnectingSocket<In = ServerEvent, Out = ClientEvent | { type: "ping" }> {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private everOpened = false;
  private stopped = false;
  /** True from connect() start until the socket opens or fails, so nudge() can't start a second one. */
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SocketOptions<In>) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.opts.onStateChange("closed");
  }

  /** Reconnect immediately (e.g. app came to foreground or network came back). */
  nudge(): void {
    if (this.stopped || this.connecting || this.ws?.readyState === 1 || this.ws?.readyState === 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempts = 0;
    void this.connect();
  }

  send(event: Out | { type: "ping" }): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(event));
    return true;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.opts.onStateChange("connecting");
    let ws: WebSocket;
    try {
      const url = await this.opts.url();
      if (this.stopped) return;
      const WS = this.opts.WebSocket ?? globalThis.WebSocket;
      ws = new WS(url);
    } catch {
      this.scheduleReconnect();
      return;
    } finally {
      this.connecting = false;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      this.opts.onStateChange("open");
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.opts.pingIntervalMs ?? 25_000);
      if (isReconnect) this.opts.onReconnect();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string") return;
      let event: In;
      try {
        event = JSON.parse(e.data) as In;
      } catch {
        return; // Ignore malformed frames; handler errors below must still surface.
      }
      this.opts.onEvent(event);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      const code = e?.code ?? 1006;
      if (code >= 4000 && code < 4500) {
        this.stopped = true;
        this.opts.onStateChange("closed");
        this.opts.onTerminalClose?.(code);
        return;
      }
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles reconnecting.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.opts.onStateChange("connecting");
    const max = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(max, 500 * 2 ** this.attempts);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
