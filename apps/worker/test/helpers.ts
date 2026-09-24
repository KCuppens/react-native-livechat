import { env } from "cloudflare:test";
import { app } from "../src/index";
import { hmacSha256Hex } from "../src/lib/crypto";
import { createWorkspace, type CreateWorkspaceInput } from "../src/services/workspaces";

export async function setupWorkspace(input: Partial<CreateWorkspaceInput> = {}) {
  const ws = await createWorkspace(env.DB, env.ENCRYPTION_KEY, { name: "Acme", ...input });
  const call = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Livechat-Key", ws.publishableKey);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    return app.request(path, { ...init, headers }, env);
  };
  const userHash = (userId: string) => hmacSha256Hex(ws.identitySecret, userId);
  return { ...ws, call, userHash };
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
