/**
 * tests/unit/firmwareHoldKind.test.ts
 *
 * The maintenance hold a firmware flash takes (business rules 80 and 87):
 * its kind exists, its label is what the chart band and the Maintenance tab
 * will print, and its cap is sized to a FortiSwitch flash plus reboot rather
 * than to the agent holds it sits beside.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { MAINTENANCE_HOLD_KINDS, holdTtlMinutes } from "../../src/services/maintenanceScheduleService.js";

describe("the firmware-upgrade hold", () => {
  it("is a known kind with an operator-facing label", () => {
    expect(MAINTENANCE_HOLD_KINDS["firmware-upgrade"]).toBe("Firmware upgrade");
  });
  it("caps at 45 minutes — ~15 min flash, up to 15 min reboot, verify retries, headroom", () => {
    expect(holdTtlMinutes("firmware-upgrade")).toBe(45);
    // Longer than any agent hold, because a flash is; not open-ended, because
    // a release that never runs must still end (rule 80).
    expect(holdTtlMinutes("firmware-upgrade")).toBeGreaterThan(holdTtlMinutes("agent-reinstall"));
  });
});
