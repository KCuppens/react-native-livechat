import type { Context } from "hono";
import type { z } from "zod";
import { ApiException } from "./errors";

export async function parseJson<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiException(400, "invalid_json", "Request body must be valid JSON");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApiException(400, "invalid_request", `${issue?.path.join(".") || "body"}: ${issue?.message}`);
  }
  return result.data;
}

/** Positive integer page size from a query param, capped at `max`. */
export function pageLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
