import { describe, expect, it } from "vitest";
import { ClientEvent, SendMessageRequest, SessionRequest } from "./index";

describe("SessionRequest", () => {
  it("accepts an anonymous session", () => {
    expect(SessionRequest.safeParse({ deviceId: "device-12345-0123456789ab" }).success).toBe(true);
  });

  it("requires userId and userHash together", () => {
    expect(SessionRequest.safeParse({ deviceId: "device-12345-0123456789ab", userId: "u1" }).success).toBe(false);
    expect(
      SessionRequest.safeParse({ deviceId: "device-12345-0123456789ab", userId: "u1", userHash: "a".repeat(64) }).success,
    ).toBe(true);
  });
});

describe("SendMessageRequest", () => {
  it("rejects an empty message without attachments", () => {
    expect(SendMessageRequest.safeParse({ clientId: "client-123", body: "   " }).success).toBe(false);
  });

  it("accepts attachment-only messages and defaults attachmentIds", () => {
    const parsed = SendMessageRequest.parse({ clientId: "client-123", body: "hi" });
    expect(parsed.attachmentIds).toEqual([]);
    expect(
      SendMessageRequest.safeParse({ clientId: "client-123", body: "", attachmentIds: ["a1"] }).success,
    ).toBe(true);
  });
});

describe("ClientEvent", () => {
  it("rejects unknown event types", () => {
    expect(ClientEvent.safeParse({ type: "message", body: "x" }).success).toBe(false);
  });
});

describe("agent schemas", () => {
  it("AgentReplyRequest needs a body or attachments", async () => {
    const { AgentReplyRequest } = await import("./index");
    expect(AgentReplyRequest.safeParse({ clientId: "agent-client-1", body: "  " }).success).toBe(false);
    expect(AgentReplyRequest.safeParse({ clientId: "agent-client-1", body: "", attachmentIds: ["att_1"] }).success).toBe(true);
    expect(AgentReplyRequest.parse({ clientId: "agent-client-1", body: "hi" }).attachmentIds).toEqual([]);
  });

  it("allowedOrigins accepts scheme://host[:port] or * only", async () => {
    const { UpdateWorkspaceSettingsRequest } = await import("./index");
    const ok = (o: string) => UpdateWorkspaceSettingsRequest.safeParse({ allowedOrigins: [o] }).success;
    expect(ok("*")).toBe(true);
    expect(ok("https://app.acme.com")).toBe(true);
    expect(ok("http://localhost:5173")).toBe(true);
    expect(ok("https://app.acme.com/path")).toBe(false);
    expect(ok("app.acme.com")).toBe(false);
  });
});
