import { createMemoryStorage, LiveChatClient } from "@kobecuppens/livechat-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, StyleSheet } from "react-native";
import { LiveChatProvider, Markdown } from "../index";

const config = {
  workspaceId: "ws_1",
  branding: { name: "Acme", primaryColor: "#4F46E5", logoUrl: null, greeting: {} },
  defaultLocale: "en",
  locales: ["en"],
  officeHours: { enabled: false, timezone: "UTC", windows: [] },
  online: false,
  typicalReplyMinutes: null,
};

class NoopSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  onerror = null;
  send() {}
  close() {}
}

function makeClient() {
  const routes: Record<string, () => unknown> = {
    "GET /v1/config": () => config,
    "POST /v1/session": () => ({ token: "tok", expiresAt: Date.now() + 1e9, contact: { id: "ct_1", externalId: null, email: null, name: null, locale: null, verified: false } }),
    "GET /v1/conversations/unread": () => ({ count: 0 }),
  };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const handler = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: { code: "not_found", message: url.pathname } }), { status: 404 });
    return new Response(JSON.stringify(handler()), { status: 200 });
  }) as unknown as typeof fetch;
  return new LiveChatClient({ apiUrl: "https://api.test", workspaceKey: "pk", storage: createMemoryStorage(), locale: "en", fetch: fetchImpl, WebSocket: NoopSocket as unknown as typeof WebSocket });
}

async function renderMarkdown(source: string, color?: string, images = false) {
  const client = makeClient();
  await render(
    <LiveChatProvider apiUrl="" workspaceKey="" client={client}>
      <Markdown source={source} color={color} images={images} />
    </LiveChatProvider>,
  );
  await waitFor(() => expect(client.state.status).toBe("ready"));
  return client;
}

const style = (el: { props: Record<string, any> }) => StyleSheet.flatten(el.props.style) ?? {};
const hosts = (type: string) => screen.container.queryAll((n) => n.type === type);

afterEach(() => jest.restoreAllMocks());

describe("Markdown", () => {
  it("renders inline formatting: strong, em, inline code and line breaks", async () => {
    await renderMarkdown("Some **bold** and *italic* and `npm i` text.\nNext line");
    expect(style(screen.getByText("bold")).fontWeight).toBe("700");
    expect(style(screen.getByText("italic")).fontStyle).toBe("italic");
    const code = screen.getByText("npm i");
    expect(style(code).fontFamily).toBe("Menlo");
    expect(style(code).backgroundColor).toBe("#eceef2");
    // The soft line break becomes a newline inside the same paragraph Text.
    expect(screen.getByText("Some bold and italic and npm i text.\nNext line")).toBeTruthy();
  });

  it("renders links that open their href and uses the primary color by default", async () => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await renderMarkdown("Read [the docs](https://docs.test/start) now.");
    const link = screen.getByRole("link", { name: "the docs" });
    expect(style(link).color).toBe("#4F46E5");
    expect(style(link).textDecorationLine).toBe("underline");
    await fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith("https://docs.test/start");
  });

  it("drops unsafe link targets and renders their label as plain text", async () => {
    await renderMarkdown("Click [here](javascript:alert(1)) please");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Click here/)).toBeTruthy();
  });

  it("renders headings with level-based sizes", async () => {
    await renderMarkdown("# Big title\n\n## Smaller\n\n#### Tiny");
    expect(style(screen.getByText("Big title")).fontSize).toBe(22);
    expect(style(screen.getByText("Smaller")).fontSize).toBe(19);
    expect(style(screen.getByText("Tiny")).fontSize).toBe(15);
    expect(style(screen.getByText("Big title")).fontWeight).toBe("700");
  });

  it("renders ordered list numbers and unordered bullets", async () => {
    await renderMarkdown("1. First step\n2. Second step\n\n- apple\n- pear");
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();
    expect(screen.getByText("First step")).toBeTruthy();
    expect(screen.getByText("Second step")).toBeTruthy();
    expect(screen.getAllByText("•")).toHaveLength(2);
    expect(screen.getByText("apple")).toBeTruthy();
    expect(screen.getByText("pear")).toBeTruthy();
  });

  it("renders blockquotes in the muted color", async () => {
    await renderMarkdown("> Quoted **advice**");
    const quote = screen.getByText("Quoted advice");
    expect(style(quote).color).toBe("#6b7280");
    const border = quote.parent?.parent;
    expect(border && style(border).borderLeftWidth).toBe(3);
  });

  it("renders fenced code blocks and horizontal rules", async () => {
    await renderMarkdown("```\nconst x = 1;\nconst y = 2;\n```\n\n---\n\nAfter");
    const code = screen.getByText("const x = 1;\nconst y = 2;");
    expect(style(code).fontFamily).toBe("Menlo");
    const rules = hosts("View").filter((v) => style(v).height === 1 && style(v).backgroundColor === "#e3e5ea");
    expect(rules).toHaveLength(1);
    expect(screen.getByText("After")).toBeTruthy();
  });

  it("renders chat images as a link by default (no tracking pixels)", async () => {
    await renderMarkdown("See this ![Setup diagram](https://cdn.test/diagram.png) here");
    expect(hosts("Image")).toHaveLength(0);
    expect(screen.getByText("Setup diagram")).toBeTruthy();
  });

  it("lifts images out of Text and labels them with their alt text", async () => {
    await renderMarkdown("See this ![Setup diagram](https://cdn.test/diagram.png) here", undefined, true);
    const images = hosts("Image");
    expect(images).toHaveLength(1);
    expect(images[0]!.props.accessibilityLabel).toBe("Setup diagram");
    expect(images[0]!.props.source).toEqual({ uri: "https://cdn.test/diagram.png" });
    // Not nested inside any Text.
    let p = images[0]!.parent;
    while (p) {
      expect(p.type).not.toBe("Text");
      p = p.parent;
    }
    // The surrounding text still renders without the image.
    expect(screen.getByText("See this  here")).toBeTruthy();
  });

  it("applies a custom color to text, links and code blocks", async () => {
    await renderMarkdown("Plain [link](https://x.test)\n\n```\ncode\n```", "#ff0000");
    expect(style(screen.getByText("Plain link")).color).toBe("#ff0000");
    expect(style(screen.getByRole("link", { name: "link" })).color).toBe("#ff0000");
    expect(style(screen.getByText("code")).color).toBe("#ff0000");
  });
});
