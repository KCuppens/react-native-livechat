import { env } from "cloudflare:test";
import type { Attachment, CannedReply, Conversation, SessionResponse } from "@kobecuppens/livechat-protocol";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { sha256Hex } from "../src/lib/crypto";
import { signedUrl } from "../src/services/attachments";
import { setupAgentWorkspace } from "./agent-helpers";
import { json, setupWorkspace } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

describe("contact merge", () => {
  it("moves push devices and carries the anonymous email over", async () => {
    const ws = await setupWorkspace();
    const anon = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", email: "kim@example.com" }) })).json()) as SessionResponse;
    await ws.call("/v1/push-devices", { method: "POST", token: anon.token, body: json({ platform: "android", token: "fcm-1", appId: "com.acme" }) });
    const verified = (await (
      await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", userId: "u1", userHash: await ws.userHash("u1"), previousToken: anon.token }) })
    ).json()) as SessionResponse;
    expect(verified.contact.id).not.toBe(anon.contact.id);
    const device = await env.DB.prepare("SELECT contact_id FROM push_devices WHERE token = 'fcm-1'").first<{ contact_id: string }>();
    expect(device?.contact_id).toBe(verified.contact.id);
    const contact = await env.DB.prepare("SELECT email FROM contacts WHERE id = ?").bind(verified.contact.id).first<{ email: string }>();
    expect(contact?.email).toBe("kim@example.com");
  });
});

describe("expiry", () => {
  it("rejects a correctly signed file URL after it expires", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const att = (await (
      await ws.call("/v1/attachments", { method: "POST", token: s.token, body: PNG, headers: { "Content-Type": "image/png" } })
    ).json()) as Attachment;
    const old = new URL(await signedUrl(env, att.id, Date.now() - 30 * 86_400_000));
    expect((await app.request(old.pathname + old.search, {}, env)).status).toBe(403);
  });

  it("rejects an expired magic link and sets no cookie", async () => {
    const token = "expired-token-0123456789abcdef";
    await env.DB.prepare("INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, 'owner@acme.com', ?)")
      .bind(await sha256Hex(token), Date.now() - 1000)
      .run();
    const res = await app.request(
      "/agent/auth/verify",
      { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ token }) },
      env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("canned replies tenancy", () => {
  it("an admin of A cannot edit or delete B's canned replies", async () => {
    const a = await setupAgentWorkspace();
    const b = await setupAgentWorkspace();
    const reply = (await (
      await b.admin.call(`/agent/w/${b.ws.id}/canned-replies`, { method: "POST", body: json({ shortcut: "hi", title: "Hi", body: "Hello" }) })
    ).json()) as CannedReply;
    const put = await a.admin.call(`/agent/w/${a.ws.id}/canned-replies/${reply.id}`, { method: "PUT", body: json({ shortcut: "hacked", title: "x", body: "x" }) });
    expect(put.status).toBe(404);
    await a.admin.call(`/agent/w/${a.ws.id}/canned-replies/${reply.id}`, { method: "DELETE" });
    const list = (await (await b.admin.call(`/agent/w/${b.ws.id}/canned-replies`)).json()) as CannedReply[];
    expect(list).toEqual([reply]);
  });
});

describe("hardening", () => {
  it("accepts ?token= only on WebSocket handshakes", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    expect((await ws.call(`/v1/conversations?token=${s.token}`)).status).toBe(401);
    expect((await ws.call("/v1/conversations", { token: s.token })).status).toBe(200);
  });

  it("rejects push tokens that could change the APNs URL path", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const res = await ws.call("/v1/push-devices", { method: "POST", token: s.token, body: json({ platform: "ios", token: "abc/../x?y", appId: "com.acme" }) });
    expect(res.status).toBe(400);
  });

  it("fails loudly when a required secret is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("http://localhost/health", {}, { ...env, ATTACHMENT_SIGNING_KEY: "" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "misconfigured" } });
    vi.restoreAllMocks();
  });

  it("two messages cannot claim the same attachment", async () => {
    const ws = await setupWorkspace();
    const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const started = (await (await ws.call("/v1/conversations", { method: "POST", token: s.token, body: json({ clientId: "client-0001", body: "hi" }) })).json()) as { conversation: Conversation };
    const att = (await (await ws.call("/v1/attachments", { method: "POST", token: s.token, body: PNG, headers: { "Content-Type": "image/png" } })).json()) as Attachment;
    const send = (clientId: string) =>
      ws.call(`/v1/conversations/${started.conversation.id}/messages`, { method: "POST", token: s.token, body: json({ clientId, body: "", attachmentIds: [att.id] }) });
    const statuses = (await Promise.all([send("client-aaaa1"), send("client-bbbb2")])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 400]);
    const claimed = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE attachments LIKE ?").bind(`%${att.id}%`).first<{ n: number }>();
    expect(claimed!.n).toBe(1);
  });
});
