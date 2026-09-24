import { createWebStorage, type LiveChatClient, type LiveChatUser, type MessengerRoute } from "@kobecuppens/livechat-react";
import { LiveChatProvider, LiveChatWidget, useLiveChatClient, useMessenger, useUnreadCount, type MessengerControls } from "@kobecuppens/livechat-react";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * Embed:
 *   <script src=".../widget.js" data-api-url="https://support.example.com" data-workspace-key="pk_…" async></script>
 * Optional: data-locale, data-color, data-theme="light|dark", data-hide-launcher.
 *
 * Commands (can be queued before the script loads with the snippet in the README):
 *   LiveChat("open" [, route]) · LiveChat("close") · LiveChat("toggle")
 *   LiveChat("identify", { id, hash, email?, name? }) · LiveChat("logout")
 *   LiveChat("setLocale", "nl") · LiveChat("showLauncher") · LiveChat("hideLauncher")
 *   LiveChat("onUnreadChange", (count) => …)
 */

type Command = [name: string, ...args: unknown[]];
type LiveChatFn = ((...args: Command) => void) & { q?: IArguments[] | Command[] };

declare global {
  interface Window {
    LiveChat?: LiveChatFn;
  }
}

interface WidgetOptions {
  apiUrl: string;
  workspaceKey: string;
  locale?: string;
  primaryColor?: string;
  theme?: "light" | "dark";
  hideLauncher?: boolean;
}

let messenger: MessengerControls | null = null;
let client: LiveChatClient | null = null;
let setLauncherVisible: ((v: boolean) => void) | null = null;
const unreadListeners = new Set<(n: number) => void>();
const queued: Command[] = [];

function Controller() {
  messenger = useMessenger();
  client = useLiveChatClient();
  const unread = useUnreadCount();
  useEffect(() => {
    for (const l of unreadListeners) l(unread);
  }, [unread]);
  useEffect(() => {
    for (const cmd of queued.splice(0)) run(cmd);
  }, []);
  return null;
}

function run([name, ...args]: Command) {
  if (!messenger || !client) {
    queued.push([name, ...args]);
    return;
  }
  switch (name) {
    case "open":
      return messenger.open(args[0] as MessengerRoute | undefined);
    case "close":
      return messenger.close();
    case "toggle":
      return messenger.toggle();
    case "identify":
      return void client.identify(args[0] as LiveChatUser).catch((err: unknown) => console.warn("[livechat] identify failed", err));
    case "logout":
      return void client.identify(null).catch((err: unknown) => console.warn("[livechat] logout failed", err));
    case "setLocale":
      return client.setLocale(String(args[0]));
    case "showLauncher":
      return setLauncherVisible?.(true);
    case "hideLauncher":
      return setLauncherVisible?.(false);
    case "onUnreadChange": {
      const cb = args[0] as (n: number) => void;
      unreadListeners.add(cb);
      cb(client.state.unreadCount);
      return;
    }
    default:
      console.warn(`[livechat] unknown command "${name}"`);
  }
}

function Widget({ options, shadow }: { options: WidgetOptions; shadow: ShadowRoot }) {
  const [launcher, setLauncher] = useState(!options.hideLauncher);
  setLauncherVisible = setLauncher;
  return (
    <LiveChatProvider apiUrl={options.apiUrl} workspaceKey={options.workspaceKey} locale={options.locale ?? navigator.language} storage={createWebStorage()}>
      <Controller />
      <LiveChatWidget primaryColor={options.primaryColor} theme={options.theme} styleRoot={shadow} hideLauncher={!launcher} />
    </LiveChatProvider>
  );
}

export function mount(options: WidgetOptions): void {
  if (document.getElementById("livechat-widget-host")) return;
  const host = document.createElement("div");
  host.id = "livechat-widget-host";
  // Keep the host itself out of layout; the shadow content is position:fixed.
  host.style.cssText = "position:fixed;z-index:2147483000;inset:auto 0 0 auto;width:0;height:0";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const root = document.createElement("div");
  shadow.appendChild(root);
  render(<Widget options={options} shadow={shadow} />, root);
}

function boot() {
  const script =
    (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>("script[data-workspace-key]");
  const pre = window.LiveChat;
  const api: LiveChatFn = (...cmd) => run(cmd);
  window.LiveChat = api;
  for (const args of pre?.q ?? []) run(Array.from(args as ArrayLike<unknown>) as Command);

  const d = script?.dataset;
  if (!d?.apiUrl || !d.workspaceKey) {
    console.error("[livechat] Missing data-api-url or data-workspace-key on the widget script tag.");
    return;
  }
  const options: WidgetOptions = {
    apiUrl: d.apiUrl,
    workspaceKey: d.workspaceKey,
    locale: d.locale,
    primaryColor: d.color,
    theme: d.theme === "dark" || d.theme === "light" ? d.theme : undefined,
    hideLauncher: d.hideLauncher !== undefined,
  };
  if (document.body) mount(options);
  else document.addEventListener("DOMContentLoaded", () => mount(options), { once: true });
}

boot();
