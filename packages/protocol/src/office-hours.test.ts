import { describe, expect, it } from "vitest";
import { isWithinOfficeHours } from "./office-hours";
import type { OfficeHours } from "./workspace";

const weekdays9to17: OfficeHours = {
  enabled: true,
  timezone: "Europe/Brussels",
  windows: [1, 2, 3, 4, 5].map((day) => ({ day, open: "09:00", close: "17:00" })),
};

describe("isWithinOfficeHours", () => {
  it("is always online when disabled", () => {
    expect(isWithinOfficeHours({ ...weekdays9to17, enabled: false }, new Date("2026-09-27T03:00:00Z"))).toBe(true);
  });

  it("respects the workspace timezone", () => {
    // Thu 2026-09-24 07:30 UTC = 09:30 Brussels (CEST, UTC+2)
    expect(isWithinOfficeHours(weekdays9to17, new Date("2026-09-24T07:30:00Z"))).toBe(true);
    // 06:30 UTC = 08:30 Brussels
    expect(isWithinOfficeHours(weekdays9to17, new Date("2026-09-24T06:30:00Z"))).toBe(false);
    // close is exclusive: 15:00 UTC = 17:00 Brussels
    expect(isWithinOfficeHours(weekdays9to17, new Date("2026-09-24T15:00:00Z"))).toBe(false);
  });

  it("is offline on weekends", () => {
    expect(isWithinOfficeHours(weekdays9to17, new Date("2026-09-26T10:00:00Z"))).toBe(false);
  });

  it("handles overnight windows spilling into the next day", () => {
    const nightShift: OfficeHours = {
      enabled: true,
      timezone: "UTC",
      windows: [{ day: 5, open: "22:00", close: "06:00" }],
    };
    expect(isWithinOfficeHours(nightShift, new Date("2026-09-25T23:00:00Z"))).toBe(true); // Fri 23:00
    expect(isWithinOfficeHours(nightShift, new Date("2026-09-26T05:59:00Z"))).toBe(true); // Sat 05:59
    expect(isWithinOfficeHours(nightShift, new Date("2026-09-26T06:00:00Z"))).toBe(false);
    expect(isWithinOfficeHours(nightShift, new Date("2026-09-25T05:00:00Z"))).toBe(false); // Fri early
  });
});
