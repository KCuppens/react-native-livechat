import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, onUnauthorized } from "./api";

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

type Reply = { status?: number; body?: unknown; text?: string; statusText?: string };

function stubFetch(reply: Reply = { body: {} }) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, headers: (init.headers ?? {}) as Record<string, string> });
    const status = reply.status ?? 200;
    const payload = status === 204 ? null : reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(payload, { status, statusText: reply.statusText });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api request", () => {
  it("sends the dashboard header and same-origin credentials without a body", async () => {
    const { calls } = stubFetch({ body: { agent: { id: "ag_1" } } });
    await expect(api.me()).resolves.toEqual({ agent: { id: "ag_1" } });
    expect(calls[0]!.url).toBe("/agent/me");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[0]!.headers).toEqual({ "X-Livechat-Dashboard": "1" });
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("serialises JSON bodies and sets Content-Type", async () => {
    const { calls } = stubFetch({ status: 204 });
    await api.requestMagicLink("a@b.co");
    expect(calls[0]!.url).toBe("/agent/auth/magic-link");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({ "X-Livechat-Dashboard": "1", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ email: "a@b.co" });
  });

  it("returns undefined for 204", async () => {
    stubFetch({ status: 204 });
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it("throws ApiError with status, code and message from the error envelope", async () => {
    stubFetch({ status: 403, body: { error: { code: "forbidden", message: "Admins only" } } });
    const err = await api.settings("ws_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "forbidden", message: "Admins only" });
  });

  it("falls back to http_error and statusText for non-JSON error bodies", async () => {
    stubFetch({ status: 500, text: "oops", statusText: "Internal Server Error" });
    await expect(api.me()).rejects.toMatchObject({ status: 500, code: "http_error", message: "Internal Server Error" });
  });

  it("dispatches unauthorized on 401", async () => {
    stubFetch({ status: 401, body: { error: { code: "unauthorized", message: "Sign in" } } });
    const listener = vi.fn();
    onUnauthorized.addEventListener("unauthorized", listener);
    try {
      await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      onUnauthorized.removeEventListener("unauthorized", listener);
    }
  });

  it("does not dispatch unauthorized on other errors", async () => {
    stubFetch({ status: 404, body: { error: { code: "not_found", message: "nf" } } });
    const listener = vi.fn();
    onUnauthorized.addEventListener("unauthorized", listener);
    try {
      await expect(api.me()).rejects.toBeInstanceOf(ApiError);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      onUnauthorized.removeEventListener("unauthorized", listener);
    }
  });
});

describe("api.upload", () => {
  it("sends the raw File with its Content-Type and an encoded filename", async () => {
    const { calls } = stubFetch({ body: { id: "at_1" } });
    const file = new File(["hello"], "résumé final.pdf", { type: "application/pdf" });
    await expect(api.upload("ws 1", file)).resolves.toEqual({ id: "at_1" });
    expect(calls[0]!.url).toBe("/agent/w/ws%201/attachments");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(file);
    expect(calls[0]!.headers).toEqual({
      "X-Livechat-Dashboard": "1",
      "Content-Type": "application/pdf",
      "X-Filename": encodeURIComponent("résumé final.pdf"),
    });
  });
});

describe("api.inbox", () => {
  it("builds an empty query when no filters are given", async () => {
    const { calls } = stubFetch({ body: { items: [], nextCursor: null } });
    await api.inbox("ws_1", {} as never);
    expect(calls[0]!.url).toBe("/agent/w/ws_1/conversations?");
  });

  it("includes only provided filters", async () => {
    const { calls } = stubFetch({ body: { items: [], nextCursor: null } });
    await api.inbox("ws_1", { status: "open", cursor: "c/1" } as never);
    expect(calls[0]!.url).toBe("/agent/w/ws_1/conversations?status=open&cursor=c%2F1");
  });

  it("includes every filter when all are set", async () => {
    const { calls } = stubFetch({ body: { items: [], nextCursor: null } });
    await api.inbox("ws_1", { status: "closed", assignee: "me", cursor: "x" } as never);
    expect(calls[0]!.url).toBe("/agent/w/ws_1/conversations?status=closed&assignee=me&cursor=x");
  });
});

describe("api endpoints", () => {
  const cases: [string, () => Promise<unknown>, string, string, unknown][] = [
    ["verify", () => api.verify("tk"), "POST", "/agent/auth/verify", { token: "tk" }],
    ["reply", () => api.reply("ws_1", "cv_1", { body: "hi" } as never), "POST", "/agent/w/ws_1/conversations/cv_1/messages", { body: "hi" }],
    [
      "updateConversation",
      () => api.updateConversation("ws_1", "cv_1", { status: "closed" } as never),
      "PATCH",
      "/agent/w/ws_1/conversations/cv_1",
      { status: "closed" },
    ],
    ["messages", () => api.messages("ws_1", "cv_1"), "GET", "/agent/w/ws_1/conversations/cv_1/messages", undefined],
    ["messages before", () => api.messages("ws_1", "cv_1", "m_9"), "GET", "/agent/w/ws_1/conversations/cv_1/messages?before=m_9", undefined],
    ["markRead", () => api.markRead("ws_1", "cv_1"), "POST", "/agent/w/ws_1/conversations/cv_1/read", undefined],
    ["saveFaqArticle new", () => api.saveFaqArticle("ws_1", null, { title: "T" } as never), "POST", "/agent/w/ws_1/faq/articles", { title: "T" }],
    ["saveFaqArticle existing", () => api.saveFaqArticle("ws_1", "fa_1", { title: "T" } as never), "PATCH", "/agent/w/ws_1/faq/articles/fa_1", { title: "T" }],
    ["saveFaqCategory new", () => api.saveFaqCategory("ws_1", null, { name: "N" } as never), "POST", "/agent/w/ws_1/faq/categories", { name: "N" }],
    ["saveFaqCategory existing", () => api.saveFaqCategory("ws_1", "fc_1", { name: "N" } as never), "PATCH", "/agent/w/ws_1/faq/categories/fc_1", { name: "N" }],
    ["saveCanned new", () => api.saveCanned("ws_1", null, { title: "c" } as never), "POST", "/agent/w/ws_1/canned-replies", { title: "c" }],
    ["saveCanned existing", () => api.saveCanned("ws_1", "cr_1", { title: "c" } as never), "PUT", "/agent/w/ws_1/canned-replies/cr_1", { title: "c" }],
    ["deleteCanned", () => api.deleteCanned("ws_1", "cr_1"), "DELETE", "/agent/w/ws_1/canned-replies/cr_1", undefined],
    ["deletePush fcm", () => api.deletePush("ws_1", "fcm"), "DELETE", "/agent/w/ws_1/settings/push/fcm", undefined],
    ["deletePush apns", () => api.deletePush("ws_1", "apns"), "DELETE", "/agent/w/ws_1/settings/push/apns", undefined],
    ["saveFcm", () => api.saveFcm("ws_1", "{}"), "PUT", "/agent/w/ws_1/settings/push/fcm", { serviceAccountJson: "{}" }],
    ["report", () => api.report("ws_1", 30), "GET", "/agent/w/ws_1/reports?days=30", undefined],
    ["members", () => api.members("ws_1"), "GET", "/agent/workspaces/ws_1/members", undefined],
    ["removeMember", () => api.removeMember("ws_1", "ag_2"), "DELETE", "/agent/workspaces/ws_1/members/ag_2", undefined],
    ["createWorkspace", () => api.createWorkspace({ name: "Acme" }), "POST", "/agent/workspaces", { name: "Acme" }],
    ["invite", () => api.invite("ws_1", { email: "a@b.co", role: "agent" }), "POST", "/agent/workspaces/ws_1/members", { email: "a@b.co", role: "agent" }],
    ["conversation", () => api.conversation("ws_1", "cv_1"), "GET", "/agent/w/ws_1/conversations/cv_1", undefined],
    ["faqCategories", () => api.faqCategories("ws_1"), "GET", "/agent/w/ws_1/faq/categories", undefined],
    ["deleteFaqCategory", () => api.deleteFaqCategory("ws_1", "fc_1"), "DELETE", "/agent/w/ws_1/faq/categories/fc_1", undefined],
    ["faqArticles", () => api.faqArticles("ws_1"), "GET", "/agent/w/ws_1/faq/articles", undefined],
    ["deleteFaqArticle", () => api.deleteFaqArticle("ws_1", "fa_1"), "DELETE", "/agent/w/ws_1/faq/articles/fa_1", undefined],
    ["updateSettings", () => api.updateSettings("ws_1", { name: "X" } as never), "PATCH", "/agent/w/ws_1/settings", { name: "X" }],
    ["saveApns", () => api.saveApns("ws_1", { keyP8: "k", keyId: "i", teamId: "t" }), "PUT", "/agent/w/ws_1/settings/push/apns", { keyP8: "k", keyId: "i", teamId: "t" }],
    ["canned", () => api.canned("ws_1"), "GET", "/agent/w/ws_1/canned-replies", undefined],
    ["rotateIdentitySecret", () => api.rotateIdentitySecret("ws_1"), "POST", "/agent/w/ws_1/settings/rotate-identity-secret", undefined],
  ];

  it.each(cases)("%s", async (_name, invoke, method, url, body) => {
    const { calls } = stubFetch({ body: {} });
    await invoke();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe(method);
    expect(calls[0]!.url).toBe(url);
    if (body === undefined) {
      expect(calls[0]!.init.body).toBeUndefined();
      expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    } else {
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual(body);
      expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    }
  });
});

describe("api.socketUrl", () => {
  it("uses wss on https pages", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "support.example.com" });
    expect(api.socketUrl("/agent/w/ws_1/ws")).toBe("wss://support.example.com/agent/w/ws_1/ws");
  });

  it("uses ws on http pages", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
    expect(api.socketUrl("/agent/ws")).toBe("ws://localhost:5173/agent/ws");
  });
});
