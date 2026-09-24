import type {
  Attachment,
  Conversation,
  CsatRequest,
  Message,
  PushDeviceRequest,
  SendMessageRequest,
  SessionRequest,
  SessionResponse,
  FaqArticle,
  FaqArticleSummary,
  FaqCategory,
  WorkspaceConfig,
} from "@kobecuppens/livechat-protocol";

export class LiveChatApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LiveChatApiError";
  }

  /** Network failures and 5xx/429 are worth retrying; 4xx validation errors are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

interface RequestOptions {
  body?: unknown;
  auth?: boolean;
  raw?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface HttpOptions {
  apiUrl: string;
  workspaceKey: string;
  fetch?: typeof fetch;
  /** Returns the current contact token; called for every authenticated request. */
  getToken: () => Promise<string>;
  /** Called on 401 invalid_token with the token that failed, so the client can refresh once. */
  onInvalidToken: (failedToken: string) => Promise<void>;
}

export interface UploadInput {
  /** File bytes. On React Native: `await (await fetch(fileUri)).blob()`. */
  body: Blob | ArrayBuffer;
  name: string;
  /** MIME type; must be one of ALLOWED_ATTACHMENT_TYPES. */
  type: string;
  size: number;
  width?: number;
  height?: number;
}

export class LiveChatHttp {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: HttpOptions) {
    this.base = opts.apiUrl.replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  get apiUrl(): string {
    return this.base;
  }

  private async request<T>(method: string, path: string, init: RequestOptions = {}, retried = false): Promise<T> {
    const headers: Record<string, string> = { ...init.headers, "X-Livechat-Key": this.opts.workspaceKey };
    const token = init.auth !== false ? await this.opts.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (init.raw !== undefined) {
      body = init.raw;
      if (init.contentType) headers["Content-Type"] = init.contentType;
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, { method, headers, body });
    } catch (err) {
      throw new LiveChatApiError(0, "network_error", err instanceof Error ? err.message : "Network request failed");
    }

    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    if (!res.ok) {
      const code = data?.error?.code ?? "http_error";
      if (res.status === 401 && code === "invalid_token" && init.auth !== false && !retried) {
        await this.opts.onInvalidToken(token!);
        return this.request<T>(method, path, init, true);
      }
      throw new LiveChatApiError(res.status, code, data?.error?.message ?? res.statusText);
    }
    return data as T;
  }

  createSession(body: SessionRequest): Promise<SessionResponse> {
    return this.request("POST", "/v1/session", { body, auth: false });
  }

  getConfig(): Promise<WorkspaceConfig> {
    return this.request("GET", "/v1/config", { auth: false });
  }

  listConversations(cursor?: string): Promise<PageResult<Conversation>> {
    return this.request("GET", `/v1/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request("GET", `/v1/conversations/${encodeURIComponent(id)}`);
  }

  getUnreadCount(): Promise<{ count: number }> {
    return this.request("GET", "/v1/conversations/unread");
  }

  startConversation(body: SendMessageRequest): Promise<{ conversation: Conversation; message: Message }> {
    return this.request("POST", "/v1/conversations", { body });
  }

  listMessages(conversationId: string, before?: string): Promise<PageResult<Message>> {
    const q = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.request("GET", `/v1/conversations/${encodeURIComponent(conversationId)}/messages${q}`);
  }

  sendMessage(conversationId: string, body: SendMessageRequest): Promise<Message> {
    return this.request("POST", `/v1/conversations/${encodeURIComponent(conversationId)}/messages`, { body });
  }

  markRead(conversationId: string): Promise<void> {
    return this.request("POST", `/v1/conversations/${encodeURIComponent(conversationId)}/read`);
  }

  submitCsat(conversationId: string, body: CsatRequest): Promise<void> {
    return this.request("POST", `/v1/conversations/${encodeURIComponent(conversationId)}/csat`, { body });
  }

  registerPushDevice(body: PushDeviceRequest): Promise<void> {
    return this.request("POST", "/v1/push-devices", { body });
  }

  unregisterPushDevice(token: string): Promise<void> {
    return this.request("DELETE", `/v1/push-devices/${encodeURIComponent(token)}`);
  }

  uploadAttachment(file: UploadInput): Promise<Attachment> {
    const headers: Record<string, string> = { "X-Filename": encodeURIComponent(file.name) };
    if (file.width) headers["X-Width"] = String(Math.round(file.width));
    if (file.height) headers["X-Height"] = String(Math.round(file.height));
    return this.request("POST", "/v1/attachments", { raw: file.body, contentType: file.type, headers });
  }

  // Help center content is public per workspace: no contact token needed.

  listFaqCategories(locale: string): Promise<FaqCategory[]> {
    return this.request("GET", `/v1/faq/categories?locale=${encodeURIComponent(locale)}`, { auth: false });
  }

  listFaqArticles(opts: { locale: string; category?: string; sort?: "position" | "popular"; limit?: number }): Promise<FaqArticleSummary[]> {
    const q = new URLSearchParams({ locale: opts.locale });
    if (opts.category) q.set("category", opts.category);
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.request("GET", `/v1/faq/articles?${q}`, { auth: false });
  }

  searchFaq(query: string, opts: { locale: string; mode?: "all" | "any"; limit?: number }): Promise<FaqArticleSummary[]> {
    const q = new URLSearchParams({ q: query, locale: opts.locale, mode: opts.mode ?? "all" });
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.request("GET", `/v1/faq/articles?${q}`, { auth: false });
  }

  getFaqArticle(slug: string, locale: string): Promise<FaqArticle> {
    return this.request("GET", `/v1/faq/articles/${encodeURIComponent(slug)}?locale=${encodeURIComponent(locale)}`, { auth: false });
  }

  sendFaqFeedback(articleId: string, helpful: boolean): Promise<void> {
    return this.request("POST", `/v1/faq/articles/${encodeURIComponent(articleId)}/feedback`, { body: { helpful }, auth: false });
  }

  /** WebSocket URL for a conversation; auth goes in the query since sockets can't set headers. */
  async socketUrl(conversationId: string): Promise<string> {
    const token = await this.opts.getToken();
    const wsBase = this.base.replace(/^http/, "ws");
    return `${wsBase}/v1/conversations/${encodeURIComponent(conversationId)}/ws?key=${encodeURIComponent(this.opts.workspaceKey)}&token=${encodeURIComponent(token)}`;
  }
}
