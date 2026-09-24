import { env } from "cloudflare:test";
import type { SessionResponse } from "@kobecuppens/livechat-protocol";
import { app } from "../src/index";
import { devOutbox } from "../src/lib/mailer";
import { json } from "./helpers";

/** Signs in through the magic-link flow and returns a cookie-bearing request helper. */
export async function signIn(email: string) {
  const before = devOutbox.length;
  const res = await app.request(
    "/agent/auth/magic-link",
    { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ email }) },
    env,
  );
  if (res.status !== 204) throw new Error(`magic-link failed: ${res.status}`);
  // Match the sign-in link specifically: queue jobs (e.g. new-conversation alerts) can also mail this address.
  const mail = devOutbox.slice(before).find((m) => m.to.toLowerCase() === email.toLowerCase() && m.text.includes("#token="));
  if (!mail) throw new Error(`no email sent to ${email}`);
  const token = /#token=([\w-]+)/.exec(mail.text)![1]!;
  const verify = await app.request(
    "/agent/auth/verify",
    { method: "POST", headers: { "Content-Type": "application/json", "X-Livechat-Dashboard": "1" }, body: json({ token }) },
    env,
  );
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status}`);
  const cookie = verify.headers.get("Set-Cookie")!.split(";")[0]!;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Cookie", cookie);
    headers.set("X-Livechat-Dashboard", "1");
    if (init.body) headers.set("Content-Type", "application/json");
    return app.request(path, { ...init, headers }, env);
  };
  return { call, cookie, token };
}

/** Super admin creates a workspace; returns agent + public helpers bound to it. */
export async function setupAgentWorkspace() {
  const admin = await signIn("owner@acme.com");
  const ws = (await (await admin.call("/agent/workspaces", { method: "POST", body: json({ name: "Acme", allowedOrigins: ["*"] }) })).json()) as {
    id: string;
    publishableKey: string;
    identitySecret: string;
  };
  const publicCall = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Livechat-Key", ws.publishableKey);
    if (init.body) headers.set("Content-Type", "application/json");
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    return app.request(path, { ...init, headers }, env);
  };
  const session = (await (await publicCall("/v1/session", { method: "POST", body: json({ deviceId: "device-0001-0123456789ab", name: "Kim" }) })).json()) as SessionResponse;
  return { admin, ws, publicCall, contactToken: session.token, contactId: session.contact.id };
}
