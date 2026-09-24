import type {
  AgentConversation,
  AgentFaqArticle,
  AgentFaqCategory,
  AgentMe,
  AgentReplyRequest,
  Attachment,
  CannedReply,
  CsatReport,
  InboxFilter,
  Message,
  SaveCannedReplyRequest,
  SaveFaqArticleRequest,
  SaveFaqCategoryRequest,
  UpdateConversationRequest,
  UpdateWorkspaceSettingsRequest,
  WorkspaceSettings,
} from "@kobecuppens/livechat-protocol";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired on 401 so the app can route to /login. */
export const onUnauthorized = new EventTarget();

async function request<T>(method: string, path: string, body?: unknown, raw?: { body: BodyInit; headers: Record<string, string> }): Promise<T> {
  const headers: Record<string, string> = { "X-Livechat-Dashboard": "1", ...raw?.headers };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) onUnauthorized.dispatchEvent(new Event("unauthorized"));
    throw new ApiError(res.status, data?.error?.code ?? "http_error", data?.error?.message ?? res.statusText);
  }
  return data as T;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "admin" | "agent";
  online: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const w = (ws: string) => `/agent/w/${encodeURIComponent(ws)}`;

export const api = {
  requestMagicLink: (email: string) => request<void>("POST", "/agent/auth/magic-link", { email }),
  verify: (token: string) => request<{ agent: AgentMe["agent"] }>("POST", "/agent/auth/verify", { token }),
  logout: () => request<void>("POST", "/agent/auth/logout"),
  me: () => request<AgentMe>("GET", "/agent/me"),
  createWorkspace: (body: { name: string; defaultLocale?: string; locales?: string[] }) =>
    request<{ id: string; publishableKey: string; identitySecret: string }>("POST", "/agent/workspaces", body),

  members: (ws: string) => request<Member[]>("GET", `/agent/workspaces/${ws}/members`),
  invite: (ws: string, body: { email: string; name?: string; role: "admin" | "agent" }) => request<Member>("POST", `/agent/workspaces/${ws}/members`, body),
  removeMember: (ws: string, agentId: string) => request<void>("DELETE", `/agent/workspaces/${ws}/members/${agentId}`),

  inbox: (ws: string, filter: InboxFilter) => {
    const q = new URLSearchParams();
    if (filter.status) q.set("status", filter.status);
    if (filter.assignee) q.set("assignee", filter.assignee);
    if (filter.cursor) q.set("cursor", filter.cursor);
    return request<Page<AgentConversation>>("GET", `${w(ws)}/conversations?${q}`);
  },
  conversation: (ws: string, id: string) => request<AgentConversation>("GET", `${w(ws)}/conversations/${id}`),
  messages: (ws: string, id: string, before?: string) =>
    request<Page<Message>>("GET", `${w(ws)}/conversations/${id}/messages${before ? `?before=${before}` : ""}`),
  reply: (ws: string, id: string, body: AgentReplyRequest) => request<Message>("POST", `${w(ws)}/conversations/${id}/messages`, body),
  updateConversation: (ws: string, id: string, body: UpdateConversationRequest) =>
    request<AgentConversation>("PATCH", `${w(ws)}/conversations/${id}`, body),
  markRead: (ws: string, id: string) => request<void>("POST", `${w(ws)}/conversations/${id}/read`),
  upload: (ws: string, file: File) =>
    request<Attachment>("POST", `${w(ws)}/attachments`, undefined, {
      body: file,
      headers: { "Content-Type": file.type, "X-Filename": encodeURIComponent(file.name) },
    }),

  faqCategories: (ws: string) => request<AgentFaqCategory[]>("GET", `${w(ws)}/faq/categories`),
  saveFaqCategory: (ws: string, id: string | null, body: SaveFaqCategoryRequest) =>
    request<AgentFaqCategory>(id ? "PATCH" : "POST", `${w(ws)}/faq/categories${id ? `/${id}` : ""}`, body),
  deleteFaqCategory: (ws: string, id: string) => request<void>("DELETE", `${w(ws)}/faq/categories/${id}`),
  faqArticles: (ws: string) => request<AgentFaqArticle[]>("GET", `${w(ws)}/faq/articles`),
  saveFaqArticle: (ws: string, id: string | null, body: SaveFaqArticleRequest) =>
    request<AgentFaqArticle>(id ? "PATCH" : "POST", `${w(ws)}/faq/articles${id ? `/${id}` : ""}`, body),
  deleteFaqArticle: (ws: string, id: string) => request<void>("DELETE", `${w(ws)}/faq/articles/${id}`),

  settings: (ws: string) => request<WorkspaceSettings>("GET", `${w(ws)}/settings`),
  updateSettings: (ws: string, body: UpdateWorkspaceSettingsRequest) => request<WorkspaceSettings>("PATCH", `${w(ws)}/settings`, body),
  rotateIdentitySecret: (ws: string) => request<{ identitySecret: string }>("POST", `${w(ws)}/settings/rotate-identity-secret`),
  saveFcm: (ws: string, serviceAccountJson: string) => request<void>("PUT", `${w(ws)}/settings/push/fcm`, { serviceAccountJson }),
  saveApns: (ws: string, body: { keyP8: string; keyId: string; teamId: string }) => request<void>("PUT", `${w(ws)}/settings/push/apns`, body),
  deletePush: (ws: string, kind: "fcm" | "apns") => request<void>("DELETE", `${w(ws)}/settings/push/${kind}`),

  canned: (ws: string) => request<CannedReply[]>("GET", `${w(ws)}/canned-replies`),
  saveCanned: (ws: string, id: string | null, body: SaveCannedReplyRequest) =>
    request<CannedReply>(id ? "PUT" : "POST", `${w(ws)}/canned-replies${id ? `/${id}` : ""}`, body),
  deleteCanned: (ws: string, id: string) => request<void>("DELETE", `${w(ws)}/canned-replies/${id}`),

  report: (ws: string, days: number) => request<CsatReport>("GET", `${w(ws)}/reports?days=${days}`),

  socketUrl: (path: string) => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`,
};
