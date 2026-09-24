import { ALLOWED_ATTACHMENT_TYPES, CLOSE_SESSION_REVOKED, MAX_ATTACHMENT_BYTES } from "@kobecuppens/livechat-protocol/constants";
import type {
  Attachment,
  Contact,
  Conversation,
  CsatRequest,
  Message,
  PushDeviceRequest,
  ServerEvent,
  SessionResponse,
  WorkspaceConfig,
} from "@kobecuppens/livechat-protocol";
import { LiveChatApiError, LiveChatHttp, type UploadInput } from "./http";
import { negotiateLocale } from "./i18n";
import { secureRandomId } from "./random";
import { ReconnectingSocket, type SocketState } from "./socket";
import { createMemoryStorage, type StorageAdapter } from "./storage";
import { Store } from "./store";

export type DeliveryStatus = "sent" | "sending" | "failed";

export interface ChatMessage extends Message {
  status: DeliveryStatus;
}

export interface ConversationThread {
  /** Ascending; confirmed messages first, then pending/failed local ones. */
  messages: ChatMessage[];
  hasOlder: boolean;
  loading: boolean;
  loaded: boolean;
  /** Who is typing on the other side, if anyone. */
  typing: { name: string | null } | null;
  agentLastReadAt: number;
  connection: SocketState;
  /** The last load failed (offline, 5xx). Retried on the next socket open or `retryLoad`. */
  error: boolean;
}

export interface LiveChatState {
  status: "idle" | "initializing" | "ready" | "error";
  error: string | null;
  config: WorkspaceConfig | null;
  contact: Contact | null;
  locale: string;
  conversations: Conversation[];
  conversationsLoaded: boolean;
  unreadCount: number;
  threads: Record<string, ConversationThread>;
  /**
   * Bumped when the identity changes (login/logout), which drops all conversation state and
   * sockets. Screens that hold a conversation or list depend on it to reopen/refetch.
   */
  identity: number;
}

/** Identity for a logged-in host-app user. `hash` = HMAC-SHA256(identitySecret, id), computed server-side. */
export interface LiveChatUser {
  id: string;
  hash: string;
  email?: string;
  name?: string;
}

export interface LiveChatClientOptions {
  apiUrl: string;
  workspaceKey: string;
  storage?: StorageAdapter;
  /** Preferred locale (e.g. device locale); negotiated against the workspace's locales. */
  locale?: string;
  user?: LiveChatUser | null;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

interface StoredSession {
  token: string;
  expiresAt: number;
  contact: Contact;
  userId: string | null;
}

interface LoadEntry {
  /** What to load again after this run, for requests that arrived while it was in flight. */
  again: "none" | "messages" | "full";
  resolveFirst?: () => void;
  next?: Promise<void>;
  resolveNext?: () => void;
}

/** Local id for the not-yet-created conversation used by `sendMessage(null, …)`. */
export const DRAFT_CONVERSATION = "draft";

const TYPING_RESEND_MS = 3_000;
const TYPING_IDLE_MS = 5_000;
const REMOTE_TYPING_TTL_MS = 6_000;
/** Read receipts are batched: a burst of agent messages sends one POST /read. */
const READ_DEBOUNCE_MS = 1_000;

/** Shape of a conversation nobody has loaded yet. Frozen: spread it to get a mutable copy. */
export const EMPTY_THREAD: Readonly<ConversationThread> = Object.freeze({
  messages: [],
  hasOlder: false,
  loading: false,
  loaded: false,
  typing: null,
  agentLastReadAt: 0,
  connection: "closed",
  error: false,
});

const emptyThread = (): ConversationThread => ({ ...EMPTY_THREAD, messages: [] });

function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  const sent = messages.filter((m) => m.status === "sent").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...sent, ...messages.filter((m) => m.status !== "sent")];
}

function mergeMessages(existing: ChatMessage[], incoming: Message[]): ChatMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const msg of incoming) {
    // A confirmed message replaces its optimistic twin (matched by clientId).
    if (msg.clientId) {
      for (const [id, m] of byId) {
        if (m.status !== "sent" && m.clientId === msg.clientId) byId.delete(id);
      }
    }
    byId.set(msg.id, { ...msg, status: "sent" });
  }
  return sortMessages([...byId.values()]);
}

export class LiveChatClient {
  readonly store: Store<LiveChatState>;
  readonly http: LiveChatHttp;

  private readonly storage: StorageAdapter;
  private readonly storagePrefix: string;
  private user: LiveChatUser | null;
  private preferredLocale: string | undefined;
  private session: StoredSession | null = null;
  private sessionPromise: Promise<StoredSession> | null = null;
  /** Bumped on identity change; a session request from an older generation must not commit. */
  private sessionGen = 0;
  private initPromise: Promise<void> | null = null;
  private sockets = new Map<string, { socket: ReconnectingSocket; refs: number }>();
  private typingOut = new Map<string, { lastSentAt: number; idleTimer: ReturnType<typeof setTimeout> | null }>();
  private typingIn = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set while a draft is creating the conversation; resolves with its id (null on failure). */
  private startingConversation: Promise<string | null> | null = null;
  /**
   * Bumped whenever identity changes. Async work captures it and drops its result if it
   * changed meanwhile, so a previous user's responses can't land in the new user's state.
   */
  private epoch = 0;
  private readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * In-flight loads per conversation. A load requested while one runs is coalesced into a single
   * follow-up after it (its read may predate whatever triggered the new request).
   */
  private loads = new Map<string, LoadEntry>();
  /** Last registered push device, moved to the new identity on login/logout. */
  private pushDevice: PushDeviceRequest | null = null;
  /** The push device still has to be registered with the current identity (a move failed). */
  private pushPending = false;
  /** identify() calls run one at a time, in call order, so the latest call wins. */
  private identifyQueue: Promise<void> = Promise.resolve();
  /** Bodies of pending sends, kept for retry. */
  private outbox = new Map<string, { conversationId: string | null; body: string; attachmentIds: string[] }>();

  constructor(private readonly opts: LiveChatClientOptions) {
    this.storage = opts.storage ?? createMemoryStorage();
    this.storagePrefix = `livechat:${opts.workspaceKey}:`;
    this.user = opts.user ?? null;
    this.preferredLocale = opts.locale;
    this.store = new Store<LiveChatState>({
      status: "idle",
      error: null,
      config: null,
      contact: null,
      locale: opts.locale?.split("-")[0] ?? "en",
      conversations: [],
      conversationsLoaded: false,
      unreadCount: 0,
      threads: {},
      identity: 0,
    });
    this.http = new LiveChatHttp({
      apiUrl: opts.apiUrl,
      workspaceKey: opts.workspaceKey,
      fetch: opts.fetch,
      getToken: async () => (await this.ensureSession()).token,
      onInvalidToken: (failedToken) => this.replaceSession(failedToken),
    });
  }

  /** Drops a session the server rejected and gets a new one. */
  private async replaceSession(failedToken: string): Promise<void> {
    // Several requests can fail with the same expired token at once: only the first one
    // replaces the session; the rest just retry with the fresh token.
    if (this.session && this.session.token !== failedToken) return;
    this.session = null;
    await this.storage.removeItem(this.key("session"));
    await this.ensureSession();
  }

  get state(): LiveChatState {
    return this.store.getSnapshot();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Loads config and the contact session. Safe to call repeatedly. */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      this.store.set({ status: "initializing", error: null });
      try {
        // Anonymous visitors without a stored session get one lazily (first real use), so a
        // pageview that never opens the messenger creates no server contact and no polling.
        const [config] = await Promise.all([this.http.getConfig(), this.user ? this.ensureSession() : this.restoreSession()]);
        this.store.set({
          config,
          locale: negotiateLocale(this.preferredLocale, config.locales, config.defaultLocale),
          status: "ready",
        });
        void this.refreshUnread();
      } catch (err) {
        this.initPromise = null;
        this.store.set({ status: "error", error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    })();
    return this.initPromise;
  }

  destroy(): void {
    for (const { socket } of this.sockets.values()) socket.stop();
    this.sockets.clear();
    this.clearTimers();
  }

  private clearTimers(): void {
    for (const t of this.typingIn.values()) clearTimeout(t);
    for (const t of this.typingOut.values()) if (t.idleTimer) clearTimeout(t.idleTimer);
    for (const t of this.readTimers.values()) clearTimeout(t);
    this.typingIn.clear();
    this.typingOut.clear();
    this.readTimers.clear();
  }

  /** Switches identity. Passing null logs out to a fresh anonymous contact. */
  identify(user: LiveChatUser | null): Promise<void> {
    const run = this.identifyQueue.catch(() => {}).then(() => this.doIdentify(user));
    this.identifyQueue = run;
    return run;
  }

  private async doIdentify(user: LiveChatUser | null): Promise<void> {
    const sameUser = (user?.id ?? null) === (this.user?.id ?? null);
    if (sameUser && this.session) {
      this.user = user;
      return;
    }
    // Staying anonymous with no session yet: nothing to switch, and sessions stay lazy.
    if (sameUser && !user) return;
    const previous = this.session;
    const device = this.pushDevice;
    // Detach this device's push token from the previous contact while its session is still
    // valid (and before `this.user` changes, which would invalidate it), or a logged-out/shared
    // device keeps receiving that user's message previews.
    if (device && previous) await this.http.unregisterPushDevice(device.token).catch(() => {});
    if (device) this.pushPending = true;
    this.user = user;
    this.session = null;
    this.sessionPromise = null;
    this.sessionGen++;
    if (!user) {
      await this.storage.removeItem(this.key("session"));
      // A logged-out device must not keep the anonymous id that was merged into the user.
      if (previous?.userId) await this.storage.removeItem(this.key("deviceId"));
    }
    this.resetConversationState();
    await this.ensureSession(previous && !previous.userId ? previous.token : undefined);
    void this.syncPushDevice();
    void this.refreshUnread();
  }

  /** Registers the push device with the current identity if a previous attempt didn't. */
  private async syncPushDevice(): Promise<void> {
    const device = this.pushDevice;
    if (!device || !this.pushPending) return;
    this.pushPending = false;
    try {
      await this.http.registerPushDevice(device);
    } catch {
      // Retried on the next resume().
      if (this.pushDevice === device) this.pushPending = true;
    }
  }

  setLocale(locale: string): void {
    this.preferredLocale = locale;
    const config = this.state.config;
    this.store.set({ locale: config ? negotiateLocale(locale, config.locales, config.defaultLocale) : locale });
  }

  // ---------------------------------------------------------------- session

  private key(name: string): string {
    return this.storagePrefix + name;
  }

  private async deviceId(): Promise<string> {
    let id = await this.storage.getItem(this.key("deviceId"));
    if (!id) {
      id = secureRandomId();
      await this.storage.setItem(this.key("deviceId"), id);
    }
    return id;
  }

  private isValidSession(s: StoredSession | null): boolean {
    return !!s && s.expiresAt - Date.now() > 60_000 && s.userId === (this.user?.id ?? null);
  }

  private async readStoredSession(): Promise<StoredSession | null> {
    const stored = await this.storage.getItem(this.key("session"));
    try {
      return stored ? (JSON.parse(stored) as StoredSession) : null;
    } catch {
      // Corrupt value (e.g. a truncated write): drop it and start a fresh session.
      await this.storage.removeItem(this.key("session"));
      return null;
    }
  }

  /** Loads a still-valid stored session without touching the network. */
  private async restoreSession(): Promise<void> {
    const parsed = await this.readStoredSession();
    if (parsed && this.isValidSession(parsed) && !this.session) {
      this.session = parsed;
      this.store.set({ contact: parsed.contact });
    }
  }

  private ensureSession(previousToken?: string): Promise<StoredSession> {
    if (this.session && this.isValidSession(this.session)) return Promise.resolve(this.session);
    if (this.sessionPromise) return this.sessionPromise;

    const gen = this.sessionGen;
    // eslint-disable-next-line prefer-const -- referenced (by identity) inside its own initializer
    let pending!: Promise<StoredSession>;
    pending = (async () => {
      try {
        const parsed = await this.readStoredSession();
        if (gen !== this.sessionGen) return this.ensureSession(); // identity changed meanwhile
        if (parsed && this.isValidSession(parsed)) {
          this.session = parsed;
          this.store.set({ contact: parsed.contact });
          return parsed;
        }
        // Upgrading from anonymous → verified: hand over the anonymous token so its history is merged.
        const prevAnon = previousToken ?? (parsed && !parsed.userId && this.user ? parsed.token : undefined);
        const res: SessionResponse = await this.http.createSession({
          deviceId: await this.deviceId(),
          ...(this.user
            ? { userId: this.user.id, userHash: this.user.hash, email: this.user.email, name: this.user.name }
            : {}),
          ...(this.preferredLocale ? { locale: this.preferredLocale.split("-")[0] } : {}),
          ...(prevAnon ? { previousToken: prevAnon } : {}),
        });
        // Superseded by identify() while in flight: don't store/show the previous identity.
        if (gen !== this.sessionGen) return this.ensureSession();
        const session: StoredSession = { ...res, userId: this.user?.id ?? null };
        this.session = session;
        await this.storage.setItem(this.key("session"), JSON.stringify(session));
        this.store.set({ contact: session.contact });
        return session;
      } finally {
        // Only clear our own slot: a newer generation may already own it.
        if (this.sessionPromise === pending) this.sessionPromise = null;
      }
    })();
    this.sessionPromise = pending;
    return pending;
  }

  private resetConversationState(): void {
    this.epoch++;
    for (const { socket } of this.sockets.values()) socket.stop();
    this.sockets.clear();
    this.clearTimers();
    this.outbox.clear();
    this.startingConversation = null;
    this.loads.clear();
    this.store.set((s) => ({ conversations: [], conversationsLoaded: false, unreadCount: 0, threads: {}, identity: s.identity + 1 }));
  }

  // ---------------------------------------------------------------- conversations

  async refreshConversations(): Promise<void> {
    const epoch = this.epoch;
    const page = await this.http.listConversations();
    if (epoch !== this.epoch) return;
    this.store.set({ conversations: page.items, conversationsLoaded: true });
  }

  /** Whether a contact session exists (restored or created); before that there's nothing unread. */
  get hasSession(): boolean {
    return this.session !== null;
  }

  async refreshUnread(): Promise<void> {
    if (!this.session) return;
    const epoch = this.epoch;
    try {
      const { count } = await this.http.getUnreadCount();
      if (epoch !== this.epoch) return;
      this.store.set({ unreadCount: count });
    } catch {
      // Badge is best-effort.
    }
  }

  private updateThread(conversationId: string, update: (t: ConversationThread) => Partial<ConversationThread>): void {
    this.store.set((s) => {
      const prev = s.threads[conversationId] ?? emptyThread();
      return { threads: { ...s.threads, [conversationId]: { ...prev, ...update(prev) } } };
    });
  }

  private upsertConversation(conversation: Conversation): void {
    this.store.set((s) => {
      const rest = s.conversations.filter((c) => c.id !== conversation.id);
      return { conversations: [conversation, ...rest].sort((a, b) => b.lastMessageAt - a.lastMessageAt) };
    });
  }

  private patchConversation(id: string, patch: Partial<Conversation>): void {
    this.store.set((s) => ({
      conversations: s.conversations
        .map((c) => (c.id === id ? { ...c, ...patch } : c))
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt),
    }));
  }

  /**
   * Opens a conversation: loads the latest messages, connects realtime and marks it read.
   * Returns a function that releases it (the socket closes when nothing holds it).
   */
  openConversation(conversationId: string): () => void {
    const entry = this.sockets.get(conversationId);
    if (entry) {
      entry.refs++;
    } else {
      let failedAttempts = 0;
      let opened = false;
      const socket = new ReconnectingSocket({
        url: async () => {
          // A revoked token (e.g. identity secret rotated) fails the handshake with a plain HTTP
          // 401 that sockets can't see. After a few failed attempts, probe over HTTP: a 401 there
          // replaces the session, and the next attempt uses the fresh token.
          if (failedAttempts > 0 && failedAttempts % 3 === 0) await this.http.getUnreadCount().catch(() => {});
          failedAttempts++;
          return this.http.socketUrl(conversationId);
        },
        WebSocket: this.opts.WebSocket,
        onEvent: (e) => this.handleEvent(conversationId, e),
        onStateChange: (connection) => {
          this.updateThread(conversationId, () => ({ connection }));
          if (connection !== "open") return;
          failedAttempts = 0;
          // First open: backfill whatever was published between the initial load and the
          // subscription (e.g. an auto-reply sent right after the conversation was created).
          // Later opens are covered by onReconnect.
          if (!opened) {
            opened = true;
            // Messages only: the conversation itself came with the initial load.
            void this.loadLatest(conversationId, "messages");
          }
        },
        onReconnect: () => void this.loadLatest(conversationId),
        // The server revoked this session (identity secret rotated): get a new one and come back.
        onTerminalClose: (code) => {
          if (code !== CLOSE_SESSION_REVOKED) return;
          const epoch = this.epoch;
          const failed = this.session?.token;
          void (failed ? this.replaceSession(failed) : this.ensureSession().then(() => {}))
            .catch(() => {})
            .then(() => {
              if (epoch === this.epoch && this.sockets.get(conversationId)?.socket === socket) socket.start();
            });
        },
      });
      this.sockets.set(conversationId, { socket, refs: 1 });
      socket.start();
      void this.loadLatest(conversationId);
    }
    void this.markRead(conversationId);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const e = this.sockets.get(conversationId);
      if (!e) return;
      if (--e.refs <= 0) {
        e.socket.stop();
        this.sockets.delete(conversationId);
        this.setTyping(conversationId, false);
      }
    };
  }

  /** Reconnect all sockets now, e.g. when the app returns to the foreground. */
  resume(): void {
    for (const { socket } of this.sockets.values()) socket.nudge();
    void this.refreshUnread();
    if (this.session) void this.syncPushDevice();
  }

  /** Reloads a conversation whose last load failed (`thread.error`). */
  retryLoad(conversationId: string): Promise<void> {
    return this.loadLatest(conversationId);
  }

  private loadLatest(conversationId: string, what: "full" | "messages" = "full"): Promise<void> {
    const inflight = this.loads.get(conversationId);
    if (inflight) {
      // Coalesced: resolves once the follow-up (which covers this request) has run.
      if (inflight.again !== "full") inflight.again = what;
      inflight.next ??= new Promise<void>((resolve) => {
        inflight.resolveNext = resolve;
      });
      return inflight.next;
    }
    const epoch = this.epoch;
    const entry: LoadEntry = { again: "none" };
    this.loads.set(conversationId, entry);
    void this.fetchLatest(conversationId, what).finally(() => {
      if (this.loads.get(conversationId) === entry) this.loads.delete(conversationId);
      const followUp = entry.again !== "none" && epoch === this.epoch ? this.loadLatest(conversationId, entry.again) : Promise.resolve();
      void followUp.then(() => entry.resolveNext?.());
      entry.resolveFirst?.();
    });
    return new Promise<void>((resolve) => {
      entry.resolveFirst = resolve;
    });
  }

  private async fetchLatest(conversationId: string, what: "full" | "messages"): Promise<void> {
    const epoch = this.epoch;
    const thread = this.state.threads[conversationId];
    // A messages-only refresh needs the conversation from an earlier successful load.
    const withConversation = what === "full" || !thread?.loaded;
    this.updateThread(conversationId, () => ({ loading: true, error: false }));
    try {
      const [page, conversation] = await Promise.all([
        this.http.listMessages(conversationId),
        withConversation ? this.http.getConversation(conversationId) : null,
      ]);
      if (epoch !== this.epoch) return;
      this.updateThread(conversationId, (t) => ({
        messages: mergeMessages(t.messages, page.items),
        hasOlder: thread?.loaded ? t.hasOlder || page.nextCursor !== null : page.nextCursor !== null,
        loaded: true,
        loading: false,
        error: false,
        agentLastReadAt: Math.max(t.agentLastReadAt, conversation?.agentLastReadAt ?? 0),
      }));
      if (conversation) this.upsertConversation(conversation);
    } catch {
      if (epoch !== this.epoch) return;
      this.updateThread(conversationId, (t) => ({ loading: false, error: !t.loaded }));
    }
  }

  async loadOlder(conversationId: string): Promise<void> {
    const thread = this.state.threads[conversationId];
    const oldest = thread?.messages.find((m) => m.status === "sent");
    if (!thread?.hasOlder || thread.loading || !oldest) return;
    const epoch = this.epoch;
    this.updateThread(conversationId, () => ({ loading: true }));
    try {
      const page = await this.http.listMessages(conversationId, oldest.id);
      if (epoch !== this.epoch) return;
      this.updateThread(conversationId, (t) => ({
        messages: mergeMessages(t.messages, page.items),
        hasOlder: page.nextCursor !== null,
        loading: false,
      }));
    } catch {
      if (epoch !== this.epoch) return;
      this.updateThread(conversationId, () => ({ loading: false }));
    }
  }

  async markRead(conversationId: string): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.http.markRead(conversationId);
      if (epoch !== this.epoch) return;
      if (!this.state.conversations.some((c) => c.id === conversationId)) {
        await this.refreshUnread();
        return;
      }
      // Adjust the badge locally from the count as it is now (not before the await), in one
      // update: two overlapping markReads then subtract it only once.
      this.store.set((s) => {
        const n = s.conversations.find((c) => c.id === conversationId)?.unreadCount ?? 0;
        return {
          unreadCount: Math.max(0, s.unreadCount - n),
          conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0, contactLastReadAt: Date.now() } : c)),
        };
      });
    } catch {
      // Retried on the next open/message.
    }
  }

  /** Trailing debounce for read receipts while a conversation is on screen. */
  private scheduleRead(conversationId: string): void {
    clearTimeout(this.readTimers.get(conversationId));
    this.readTimers.set(
      conversationId,
      setTimeout(() => {
        this.readTimers.delete(conversationId);
        void this.markRead(conversationId);
      }, READ_DEBOUNCE_MS),
    );
  }

  private handleEvent(conversationId: string, event: ServerEvent): void {
    switch (event.type) {
      case "message.created": {
        const msg = event.message;
        this.updateThread(conversationId, (t) => ({
          messages: mergeMessages(t.messages, [msg]),
          typing: msg.authorType === "agent" ? null : t.typing,
        }));
        this.patchConversation(conversationId, { lastMessage: msg, lastMessageAt: msg.createdAt });
        // The conversation is on screen, so agent replies are read immediately.
        if (msg.authorType !== "contact") this.scheduleRead(conversationId);
        break;
      }
      case "typing": {
        if (event.authorType !== "agent") return;
        const existing = this.typingIn.get(conversationId);
        if (existing) clearTimeout(existing);
        if (event.typing) {
          this.typingIn.set(
            conversationId,
            setTimeout(() => this.updateThread(conversationId, () => ({ typing: null })), REMOTE_TYPING_TTL_MS),
          );
        }
        this.updateThread(conversationId, () => ({ typing: event.typing ? { name: event.name } : null }));
        break;
      }
      case "read":
        if (event.authorType === "agent") {
          this.updateThread(conversationId, (t) => ({ agentLastReadAt: Math.max(t.agentLastReadAt, event.at) }));
        }
        break;
      case "status.changed":
        this.patchConversation(conversationId, { status: event.status });
        break;
      case "pong":
        break;
    }
  }

  // ---------------------------------------------------------------- sending

  /**
   * Sends a message with optimistic UI. With `conversationId = null` it starts a new
   * conversation (shown under DRAFT_CONVERSATION until created). Resolves with the
   * conversation id; failures leave the message marked "failed" for `retry`.
   */
  async sendMessage(
    conversationId: string | null,
    input: { body: string; attachmentIds?: string[]; attachments?: Message["attachments"] },
  ): Promise<string | null> {
    const clientId = `c_${secureRandomId(12)}`;
    const threadId = conversationId ?? DRAFT_CONVERSATION;
    const optimistic: ChatMessage = {
      id: `local:${clientId}`,
      conversationId: threadId,
      clientId,
      authorType: "contact",
      author: { id: this.state.contact?.id ?? null, name: this.state.contact?.name ?? null, avatarUrl: null },
      body: input.body,
      attachments: input.attachments ?? [],
      systemEvent: null,
      createdAt: Date.now(),
      status: "sending",
    };
    this.outbox.set(clientId, { conversationId, body: input.body, attachmentIds: input.attachmentIds ?? [] });
    this.updateThread(threadId, (t) => ({ messages: sortMessages([...t.messages, optimistic]), loaded: true }));
    if (conversationId) this.setTyping(conversationId, false);
    return this.deliver(clientId);
  }

  async retry(clientId: string): Promise<string | null> {
    const pending = this.outbox.get(clientId);
    if (!pending) return null;
    const threadId = pending.conversationId ?? DRAFT_CONVERSATION;
    this.setLocalStatus(threadId, clientId, "sending");
    return this.deliver(clientId);
  }

  private setLocalStatus(threadId: string, clientId: string, status: DeliveryStatus): void {
    this.updateThread(threadId, (t) => ({
      messages: t.messages.map((m) => (m.clientId === clientId && m.status !== "sent" ? { ...m, status } : m)),
    }));
  }

  private async deliver(clientId: string): Promise<string | null> {
    // A send that outlives an identity change must not write into the new identity's state.
    const epoch = this.epoch;
    let pending = this.outbox.get(clientId);
    // Only one draft may create the conversation. Later drafts wait for it and are then sent
    // into the new conversation (deliver() of the first one reassigns them in the outbox).
    while (pending && !pending.conversationId && this.startingConversation) {
      await this.startingConversation;
      if (epoch !== this.epoch) return null;
      pending = this.outbox.get(clientId);
    }
    if (!pending) return null; // discarded while waiting
    const req = { clientId, body: pending.body, attachmentIds: pending.attachmentIds };
    try {
      if (pending.conversationId) {
        const message = await this.http.sendMessage(pending.conversationId, req);
        if (epoch !== this.epoch) return null;
        this.outbox.delete(clientId);
        this.updateThread(pending.conversationId, (t) => ({ messages: mergeMessages(t.messages, [message]) }));
        this.patchConversation(pending.conversationId, { lastMessage: message, lastMessageAt: message.createdAt });
        return pending.conversationId;
      }
      const start = this.http.startConversation(req);
      this.startingConversation = start.then(
        (r) => r.conversation.id,
        () => null,
      );
      let started: Awaited<typeof start>;
      try {
        started = await start;
      } finally {
        if (epoch === this.epoch) this.startingConversation = null;
      }
      if (epoch !== this.epoch) return null;
      const { conversation, message } = started;
      this.outbox.delete(clientId);
      this.store.set((s) => {
        const { [DRAFT_CONVERSATION]: draft, ...threads } = s.threads;
        const thread: ConversationThread = {
          ...emptyThread(),
          messages: mergeMessages(
            (draft?.messages ?? []).filter((m) => m.clientId !== clientId),
            [message],
          ).map((m) => ({ ...m, conversationId: conversation.id })),
          loaded: true,
        };
        return { threads: { ...threads, [conversation.id]: thread } };
      });
      // Remaining draft messages (queued while this one was in flight) now belong to the new conversation.
      for (const [id, p] of this.outbox) {
        if (p.conversationId === null) this.outbox.set(id, { ...p, conversationId: conversation.id });
      }
      this.upsertConversation(conversation);
      return conversation.id;
    } catch {
      if (epoch !== this.epoch) return null;
      this.setLocalStatus(this.outbox.get(clientId)?.conversationId ?? DRAFT_CONVERSATION, clientId, "failed");
      return null;
    }
  }

  /** Discards a failed message. */
  discard(clientId: string): void {
    const pending = this.outbox.get(clientId);
    if (!pending) return;
    this.outbox.delete(clientId);
    const threadId = pending.conversationId ?? DRAFT_CONVERSATION;
    this.updateThread(threadId, (t) => ({ messages: t.messages.filter((m) => m.clientId !== clientId || m.status === "sent") }));
  }

  /** Call on every keystroke with typing=true; throttled and auto-stopped after idle. */
  setTyping(conversationId: string, typing: boolean): void {
    const socket = this.sockets.get(conversationId)?.socket;
    const state = this.typingOut.get(conversationId) ?? { lastSentAt: 0, idleTimer: null };
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = null;

    if (typing) {
      const now = Date.now();
      if (now - state.lastSentAt >= TYPING_RESEND_MS && socket?.send({ type: "typing", typing: true })) {
        state.lastSentAt = now;
      }
      state.idleTimer = setTimeout(() => this.setTyping(conversationId, false), TYPING_IDLE_MS);
      this.typingOut.set(conversationId, state);
    } else if (state.lastSentAt > 0) {
      socket?.send({ type: "typing", typing: false });
      this.typingOut.delete(conversationId);
    }
  }

  // ---------------------------------------------------------------- misc

  async submitCsat(conversationId: string, input: CsatRequest): Promise<void> {
    const epoch = this.epoch;
    await this.http.submitCsat(conversationId, input);
    if (epoch !== this.epoch) return;
    this.patchConversation(conversationId, { csatScore: input.score });
  }

  /**
   * Validates and uploads a file; pass the returned attachment's id (and the attachment for
   * optimistic display) to `sendMessage`. Throws LiveChatApiError with code
   * "too_large" / "unsupported_type" for invalid files without hitting the network.
   */
  async uploadAttachment(file: UploadInput): Promise<Attachment> {
    if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
      throw new LiveChatApiError(415, "unsupported_type", "This file type isn't supported");
    }
    if (file.size > MAX_ATTACHMENT_BYTES) throw new LiveChatApiError(413, "too_large", "File is too large");
    return this.http.uploadAttachment(file);
  }

  async registerPushDevice(device: PushDeviceRequest): Promise<void> {
    await this.http.registerPushDevice(device);
    this.pushDevice = device;
    this.pushPending = false;
  }

  /** Stops push notifications to this device (e.g. the user disabled them). */
  async unregisterPushDevice(): Promise<void> {
    const device = this.pushDevice;
    if (!device) return;
    await this.http.unregisterPushDevice(device.token);
    this.pushDevice = null;
    this.pushPending = false;
  }
}
