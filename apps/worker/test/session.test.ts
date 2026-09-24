import { env } from "cloudflare:test";
import type { SessionResponse, WorkspaceConfig } from "@kobecuppens/livechat-protocol";
import { describe, expect, it } from "vitest";
import { json, setupWorkspace } from "./helpers";

describe("POST /v1/session", () => {
  it("creates one anonymous contact per device", async () => {
    const { call } = await setupWorkspace();
    const first = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    const second = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", email: "a@b.co" }) })).json()) as SessionResponse;
    const other = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0002-0123456789ab" }) })).json()) as SessionResponse;

    expect(first.contact.verified).toBe(false);
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.contact.email).toBe("a@b.co");
    expect(other.contact.id).not.toBe(first.contact.id);
    expect(first.token).toBeTypeOf("string");
  });

  it("verifies users with a valid HMAC and rejects a forged one", async () => {
    const { call, userHash } = await setupWorkspace();
    const ok = await call("/v1/session", {
      method: "POST",
      body: json({ deviceId: "device-0001-0123456789ab", userId: "user-42", userHash: await userHash("user-42"), name: "Kim" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as SessionResponse;
    expect(body.contact).toMatchObject({ verified: true, externalId: "user-42", name: "Kim" });

    const forged = await call("/v1/session", {
      method: "POST",
      body: json({ deviceId: "device-0001-0123456789ab", userId: "user-42", userHash: "0".repeat(64) }),
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ error: { code: "invalid_user_hash" } });
  });

  it("merges the previous anonymous contact into the verified contact", async () => {
    const { call, userHash, id: workspaceId } = await setupWorkspace();
    const anon = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    await env.DB.prepare(
      "INSERT INTO conversations (id, workspace_id, contact_id, last_message_at, created_at) VALUES ('cv_1', ?, ?, 1, 1)",
    )
      .bind(workspaceId, anon.contact.id)
      .run();

    const verified = (await (
      await call("/v1/session", {
        method: "POST",
        body: json({ deviceId: "device-0001-0123456789ab", userId: "user-42", userHash: await userHash("user-42"), previousToken: anon.token }),
      })
    ).json()) as SessionResponse;

    const conv = await env.DB.prepare("SELECT contact_id FROM conversations WHERE id = 'cv_1'").first<{ contact_id: string }>();
    expect(conv?.contact_id).toBe(verified.contact.id);

    // Logging out (anonymous again on the same device) yields a fresh contact without the merged history.
    const afterLogout = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    expect(afterLogout.contact.id).not.toBe(anon.contact.id);
  });

  it("does not merge using a token from another workspace", async () => {
    const a = await setupWorkspace();
    const b = await setupWorkspace();
    const anonA = (await (await a.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
    await env.DB.prepare(
      "INSERT INTO conversations (id, workspace_id, contact_id, last_message_at, created_at) VALUES ('cv_x', ?, ?, 1, 1)",
    )
      .bind(a.id, anonA.contact.id)
      .run();
    await b.call("/v1/session", {
      method: "POST",
      body: json({ deviceId: "device-0001-0123456789ab", userId: "u", userHash: await b.userHash("u"), previousToken: anonA.token }),
    });
    const conv = await env.DB.prepare("SELECT contact_id FROM conversations WHERE id = 'cv_x'").first<{ contact_id: string }>();
    expect(conv?.contact_id).toBe(anonA.contact.id);
  });

  it("validates the body", async () => {
    const { call } = await setupWorkspace();
    const res = await call("/v1/session", { method: "POST", body: json({ deviceId: "x" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("workspace key and CORS", () => {
  it("rejects unknown keys", async () => {
    const { app } = await import("../src/index");
    const res = await app.request("/v1/config", { headers: { "X-Livechat-Key": "pk_unknown" } }, env);
    expect(res.status).toBe(401);
  });

  it("rejects origins not on the allow-list and echoes allowed ones", async () => {
    const { call } = await setupWorkspace({ allowedOrigins: ["https://app.acme.com"] });
    const blocked = await call("/v1/config", { headers: { Origin: "https://evil.example" } });
    expect(blocked.status).toBe(403);
    const allowed = await call("/v1/config", { headers: { Origin: "https://app.acme.com" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.acme.com");
  });

  it("allows native requests without an Origin header", async () => {
    const { call } = await setupWorkspace({ allowedOrigins: ["https://app.acme.com"] });
    expect((await call("/v1/config")).status).toBe(200);
  });

  it("allows the API's own origin, which React Native sends on socket upgrades", async () => {
    const { app } = await import("../src/index");
    const { publishableKey: key } = await setupWorkspace({ allowedOrigins: ["https://app.acme.com"] });
    const own = new URL(env.PUBLIC_URL).origin;
    const res = await app.request("/v1/config", { headers: { "X-Livechat-Key": key, Origin: own } }, env);
    expect(res.status).toBe(200);
    const other = await app.request("/v1/config", { headers: { "X-Livechat-Key": key, Origin: "https://acme.test" } }, env);
    expect(other.status).toBe(403);
  });

  it("answers preflights", async () => {
    const { app } = await import("../src/index");
    const res = await app.request("/v1/session", { method: "OPTIONS", headers: { Origin: "https://x.dev" } }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Livechat-Key");
  });
});

describe("GET /v1/config", () => {
  it("returns branding, locales and online status", async () => {
    const { call } = await setupWorkspace({ name: "Acme", locales: ["en", "nl"] });
    const cfg = (await (await call("/v1/config")).json()) as WorkspaceConfig;
    expect(cfg).toMatchObject({ branding: { name: "Acme" }, locales: ["en", "nl"], online: true, defaultLocale: "en" });
  });
});
