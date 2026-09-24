import { describe, expect, it, vi } from "vitest";

describe("script widget", () => {
  it("boots from the script tag, runs queued commands and renders inside a shadow root", async () => {
    const script = document.createElement("script");
    script.dataset.apiUrl = "https://support.test";
    script.dataset.workspaceKey = "pk_test";
    document.head.appendChild(script);

    const routes: Record<string, unknown> = {
      "/v1/config": {
        workspaceId: "ws", branding: { name: "Acme", primaryColor: "#123456", logoUrl: null, greeting: {} }, defaultLocale: "en", locales: ["en"],
        officeHours: { enabled: false, timezone: "UTC", windows: [] }, online: true, typicalReplyMinutes: null,
      },
      "/v1/session": { token: "t", expiresAt: Date.now() + 1e9, contact: { id: "c", externalId: null, email: null, name: null, locale: null, verified: false } },
      "/v1/conversations/unread": { count: 3 },
      "/v1/conversations": { items: [], nextCursor: null },
      "/v1/faq/categories": [],
      "/v1/faq/articles": [],
    };
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(routes[new URL(url).pathname] ?? {}), { status: 200 }));

    // Snippet-style queue before the script loads.
    const unread: number[] = [];
    const pre = Object.assign((...args: unknown[]) => void (pre.q as unknown[]).push(args), { q: [] as unknown[] });
    window.LiveChat = pre as unknown as typeof window.LiveChat;
    // Returning visitor: a stored session means the unread count is fetched right away.
    localStorage.setItem(
      "livechat:pk_test:session",
      JSON.stringify({ token: "t", expiresAt: Date.now() + 1e9, contact: { id: "c", externalId: null, email: null, name: null, locale: null, verified: false }, userId: null }),
    );
    window.LiveChat!("onUnreadChange", (n: number) => unread.push(n));
    window.LiveChat!("open");

    await import("./index");
    const host = document.getElementById("livechat-widget-host")!;
    expect(host.shadowRoot).toBeTruthy();

    await vi.waitFor(() => expect(host.shadowRoot!.querySelector('[role="dialog"]')).toBeTruthy());
    await vi.waitFor(() => expect(host.shadowRoot!.textContent).toContain("Send us a message"));
    expect(host.shadowRoot!.querySelector("style[data-livechat]")).toBeTruthy();
    expect(document.head.querySelector("style[data-livechat]")).toBeNull(); // no leakage into the host page
    await vi.waitFor(() => expect(unread.at(-1)).toBe(3));

    window.LiveChat!("close");
    await vi.waitFor(() => expect(host.shadowRoot!.querySelector('[role="dialog"]')).toBeNull());
  });
});
