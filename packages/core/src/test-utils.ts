import type { Conversation, Message, ServerEvent } from "@kobecuppens/livechat-protocol";

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function message(partial: Partial<Message> & { id: string }): Message {
  return {
    conversationId: "cv_1",
    clientId: null,
    authorType: "agent",
    author: { id: "ag_1", name: "Sam", avatarUrl: null },
    body: "hi",
    attachments: [],
    systemEvent: null,
    createdAt: 1,
    ...partial,
  };
}

export function conversation(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    status: "open",
    assignee: null,
    lastMessage: null,
    lastMessageAt: 1,
    contactLastReadAt: 0,
    agentLastReadAt: 0,
    unreadCount: 0,
    csatScore: null,
    createdAt: 1,
    ...partial,
  };
}

type Handler = (req: { method: string; path: string; body: any; headers: Record<string, string> }) => { status?: number; body?: unknown } | undefined;

/** Routes fetch calls to handlers keyed by "METHOD /path" (query string stripped). */
export function fakeServer(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const req = { method, path: u.pathname + u.search, body, headers };
    calls.push(req);
    const handler = routes[`${method} ${u.pathname}`];
    const res = handler?.(req) ?? { status: 404, body: { error: { code: "not_found", message: "nf" } } };
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(res.body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
