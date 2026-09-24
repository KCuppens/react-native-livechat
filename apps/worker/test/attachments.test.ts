import type { Attachment, Conversation, Message, SessionResponse } from "@kobecuppens/livechat-protocol";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { env } from "cloudflare:test";
import { json, setupWorkspace } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function contact() {
  const ws = await setupWorkspace();
  const s = (await (await ws.call("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab" }) })).json()) as SessionResponse;
  const upload = (body: BodyInit, type: string, name = "shot.png") =>
    ws.call("/v1/attachments", { method: "POST", token: s.token, body, headers: { "Content-Type": type, "X-Filename": encodeURIComponent(name), "X-Width": "640", "X-Height": "480" } });
  return { ...ws, token: s.token, upload };
}

describe("attachments", () => {
  it("uploads, attaches to a message and serves via a signed URL", async () => {
    const { call, token, upload } = await contact();
    const res = await upload(PNG, "image/png", "my screen.png");
    expect(res.status).toBe(201);
    const att = (await res.json()) as Attachment;
    expect(att).toMatchObject({ name: "my screen.png", contentType: "image/png", size: PNG.length, width: 640, height: 480 });

    const started = (await (await call("/v1/conversations", { method: "POST", token, body: json({ clientId: "client-0001", body: "", attachmentIds: [att.id] }) })).json()) as {
      conversation: Conversation;
      message: Message;
    };
    const url = started.message.attachments[0]!.url!;
    expect(url).toMatch(/\/files\/att_.+\?exp=\d+&sig=[0-9a-f]{32}$/);

    const file = await app.request(new URL(url).pathname + new URL(url).search, {}, env);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("image/png");
    expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    const tampered = await app.request(new URL(url).pathname + "?exp=9999999999999&sig=" + "0".repeat(32), {}, env);
    expect(tampered.status).toBe(403);

    // Can't reuse an attachment that's already on a message.
    const reuse = await call(`/v1/conversations/${started.conversation.id}/messages`, { method: "POST", token, body: json({ clientId: "client-0002", body: "", attachmentIds: [att.id] }) });
    expect(reuse.status).toBe(400);
  });

  it("rejects disallowed types and content that doesn't match the declared type", async () => {
    const { upload } = await contact();
    expect((await upload("<html><script>alert(1)</script>", "text/html")).status).toBe(415);
    expect((await upload("<svg onload=alert(1)>", "image/png")).status).toBe(415);
  });

  it("does not let another contact use my upload", async () => {
    const { call, upload } = await contact();
    const att = (await (await upload(PNG, "image/png")).json()) as Attachment;
    const other = (await (await call("/v1/session", { method: "POST", body: json({ deviceId: "device-0002-0123456789ab" }) })).json()) as SessionResponse;
    const res = await call("/v1/conversations", { method: "POST", token: other.token, body: json({ clientId: "client-0001", body: "", attachmentIds: [att.id] }) });
    expect(res.status).toBe(400);
  });
});
