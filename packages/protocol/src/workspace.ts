import { z } from "zod";
import { Locale } from "./common";

/** "HH:MM" 24h clock in the workspace timezone. */
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const OfficeHoursWindow = z.object({
  /** 0 = Sunday … 6 = Saturday */
  day: z.number().int().min(0).max(6),
  open: ClockTime,
  close: ClockTime,
});
export type OfficeHoursWindow = z.infer<typeof OfficeHoursWindow>;

export const OfficeHours = z.object({
  enabled: z.boolean(),
  /** IANA timezone, e.g. "Europe/Brussels" */
  timezone: z.string().min(1),
  windows: z.array(OfficeHoursWindow),
});
export type OfficeHours = z.infer<typeof OfficeHours>;

export const Branding = z.object({
  name: z.string(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  logoUrl: z.string().url().nullable(),
  /** Per-locale greeting shown on the help home screen. */
  greeting: z.record(z.string(), z.string()),
});
export type Branding = z.infer<typeof Branding>;

/** Public config served to SDKs (GET /v1/config). */
export const WorkspaceConfig = z.object({
  workspaceId: z.string(),
  branding: Branding,
  defaultLocale: Locale,
  locales: z.array(Locale).min(1),
  officeHours: OfficeHours,
  /** Computed server-side at request time. */
  online: z.boolean(),
  /** Typical first reply time in minutes while online, null when unknown. */
  typicalReplyMinutes: z.number().int().positive().nullable(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;
