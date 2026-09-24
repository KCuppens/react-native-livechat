import type { OfficeHours } from "./workspace";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day of week (0 = Sunday) and minutes since midnight of `at` in `timezone`. */
export function zonedClock(at: Date, timezone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: WEEKDAYS.indexOf(get("weekday")),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function toMinutes(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Whether the workspace is within office hours at `at`.
 * Disabled office hours means always online. A window whose close is before its
 * open (e.g. 22:00–06:00) spills over into the next day.
 */
export function isWithinOfficeHours(hours: OfficeHours, at: Date = new Date()): boolean {
  if (!hours.enabled) return true;
  const { day, minutes } = zonedClock(at, hours.timezone);
  const previousDay = (day + 6) % 7;
  return hours.windows.some((w) => {
    const open = toMinutes(w.open);
    const close = toMinutes(w.close);
    if (open < close) return w.day === day && minutes >= open && minutes < close;
    // Overnight window: evening part on w.day, early-morning part on the next day.
    return (w.day === day && minutes >= open) || (w.day === previousDay && minutes < close);
  });
}
