import { describe, expect, it, vi } from "vitest";
import { LiveChatApiError, LiveChatHttp, type HttpOptions } from "./http";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

type Reply = { status?: number; body?: unknown; text?: string; statusText?: string } | Error;

/** Records every fetch call and answers with queued replies (last reply repeats). */
function recordingFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    const reply = replies.length > 1 ? replies.shift()! : replies[0] ?? { status: 200, body: {} };
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const payload = status === 204 ? null : reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(payload, { status, statusText: reply.statusText });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeHttp(replies: Reply[] = [], overrides: Partial<HttpOptions> = {}) {
  const server = recordingFetch(...replies);
  const getToken = vi.fn(async () => "tok_1");
  const onInvalidToken = vi.fn(async () => {});
  const http = new LiveChatHttp({
    apiUrl: "https://api.example.com",
    workspaceKey: "pk_123",
    fetch: server.fetch,
    getToken,
    onInvalidToken,
    ...overrides,
  });
  return { http, calls: server.calls, getToken, onInvalidToken };
}

const path = (c: Call) => c.url.replace("https://api.example.com", "");

describe("LiveChatApiError.retryable", () => {
  it.each([
    [0, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [404, false],
    [401, false],
  ])("status %i -> %s", (status, expected) => {
    expect(new LiveChatApiError(status, "x", "m").retryable).toBe(expected);
  });

  it("carries status, code, message and name", () => {
    const err = new LiveChatApiError(422, "invalid", "Bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LiveChatApiError");
    expect(err.status).toBe(422);
    expect(err.code).toBe("invalid");
    expect(err.message).toBe("Bad input");
  });
});

describe("LiveChatHttp request", () => {
  it("trims trailing slashes from apiUrl", async () => {
    const { http, calls } = makeHttp([{ body: {} }], { apiUrl: "https://api.example.com///" });
    expect(http.apiUrl).toBe("https://api.example.com");
    await http.getConfig();
    expect(calls[0]!.url).toBe("https://api.example.com/v1/config");
  });

  it("falls back to globalThis.fetch when no fetch is provided", async () => {
    const server = recordingFetch({ body: { ok: true } });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);
    try {
      const http = new LiveChatHttp({
        apiUrl: "https://api.example.com",
        workspaceKey: "pk_123",
        getToken: async () => "t",
        onInvalidToken: async () => {},
      });
      await expect(http.getConfig()).resolves.toEqual({ ok: true });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("sends workspace key and bearer token on authenticated requests", async () => {
    const { http, calls, getToken } = makeHttp([{ body: { count: 3 } }]);
    await expect(http.getUnreadCount()).resolves.toEqual({ count: 3 });
    expect(getToken).toHaveBeenCalledOnce();
    expect(calls[0]!.headers).toEqual({ "X-Livechat-Key": "pk_123", Authorization: "Bearer tok_1" });
    expect(calls[0]!.body).toBeUndefined();
  });

  it("sends no Authorization header when auth is false", async () => {
    const { http, calls, getToken } = makeHttp([{ body: {} }]);
    await http.createSession({} as never);
    expect(getToken).not.toHaveBeenCalled();
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[0]!.headers["X-Livechat-Key"]).toBe("pk_123");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!)).toBe("/v1/session");
  });

  it("serialises JSON bodies with a JSON content type", async () => {
    const { http, calls } = makeHttp([{ body: { id: "m1" } }]);
    await http.sendMessage("cv 1", { body: "hello" } as never);
    expect(calls[0]!.method).toBe("POST");
    expect(path(calls[0]!)).toBe("/v1/conversations/cv%201/messages");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ body: "hello" });
  });

  it("returns undefined for 204 responses", async () => {
    const { http } = makeHttp([{ status: 204 }]);
    await expect(http.markRead("cv_1")).resolves.toBeUndefined();
  });

  it("maps a thrown fetch error to status 0 network_error", async () => {
    const { http } = makeHttp([new TypeError("Failed to fetch")]);
    const err = await http.getConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveChatApiError);
    expect(err).toMatchObject({ status: 0, code: "network_error", message: "Failed to fetch", retryable: true });
  });

  it("uses a default message when fetch rejects with a non-Error", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      throw "boom";
    }) as unknown as typeof fetch;
    const { http } = makeHttp([], { fetch: fetchImpl });
    await expect(http.getConfig()).rejects.toMatchObject({ status: 0, code: "network_error", message: "Network request failed" });
  });

  it("uses the error envelope code and message", async () => {
    const { http } = makeHttp([{ status: 422, body: { error: { code: "validation", message: "Body too long" } } }]);
    await expect(http.getConfig()).rejects.toMatchObject({ status: 422, code: "validation", message: "Body too long", retryable: false });
  });

  it("falls back to http_error and statusText for non-JSON error bodies", async () => {
    const { http } = makeHttp([{ status: 502, text: "<html>Bad Gateway</html>", statusText: "Bad Gateway" }]);
    const err = await http.getConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveChatApiError);
    expect(err).toMatchObject({ status: 502, code: "http_error", message: "Bad Gateway", retryable: true });
  });

  it("refreshes the session and retries once on 401 invalid_token", async () => {
    const { http, calls, onInvalidToken, getToken } = makeHttp([
      { status: 401, body: { error: { code: "invalid_token", message: "expired" } } },
      { body: { count: 1 } },
    ]);
    getToken.mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    await expect(http.getUnreadCount()).resolves.toEqual({ count: 1 });
    expect(onInvalidToken).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.Authorization).toBe("Bearer old");
    expect(calls[1]!.headers.Authorization).toBe("Bearer new");
  });

  it("throws when the retried request also returns 401 invalid_token", async () => {
    const unauthorized = { status: 401, body: { error: { code: "invalid_token", message: "still bad" } } };
    const { http, calls, onInvalidToken } = makeHttp([unauthorized, unauthorized, { body: {} }]);
    await expect(http.getUnreadCount()).rejects.toMatchObject({ status: 401, code: "invalid_token", message: "still bad" });
    expect(onInvalidToken).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 401 with a different code", async () => {
    const { http, calls, onInvalidToken } = makeHttp([{ status: 401, body: { error: { code: "forbidden", message: "no" } } }]);
    await expect(http.getUnreadCount()).rejects.toMatchObject({ status: 401, code: "forbidden" });
    expect(onInvalidToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401 invalid_token on unauthenticated requests", async () => {
    const { http, calls, onInvalidToken } = makeHttp([{ status: 401, body: { error: { code: "invalid_token", message: "x" } } }]);
    await expect(http.getConfig()).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    expect(onInvalidToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});

describe("LiveChatHttp.uploadAttachment", () => {
  it("sends the raw body with content type, encoded filename and rounded dimensions", async () => {
    const { http, calls } = makeHttp([{ body: { id: "at_1" } }]);
    const bytes = new ArrayBuffer(4);
    await expect(
      http.uploadAttachment({ body: bytes, name: "my photo é.png", type: "image/png", size: 4, width: 100.6, height: 49.4 }),
    ).resolves.toEqual({ id: "at_1" });
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(path(call)).toBe("/v1/attachments");
    expect(call.body).toBe(bytes);
    expect(call.headers).toEqual({
      "X-Filename": encodeURIComponent("my photo é.png"),
      "X-Width": "101",
      "X-Height": "49",
      "Content-Type": "image/png",
      "X-Livechat-Key": "pk_123",
      Authorization: "Bearer tok_1",
    });
  });

  it("omits dimension headers when width/height are absent", async () => {
    const { http, calls } = makeHttp([{ body: {} }]);
    await http.uploadAttachment({ body: new ArrayBuffer(1), name: "doc.pdf", type: "application/pdf", size: 1 });
    expect(calls[0]!.headers["X-Width"]).toBeUndefined();
    expect(calls[0]!.headers["X-Height"]).toBeUndefined();
    expect(calls[0]!.headers["Content-Type"]).toBe("application/pdf");
  });

  it("omits Content-Type when the file type is empty", async () => {
    const { http, calls } = makeHttp([{ body: {} }]);
    await http.uploadAttachment({ body: new ArrayBuffer(1), name: "x", type: "", size: 1 });
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });
});

describe("LiveChatHttp endpoints", () => {
  const cases: [string, (h: LiveChatHttp) => Promise<unknown>, string, string, unknown, boolean][] = [
    // name, invoke, method, path, json body (undefined = none), authenticated
    ["getConfig", (h) => h.getConfig(), "GET", "/v1/config", undefined, false],
    ["listConversations", (h) => h.listConversations(), "GET", "/v1/conversations", undefined, true],
    ["listConversations cursor", (h) => h.listConversations("a/b c"), "GET", "/v1/conversations?cursor=a%2Fb%20c", undefined, true],
    ["getConversation", (h) => h.getConversation("cv/1"), "GET", "/v1/conversations/cv%2F1", undefined, true],
    ["getUnreadCount", (h) => h.getUnreadCount(), "GET", "/v1/conversations/unread", undefined, true],
    ["startConversation", (h) => h.startConversation({ body: "hi" } as never), "POST", "/v1/conversations", { body: "hi" }, true],
    ["listMessages", (h) => h.listMessages("cv_1"), "GET", "/v1/conversations/cv_1/messages", undefined, true],
    ["listMessages before", (h) => h.listMessages("cv_1", "m 9"), "GET", "/v1/conversations/cv_1/messages?before=m%209", undefined, true],
    ["markRead", (h) => h.markRead("cv_1"), "POST", "/v1/conversations/cv_1/read", undefined, true],
    ["submitCsat", (h) => h.submitCsat("cv_1", { score: 5 } as never), "POST", "/v1/conversations/cv_1/csat", { score: 5 }, true],
    [
      "registerPushDevice",
      (h) => h.registerPushDevice({ token: "t", platform: "ios" } as never),
      "POST",
      "/v1/push-devices",
      { token: "t", platform: "ios" },
      true,
    ],
    ["unregisterPushDevice", (h) => h.unregisterPushDevice("ab:c/d"), "DELETE", "/v1/push-devices/ab%3Ac%2Fd", undefined, true],
    ["listFaqCategories", (h) => h.listFaqCategories("pt-BR"), "GET", "/v1/faq/categories?locale=pt-BR", undefined, false],
    ["listFaqArticles minimal", (h) => h.listFaqArticles({ locale: "en" }), "GET", "/v1/faq/articles?locale=en", undefined, false],
    [
      "listFaqArticles full",
      (h) => h.listFaqArticles({ locale: "en", category: "billing", sort: "popular", limit: 5 }),
      "GET",
      "/v1/faq/articles?locale=en&category=billing&sort=popular&limit=5",
      undefined,
      false,
    ],
    ["searchFaq default mode", (h) => h.searchFaq("reset password", { locale: "en" }), "GET", "/v1/faq/articles?q=reset+password&locale=en&mode=all", undefined, false],
    [
      "searchFaq any + limit",
      (h) => h.searchFaq("a&b", { locale: "fr", mode: "any", limit: 3 }),
      "GET",
      "/v1/faq/articles?q=a%26b&locale=fr&mode=any&limit=3",
      undefined,
      false,
    ],
    ["getFaqArticle", (h) => h.getFaqArticle("how to/pay", "en"), "GET", "/v1/faq/articles/how%20to%2Fpay?locale=en", undefined, false],
    ["sendFaqFeedback", (h) => h.sendFaqFeedback("fa_1", false), "POST", "/v1/faq/articles/fa_1/feedback", { helpful: false }, false],
  ];

  it.each(cases)("%s", async (_name, invoke, method, expectedPath, body, authed) => {
    const { http, calls } = makeHttp([{ body: {} }]);
    await invoke(http);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe(method);
    expect(path(call)).toBe(expectedPath);
    if (body === undefined) {
      expect(call.body).toBeUndefined();
      expect(call.headers["Content-Type"]).toBeUndefined();
    } else {
      expect(JSON.parse(call.body as string)).toEqual(body);
      expect(call.headers["Content-Type"]).toBe("application/json");
    }
    if (authed) expect(call.headers.Authorization).toBe("Bearer tok_1");
    else expect(call.headers.Authorization).toBeUndefined();
  });
});

describe("LiveChatHttp.socketUrl", () => {
  it("converts https to wss and encodes key and token", async () => {
    const { http, getToken, calls } = makeHttp([], { workspaceKey: "pk a&b" });
    getToken.mockResolvedValueOnce("t=1/2");
    await expect(http.socketUrl("cv/1")).resolves.toBe("wss://api.example.com/v1/conversations/cv%2F1/ws?key=pk%20a%26b&token=t%3D1%2F2");
    expect(calls).toHaveLength(0);
  });

  it("converts http to ws", async () => {
    const { http } = makeHttp([], { apiUrl: "http://localhost:8787/" });
    await expect(http.socketUrl("cv_1")).resolves.toBe("ws://localhost:8787/v1/conversations/cv_1/ws?key=pk_123&token=tok_1");
  });
});
