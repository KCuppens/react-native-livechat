import { env } from "cloudflare:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptString, encryptString, hmacSha256Hex, timingSafeEqualStr } from "../src/lib/crypto";
import { ApiException, conflictOnUnique, onError } from "../src/lib/errors";
import { sendApns } from "../src/notifications/apns";
import { sendFcm } from "../src/notifications/fcm";
import { InvalidPushToken, type PushPayload } from "../src/notifications/types";

function pem(der: ArrayBuffer) {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
}

function randomAesKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const payload: PushPayload = { title: "New reply", body: "Hi there", data: { conversationId: "conv_1" } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lib/crypto", () => {
  it("timingSafeEqualStr returns true for equal strings", () => {
    expect(timingSafeEqualStr("secret-value", "secret-value")).toBe(true);
  });

  it("timingSafeEqualStr returns false for same-length different strings", () => {
    expect(timingSafeEqualStr("abcdef", "abcdeg")).toBe(false);
  });

  it("timingSafeEqualStr returns false on length mismatch without throwing", () => {
    expect(timingSafeEqualStr("short", "much-longer-value")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });

  it("timingSafeEqualStr compares encoded byte length, not string length", () => {
    // "é" is 2 UTF-8 bytes; "ab" is 2 bytes — same byte length, different content
    expect(timingSafeEqualStr("é", "ab")).toBe(false);
    expect(timingSafeEqualStr("é", "a")).toBe(false);
  });

  it("hmacSha256Hex matches RFC 4231 test case 2", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("encryptString/decryptString round-trips, including unicode and empty strings", async () => {
    const key = env.ENCRYPTION_KEY as string;
    for (const text of ["hello world", "", "émoji 🚀 ünïcödé"]) {
      const ct = await encryptString(key, text);
      expect(ct).not.toContain(text || "\u0000");
      expect(await decryptString(key, ct)).toBe(text);
    }
  });

  it("encryptString uses a random IV so identical plaintexts differ", async () => {
    const key = randomAesKey();
    const a = await encryptString(key, "same");
    const b = await encryptString(key, "same");
    expect(a).not.toBe(b);
  });

  it("decryptString with the wrong key throws", async () => {
    const ct = await encryptString(randomAesKey(), "top secret");
    await expect(decryptString(randomAesKey(), ct)).rejects.toThrow();
  });

  it("decryptString with tampered ciphertext throws", async () => {
    const key = randomAesKey();
    const ct = await encryptString(key, "top secret");
    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    await expect(decryptString(key, btoa(String.fromCharCode(...bytes)))).rejects.toThrow();
  });
});

describe("lib/errors", () => {
  function makeApp() {
    const app = new Hono();
    app.onError(onError);
    app.get("/api", () => {
      throw new ApiException(403, "forbidden_thing", "Nope");
    });
    app.get("/http", () => {
      throw new HTTPException(418, { message: "I'm a teapot" });
    });
    app.get("/boom", () => {
      throw new Error("db password=hunter2 leaked");
    });
    app.get("/non-error", () => {
      throw "a string";
    });
    return app;
  }

  it("maps ApiException to its status and code", async () => {
    const res = await makeApp().request("/api");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden_thing", message: "Nope" } });
  });

  it("maps a plain HTTPException to http_error with its status and message", async () => {
    const res = await makeApp().request("/http");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: { code: "http_error", message: "I'm a teapot" } });
  });

  it("maps unknown errors to 500 internal_error without leaking the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp().request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(text).not.toContain("hunter2");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("conflictOnUnique turns a UNIQUE constraint error into a 409 ApiException", () => {
    const handler = conflictOnUnique("email_taken", "Email already in use");
    let caught: unknown;
    try {
      handler(new Error("D1_ERROR: UNIQUE constraint failed: users.email"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiException);
    expect((caught as ApiException).status).toBe(409);
    expect((caught as ApiException).code).toBe("email_taken");
    expect((caught as ApiException).message).toBe("Email already in use");
  });

  it("conflictOnUnique rethrows unrelated errors unchanged", () => {
    const original = new Error("FOREIGN KEY constraint failed");
    expect(() => conflictOnUnique("x", "y")(original)).toThrow(original);
  });

  it("conflictOnUnique works as a promise .catch handler", async () => {
    await expect(Promise.reject(new Error("UNIQUE constraint failed")).catch(conflictOnUnique("dup", "Duplicate"))).rejects.toMatchObject({
      status: 409,
      code: "dup",
    });
  });
});

describe("notifications/apns", () => {
  let keyP8: string;
  beforeAll(async () => {
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    keyP8 = pem((await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer);
  });

  const creds = (teamId: string) => ({ keyP8, keyId: "KEYUNIT001", teamId });

  it("posts to the production host with a URL-encoded device token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await sendApns(creds("TEAM-APNS-PROD"), { token: "ab/cd ef", appId: "com.acme.app", sandbox: false }, { ...payload, badge: 3 });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.push.apple.com/3/device/ab%2Fcd%20ef");
    expect(init?.signal).toBeDefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers["apns-topic"]).toBe("com.acme.app");
    expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const body = JSON.parse(init?.body as string);
    expect(body.aps.badge).toBe(3);
    expect(body.aps.alert).toEqual({ title: "New reply", body: "Hi there" });
  });

  it("uses the sandbox host when sandbox is true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await sendApns(creds("TEAM-APNS-SBX"), { token: "tok", appId: "com.acme.app", sandbox: true }, payload);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.sandbox.push.apple.com/3/device/tok");
  });

  it("reuses the cached provider token for the same team/key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    const c = creds("TEAM-APNS-CACHE");
    await sendApns(c, { token: "t1", appId: "com.acme.app", sandbox: true }, payload);
    await sendApns(c, { token: "t2", appId: "com.acme.app", sandbox: true }, payload);
    const auth = fetchSpy.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).authorization);
    // ES256 signatures are randomized, so equal tokens prove the cache was hit
    expect(auth[0]).toBe(auth[1]);
  });

  it("throws InvalidPushToken on 410", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"reason":"Unregistered"}', { status: 410 }));
    await expect(sendApns(creds("TEAM-APNS-410"), { token: "t", appId: "a", sandbox: false }, payload)).rejects.toBeInstanceOf(InvalidPushToken);
  });

  it("throws InvalidPushToken on 400 BadDeviceToken", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"reason":"BadDeviceToken"}', { status: 400 }));
    await expect(sendApns(creds("TEAM-APNS-400"), { token: "t", appId: "a", sandbox: false }, payload)).rejects.toBeInstanceOf(InvalidPushToken);
  });

  it("throws a generic Error for other failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"reason":"InternalServerError"}', { status: 500 }));
    const err = await sendApns(creds("TEAM-APNS-500"), { token: "t", appId: "a", sandbox: false }, payload).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidPushToken);
    expect(err.message).toContain("APNs send failed: 500");
  });
});

describe("notifications/fcm", () => {
  let privateKey: string;
  beforeAll(async () => {
    const rsa = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    privateKey = pem((await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer);
  });

  const creds = (email: string) => ({ project_id: "unit-proj", client_email: email, private_key: privateKey });

  function mockFcm(send: () => Response) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "ya29.unit", expires_in: 3600 });
      }
      return send();
    });
  }

  it("fetches an access token, then sends with it and an AbortSignal", async () => {
    const fetchSpy = mockFcm(() => new Response("{}", { status: 200 }));
    await sendFcm(creds("send@unit.iam"), "device-tok-0123456789ab", payload);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [oauthUrl, oauthInit] = fetchSpy.mock.calls[0]!;
    expect(String(oauthUrl)).toBe("https://oauth2.googleapis.com/token");
    expect(oauthInit?.signal).toBeDefined();
    const [sendUrl, sendInit] = fetchSpy.mock.calls[1]!;
    expect(String(sendUrl)).toBe("https://fcm.googleapis.com/v1/projects/unit-proj/messages:send");
    expect(sendInit?.signal).toBeDefined();
    expect((sendInit?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.unit");
    expect(JSON.parse(sendInit?.body as string).message.token).toBe("device-tok-0123456789ab");
  });

  it("reuses the cached access token on a second send", async () => {
    const fetchSpy = mockFcm(() => new Response("{}", { status: 200 }));
    const c = creds("cache@unit.iam");
    await sendFcm(c, "t1", payload);
    await sendFcm(c, "t2", payload);
    const oauthCalls = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("https://oauth2.googleapis.com"));
    expect(oauthCalls).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws when the OAuth token exchange fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid_grant", { status: 400 }));
    await expect(sendFcm(creds("authfail@unit.iam"), "t", payload)).rejects.toThrow("FCM auth failed: 400 invalid_grant");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws InvalidPushToken on 404", async () => {
    mockFcm(() => new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 }));
    await expect(sendFcm(creds("404@unit.iam"), "t", payload)).rejects.toBeInstanceOf(InvalidPushToken);
  });

  it("throws InvalidPushToken when the body says UNREGISTERED", async () => {
    mockFcm(() => new Response('{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}', { status: 400 }));
    await expect(sendFcm(creds("unreg@unit.iam"), "t", payload)).rejects.toBeInstanceOf(InvalidPushToken);
  });

  it("throws InvalidPushToken on 400 invalid registration token", async () => {
    mockFcm(() => new Response('{"error":{"message":"The registration token is not a valid FCM registration token"}}', { status: 400 }));
    await expect(sendFcm(creds("badtok@unit.iam"), "t", payload)).rejects.toBeInstanceOf(InvalidPushToken);
  });

  it("throws a generic Error on 500", async () => {
    mockFcm(() => new Response("backend error", { status: 500 }));
    const err = await sendFcm(creds("500@unit.iam"), "t", payload).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidPushToken);
    expect(err.message).toBe("FCM send failed: 500 backend error");
  });
});
