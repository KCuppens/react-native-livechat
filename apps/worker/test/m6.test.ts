import { env } from "cloudflare:test";
import type { CannedReply, Conversation, CsatReport, Message, WorkspaceSettings } from "@kobecuppens/livechat-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { devOutbox } from "../src/lib/mailer";
import { savePushCredentials } from "../src/notifications/credentials";
import { handleNotification } from "../src/notifications/consumer";
import { setupAgentWorkspace, signIn } from "./agent-helpers";
import { json } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function withConversation() {
  const ctx = await setupAgentWorkspace();
  const started = (await (
    await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "Help please" }) })
  ).json()) as { conversation: Conversation };
  const base = `/agent/w/${ctx.ws.id}`;
  return { ...ctx, base, conversationId: started.conversation.id };
}

function pem(der: ArrayBuffer) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

describe("settings", () => {
  it("admins update settings; agents can read but not write", async () => {
    const { admin, base } = await withConversation();
    const res = await admin.call(`${base}/settings`, {
      method: "PATCH",
      body: json({ primaryColor: "#FF0066", locales: ["en", "nl"], greeting: { nl: "Hoi!" }, allowedOrigins: ["https://app.acme.com"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ primaryColor: "#FF0066", locales: ["en", "nl"], greeting: { nl: "Hoi!" }, csatEnabled: true });

    expect((await admin.call(`${base}/settings`, { method: "PATCH", body: json({ defaultLocale: "fr" }) })).status).toBe(400);
    expect((await admin.call(`${base}/settings`, { method: "PATCH", body: json({ allowedOrigins: ["https://x.com/path"] }) })).status).toBe(400);

    await admin.call(`${base.replace(/\/w\/[^/]+$/, "")}/workspaces/${base.split("/").pop()}/members`, { method: "POST", body: json({ email: "sam@acme.com" }) });
    const sam = await signIn("sam@acme.com");
    expect((await sam.call(`${base}/settings`)).status).toBe(200);
    expect((await sam.call(`${base}/settings`, { method: "PATCH", body: json({ name: "Hacked" }) })).status).toBe(403);
  });

  it("rotating the identity secret invalidates old user hashes", async () => {
    const { admin, base, ws, publicCall } = await withConversation();
    const { identitySecret } = (await (await admin.call(`${base}/settings/rotate-identity-secret`, { method: "POST" })).json()) as { identitySecret: string };
    expect(identitySecret).not.toBe(ws.identitySecret);
    const { hmacSha256Hex } = await import("../src/lib/crypto");
    const old = await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0009-0123456789ab", userId: "u1", userHash: await hmacSha256Hex(ws.identitySecret, "u1") }) });
    expect(old.status).toBe(401);
    const fresh = await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0009-0123456789ab", userId: "u1", userHash: await hmacSha256Hex(identitySecret, "u1") }) });
    expect(fresh.status).toBe(200);
  });

  it("stores push credentials encrypted and reports only their status", async () => {
    const { admin, base } = await withConversation();
    const bad = await admin.call(`${base}/settings/push/fcm`, { method: "PUT", body: json({ serviceAccountJson: '{"project_id":"x"}' }) });
    expect(bad.status).toBe(400);
    const ok = await admin.call(`${base}/settings/push/apns`, {
      method: "PUT",
      body: json({ keyP8: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", keyId: "ABC123DEFG", teamId: "TEAM123456" }),
    });
    expect(ok.status).toBe(204);
    const settings = (await (await admin.call(`${base}/settings`)).json()) as WorkspaceSettings;
    expect(settings.push.apnsUpdatedAt).toBeTypeOf("number");
    expect(JSON.stringify(settings)).not.toContain("PRIVATE KEY");
    const row = await env.DB.prepare("SELECT secret_enc FROM push_credentials").first<{ secret_enc: string }>();
    expect(row!.secret_enc).not.toContain("PRIVATE");
  });
});

describe("office hours auto-reply", () => {
  it("replies once when a contact writes outside office hours", async () => {
    const ctx = await setupAgentWorkspace();
    await ctx.admin.call(`/agent/w/${ctx.ws.id}/settings`, {
      method: "PATCH",
      body: json({ officeHours: { enabled: true, timezone: "UTC", windows: [] }, autoReply: { en: "We're closed — back tomorrow at 9." } }),
    });
    const cfg = (await (await ctx.publicCall("/v1/config")).json()) as { online: boolean };
    expect(cfg.online).toBe(false);

    const started = (await (await ctx.publicCall("/v1/conversations", { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0001", body: "hi" }) })).json()) as {
      conversation: Conversation;
    };
    await ctx.publicCall(`/v1/conversations/${started.conversation.id}/messages`, { method: "POST", token: ctx.contactToken, body: json({ clientId: "client-0002", body: "hello?" }) });
    const msgs = (await (await ctx.publicCall(`/v1/conversations/${started.conversation.id}/messages`, { token: ctx.contactToken })).json()) as { items: Message[] };
    expect(msgs.items.map((m) => m.systemEvent ?? m.body)).toEqual(["hi", "auto_reply", "hello?"]);
    expect(msgs.items[1]!.body).toBe("We're closed — back tomorrow at 9.");
  });
});

describe("CSAT and reports", () => {
  it("asks for a rating on resolve, accepts it once requested, and reports it", async () => {
    const { admin, base, publicCall, contactToken, conversationId } = await withConversation();
    expect(
      (await publicCall(`/v1/conversations/${conversationId}/csat`, { method: "POST", token: contactToken, body: json({ score: 5 }) })).status,
    ).toBe(409);

    await admin.call(`${base}/conversations/${conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "Fixed!" }) });
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const msgs = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(msgs.items.map((m) => m.systemEvent).slice(-2)).toEqual(["resolved", "csat_request"]);

    const rate = await publicCall(`/v1/conversations/${conversationId}/csat`, { method: "POST", token: contactToken, body: json({ score: 4, comment: "Quick!" }) });
    expect(rate.status).toBe(204);

    // Reopen + resolve again does not ask twice.
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "open" }) });
    await admin.call(`${base}/conversations/${conversationId}`, { method: "PATCH", body: json({ status: "resolved" }) });
    const after = (await (await publicCall(`/v1/conversations/${conversationId}/messages`, { token: contactToken })).json()) as { items: Message[] };
    expect(after.items.filter((m) => m.systemEvent === "csat_request")).toHaveLength(1);

    const report = (await (await admin.call(`${base}/reports?days=7`)).json()) as CsatReport;
    expect(report).toMatchObject({ responses: 1, average: 4, distribution: [0, 0, 0, 1, 0], conversations: 1, resolved: 1 });
    expect(report.medianFirstResponseMinutes).toBeGreaterThanOrEqual(0);
    expect(report.recentComments[0]).toMatchObject({ score: 4, comment: "Quick!" });
  });
});

describe("canned replies", () => {
  it("CRUD with unique shortcuts", async () => {
    const { admin, base } = await withConversation();
    const created = (await (await admin.call(`${base}/canned-replies`, { method: "POST", body: json({ shortcut: "refund", title: "Refund steps", body: "Go to Billing…" }) })).json()) as CannedReply;
    expect((await admin.call(`${base}/canned-replies`, { method: "POST", body: json({ shortcut: "refund", title: "x", body: "y" }) })).status).toBe(409);
    await admin.call(`${base}/canned-replies/${created.id}`, { method: "PUT", body: json({ shortcut: "refunds", title: "Refund steps", body: "Updated" }) });
    const list = (await (await admin.call(`${base}/canned-replies`)).json()) as CannedReply[];
    expect(list).toEqual([{ id: created.id, shortcut: "refunds", title: "Refund steps", body: "Updated" }]);
    await admin.call(`${base}/canned-replies/${created.id}`, { method: "DELETE" });
    expect(await (await admin.call(`${base}/canned-replies`)).json()).toEqual([]);
  });
});

describe("notifications", () => {
  async function agentReply() {
    const ctx = await withConversation();
    await ctx.publicCall("/v1/push-devices", { method: "POST", token: ctx.contactToken, body: json({ platform: "android", token: "fcm-token-1", appId: "com.acme.app" }) });
    await ctx.publicCall("/v1/push-devices", { method: "POST", token: ctx.contactToken, body: json({ platform: "ios", token: "apns-token-1", appId: "com.acme.app", sandbox: true }) });
    const reply = (await (await ctx.admin.call(`${ctx.base}/conversations/${ctx.conversationId}/messages`, { method: "POST", body: json({ clientId: "agent-client-1", body: "We refunded you" }) })).json()) as Message;
    return { ...ctx, reply };
  }

  it("pushes agent replies via FCM and APNs and drops invalid tokens", async () => {
    const { ws, conversationId, reply } = await agentReply();
    const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    await savePushCredentials(env, ws.id, "fcm", { project_id: "acme-app", client_email: "push@acme.iam", private_key: pem((await crypto.subtle.exportKey("pkcs8", (rsa as CryptoKeyPair).privateKey)) as ArrayBuffer) });
    await savePushCredentials(env, ws.id, "apns", { keyP8: pem((await crypto.subtle.exportKey("pkcs8", (ec as CryptoKeyPair).privateKey)) as ArrayBuffer), keyId: "ABC123DEFG", teamId: "TEAM123456" });

    const requests: { url: string; headers: Headers; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? (url.includes("oauth2") ? init.body : JSON.parse(init.body)) : undefined });
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "ya29.token", expires_in: 3600 });
      if (url.includes("fcm.googleapis.com")) return Response.json({ name: "ok" });
      if (url.includes("push.apple.com")) return new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 });
      throw new Error(`unexpected ${url}`);
    });

    await handleNotification(env, { type: "agent_reply", workspaceId: ws.id, conversationId, messageId: reply.id });

    const fcm = requests.find((r) => r.url.includes("fcm.googleapis.com"))!;
    expect(fcm.url).toBe("https://fcm.googleapis.com/v1/projects/acme-app/messages:send");
    expect(fcm.headers.get("Authorization")).toBe("Bearer ya29.token");
    expect(fcm.body.message).toMatchObject({ token: "fcm-token-1", notification: { title: "owner", body: "We refunded you" }, data: { conversationId } });

    const apns = requests.find((r) => r.url.includes("push.apple.com"))!;
    expect(apns.url).toBe("https://api.sandbox.push.apple.com/3/device/apns-token-1");
    expect(apns.headers.get("apns-topic")).toBe("com.acme.app");
    expect(apns.headers.get("authorization")).toMatch(/^bearer ey/);
    expect(apns.body.aps).toMatchObject({ alert: { title: "owner", body: "We refunded you" }, badge: 1 });

    const remaining = await env.DB.prepare("SELECT token FROM push_devices ORDER BY token").all<{ token: string }>();
    expect(remaining.results.map((r) => r.token)).toEqual(["fcm-token-1"]);
  });

  it("emails an unread reply digest once, and not when already read", async () => {
    const { ws, conversationId, reply, publicCall, contactToken } = await agentReply();
    await env.DB.prepare("UPDATE contacts SET email = 'kim@example.com'").run();
    const count = () => devOutbox.filter((m) => m.to === "kim@example.com").length;
    const before = count();

    // Anonymous contacts typed their own address: never email them.
    await handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt });
    expect(count()).toBe(before);
    await env.DB.prepare("UPDATE contacts SET verified = 1").run();

    await handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt });
    expect(count()).toBe(before + 1);
    expect(devOutbox.at(-1)!.text).toContain("owner: We refunded you");
    expect(devOutbox.at(-1)!.text).not.toContain("Kim"); // contact-supplied name stays out of our mail

    await handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt });
    expect(count()).toBe(before + 1); // cooldown

    await env.DB.prepare("UPDATE conversations SET last_emailed_at = NULL").run();
    await publicCall(`/v1/conversations/${conversationId}/read`, { method: "POST", token: contactToken });
    await handleNotification(env, { type: "email_digest", workspaceId: ws.id, conversationId, since: reply.createdAt });
    expect(count()).toBe(before + 1); // already read
  });

  it("emails agents about new conversations when nobody is online", async () => {
    const { ws, conversationId } = await withConversation();
    const before = devOutbox.length;
    await handleNotification(env, { type: "new_conversation", workspaceId: ws.id, conversationId });
    const mail = devOutbox.slice(before).find((m) => m.to === "owner@acme.com");
    expect(mail?.subject).toBe("[Acme] New conversation from Kim");
    expect(mail?.text).toContain(`/w/${ws.id}/inbox/${conversationId}`);
  });
});
