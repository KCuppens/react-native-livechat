import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiException extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(status, { message });
  }
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ApiException) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  }
  // One structured object so Workers Logs can filter by route/workspace/ray.
  console.error({
    msg: "unhandled_error",
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ray: c.req.header("cf-ray"),
    error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
  });
  return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
};

/** `.catch()` handler mapping a UNIQUE constraint violation to a 409 with the given code. */
export const conflictOnUnique = (code: string, message: string) => (err: unknown) => {
  if (String(err).includes("UNIQUE")) throw new ApiException(409, code, message);
  throw err;
};
