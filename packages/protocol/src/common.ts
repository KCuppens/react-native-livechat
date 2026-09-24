import { z } from "zod";

export const Locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
export type Locale = z.infer<typeof Locale>;

/** Milliseconds since epoch. */
export const Timestamp = z.number().int().nonnegative();

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
