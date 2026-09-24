import { useEffect, useRef, type CSSProperties } from "react";
import { useLiveChatClient, useLiveChatState, useMessenger, useTranslate, useUnreadCount } from "../hooks/context";
import { useWorkspaceConfig } from "../hooks/data";
import { ChatIcon, CloseIcon } from "./icons";
import { ArticleScreen, CategoryScreen } from "./screens/Articles";
import { ChatScreen } from "./screens/Chat";
import { ConversationsScreen } from "./screens/Conversations";
import { HomeScreen } from "./screens/Home";
import { ErrorState, InlineContext, Loading, MessengerErrorBoundary } from "./screens/shared";
import { injectStyles } from "./styles";
import { onColor } from "./util";

export interface ThemeProps {
  /** Overrides the workspace's primary color. */
  primaryColor?: string;
  /** Force a color scheme; defaults to the system setting. */
  theme?: "light" | "dark";
}

function useThemeStyle(primaryColor?: string): CSSProperties {
  const config = useWorkspaceConfig();
  const primary = primaryColor ?? config?.branding.primaryColor ?? "#4F46E5";
  return { "--lc-primary": primary, "--lc-on-primary": onColor(primary) } as CSSProperties;
}

function useStyles(styleRoot?: Document | ShadowRoot) {
  useEffect(() => {
    if (typeof document !== "undefined") injectStyles(styleRoot ?? document);
  }, [styleRoot]);
}

/** The focused element, looking inside shadow roots (the script widget renders in one). */
function deepActiveElement(): HTMLElement | null {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  return el;
}

function Screens() {
  const { route } = useMessenger();
  const status = useLiveChatState((s) => s.status);
  const client = useLiveChatClient();
  if (status === "error") return <ErrorState onRetry={() => void client.init().catch(() => {})} />;
  if (status !== "ready") return <Loading />;
  switch (route.name) {
    case "home":
      return <HomeScreen />;
    case "conversations":
      return <ConversationsScreen />;
    case "conversation":
      return <ChatScreen key={route.id} conversationId={route.id} />;
    case "new":
      return <ChatScreen key="new" conversationId={null} />;
    case "category":
      return <CategoryScreen id={route.id} title={route.title} />;
    case "article":
      return <ArticleScreen key={route.slug} slug={route.slug} />;
    case "search":
      return <HomeScreen />;
  }
}

export interface MessengerProps extends ThemeProps {
  /** Render inside your layout (e.g. a /help page) instead of as a floating panel. Always open. */
  inline?: boolean;
  className?: string;
  /** Where to inject styles (the widget passes its shadow root). */
  styleRoot?: Document | ShadowRoot;
}

/** The help center + chat panel. Floating by default; controlled via useMessenger(). */
export function Messenger({ inline, primaryColor, theme, className, styleRoot }: MessengerProps) {
  useStyles(styleRoot);
  const messenger = useMessenger();
  const t = useTranslate();
  const style = useThemeStyle(primaryColor);
  const panel = useRef<HTMLDivElement>(null);
  const client = useLiveChatClient();

  // Refresh badge/realtime when the page becomes visible again.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => document.visibilityState === "visible" && client.resume();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client]);

  useEffect(() => {
    if (inline || !messenger.isOpen) return;
    // Only Escapes pressed inside the panel: the host page's own dialogs and menus use Escape too.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && panel.current && e.composedPath().includes(panel.current)) messenger.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, messenger]);

  // Focus moves into the panel when it opens and back to where it was when it closes.
  const isOpen = inline || messenger.isOpen;
  useEffect(() => {
    if (inline || !messenger.isOpen) return;
    const previous = deepActiveElement();
    const root = panel.current?.getRootNode() as Document | ShadowRoot | undefined;
    panel.current?.focus();
    return () => {
      // Only take focus back if it's still ours (in the panel, or dropped to <body> when the
      // panel unmounted): the user may have moved on to something else on the page.
      const active = deepActiveElement();
      if (active && active !== document.body && active.isConnected && !panel.current?.contains(active)) return;
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else root?.querySelector<HTMLElement>(".lc-launcher")?.focus();
    };
  }, [inline, messenger.isOpen]);

  // On screen changes, the activated button unmounts: move focus to the new screen's title.
  const firstRoute = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every route change to move focus to the new screen
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const root = panel.current;
    if (!root) return;
    // The new screen may have focused its own control (e.g. the chat composer): keep that.
    const active = deepActiveElement();
    if (active && active !== root && root.contains(active)) return;
    (root.querySelector<HTMLElement>("[data-screen-title]") ?? root).focus();
  }, [messenger.route]);

  if (!isOpen) return null;
  return (
    <div className={`lc-root${className ? ` ${className}` : ""}`} data-theme={theme} style={style}>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is "region" or "dialog", both take aria-label (the rule can't evaluate the conditional) */}
      <div
        ref={panel}
        tabIndex={-1}
        className={`lc-panel${inline ? " lc-inline" : ""}`}
        role={inline ? "region" : "dialog"}
        aria-label={t("home.title")}
      >
        <InlineContext.Provider value={!!inline}>
          {/* Keyed by route: navigating away resets it, and Back leaves a screen that keeps failing. */}
          <MessengerErrorBoundary
            key={JSON.stringify(messenger.route)}
            fallback={(reset) => <ErrorState onRetry={reset} onBack={messenger.canGoBack ? messenger.back : undefined} />}
          >
            <Screens />
          </MessengerErrorBoundary>
        </InlineContext.Provider>
      </div>
    </div>
  );
}

/** Floating launcher button with unread badge; toggles the Messenger. */
export function Launcher({ primaryColor, theme, styleRoot }: ThemeProps & { styleRoot?: Document | ShadowRoot }) {
  useStyles(styleRoot);
  const messenger = useMessenger();
  const unread = useUnreadCount();
  const t = useTranslate();
  const style = useThemeStyle(primaryColor);
  const client = useLiveChatClient();

  // The badge has no realtime channel outside an open conversation; poll gently, and only while
  // the tab is visible (Messenger's visibilitychange handler refreshes when it becomes visible).
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void client.refreshUnread();
    }, 60_000);
    return () => clearInterval(id);
  }, [client]);

  return (
    <div className="lc-root" data-theme={theme} style={style}>
      <button type="button"
        className="lc-launcher"
        onClick={messenger.toggle}
        // The label replaces the button's content as its name, so the unread count must be in it.
        aria-label={messenger.isOpen ? t("common.close") : unread > 0 ? t("launcher.unread", { title: t("home.title"), count: unread }) : t("home.title")}
        aria-expanded={messenger.isOpen}
      >
        {messenger.isOpen ? <CloseIcon /> : <ChatIcon />}
        {!messenger.isOpen && unread > 0 && (
          <span className="lc-badge" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}

/** Launcher + floating Messenger: the drop-in chat widget for React apps. */
export function LiveChatWidget({ hideLauncher, ...props }: ThemeProps & { styleRoot?: Document | ShadowRoot; hideLauncher?: boolean }) {
  return (
    <>
      <Messenger {...props} />
      {!hideLauncher && <Launcher {...props} />}
    </>
  );
}
