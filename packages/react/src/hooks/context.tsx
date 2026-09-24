import {
  createTranslator,
  LiveChatClient,
  type LiveChatClientOptions,
  type LiveChatState,
  type LiveChatUser,
  type StringOverrides,
  type Translate,
} from "@kobecuppens/livechat-core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/** Where the messenger is showing. Shared by web and native UIs (and notification deep links). */
export type MessengerRoute =
  | { name: "home" }
  | { name: "conversations" }
  | { name: "conversation"; id: string }
  | { name: "new" }
  | { name: "category"; id: string; title: string }
  | { name: "article"; slug: string }
  | { name: "search"; query: string };

export interface MessengerControls {
  isOpen: boolean;
  route: MessengerRoute;
  open: (route?: MessengerRoute) => void;
  close: () => void;
  toggle: () => void;
  /** Pushes a screen onto the in-messenger stack. */
  navigate: (route: MessengerRoute) => void;
  /** Replaces the current screen (e.g. draft → created conversation). */
  replace: (route: MessengerRoute) => void;
  back: () => void;
  canGoBack: boolean;
}

interface LiveChatContextValue {
  client: LiveChatClient;
  t: Translate;
  messenger: MessengerControls;
}

const LiveChatContext = createContext<LiveChatContextValue | null>(null);

export interface LiveChatProviderProps extends Omit<LiveChatClientOptions, "user"> {
  /** Logged-in host-app user (verified). Omit/null for anonymous visitors. */
  user?: LiveChatUser | null;
  /** Per-locale string overrides, e.g. { en: { "home.greeting": "Hey!" } }. */
  strings?: StringOverrides;
  /** Use an existing client instead of creating one (advanced/testing). */
  client?: LiveChatClient;
  children: ReactNode;
}

export function LiveChatProvider({ client: provided, strings, children, ...options }: LiveChatProviderProps) {
  const [client] = useState(() => provided ?? new LiveChatClient(options));
  const state = useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);

  useEffect(() => {
    client.init().catch(() => {
      // Exposed via state.status/error.
    });
    return () => {
      if (!provided) client.destroy();
    };
  }, [client, provided]);

  // Keep identity and locale in sync with props.
  const userKey = options.user ? `${options.user.id}:${options.user.hash}` : "";
  const userRef = useRef(options.user);
  userRef.current = options.user;
  const firstUser = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: userKey (id+hash) is the identity-change trigger; the user object itself is read via a ref
  useEffect(() => {
    if (firstUser.current) {
      firstUser.current = false;
      return;
    }
    client.identify(userRef.current ?? null).catch((err: unknown) => {
      // Offline or a rejected user hash: surface it instead of an unhandled rejection.
      client.store.set({ error: err instanceof Error ? err.message : String(err) });
    });
  }, [client, userKey]);
  useEffect(() => {
    if (options.locale) client.setLocale(options.locale);
  }, [client, options.locale]);

  const [stack, setStack] = useState<MessengerRoute[]>([{ name: "home" }]);
  const [isOpen, setOpen] = useState(false);
  const messenger = useMemo<MessengerControls>(
    () => ({
      isOpen,
      route: stack[stack.length - 1]!,
      canGoBack: stack.length > 1,
      open: (route) => {
        if (route) setStack(route.name === "home" ? [route] : [{ name: "home" }, route]);
        setOpen(true);
      },
      close: () => setOpen(false),
      toggle: () => setOpen((o) => !o),
      navigate: (route) => setStack((s) => [...s, route]),
      replace: (route) => setStack((s) => [...s.slice(0, -1), route]),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    }),
    [isOpen, stack],
  );

  const t = useMemo(() => createTranslator(state.locale, strings), [state.locale, strings]);
  const value = useMemo(() => ({ client, t, messenger }), [client, t, messenger]);
  return <LiveChatContext.Provider value={value}>{children}</LiveChatContext.Provider>;
}

function useCtx(): LiveChatContextValue {
  const ctx = useContext(LiveChatContext);
  if (!ctx) throw new Error("[livechat] Wrap your app in <LiveChatProvider>.");
  return ctx;
}

export function useLiveChatClient(): LiveChatClient {
  return useCtx().client;
}

/** Subscribes to (a slice of) client state. Keep selectors cheap and return stable references. */
export function useLiveChatState<T = LiveChatState>(selector: (s: LiveChatState) => T = (s) => s as unknown as T): T {
  const client = useCtx().client;
  const get = useCallback(() => selector(client.store.getSnapshot()), [client, selector]);
  return useSyncExternalStore(client.store.subscribe, get, get);
}

export function useTranslate(): Translate {
  return useCtx().t;
}

export function useMessenger(): MessengerControls {
  return useCtx().messenger;
}

const selectUnread = (s: LiveChatState) => s.unreadCount;

export function useUnreadCount(): number {
  return useLiveChatState(selectUnread);
}
