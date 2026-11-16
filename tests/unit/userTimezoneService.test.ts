/**
 * tests/unit/userTimezoneService.test.ts — the DB half of the per-user display
 * timezone (User.timezone / User.detectedTimezone) and serverTimeZone()
 * (business rule 170: the server-local clock is the process's zone, read
 * through Intl per call).
 *
 * The pure resolution helpers are pinned by tests/unit/userTimezone.test.ts;
 * this suite adds getUserTimezone, recordDetectedTimezone, setUserTimezone and
 * the fallbacks of serverTimeZone / listTimeZones.
 *
 * Contract (polaris-change-impact → settings-platform.md): recordDetectedTimezone
 * writes only on CHANGE, is unaudited, refuses anything that does not
 * normalize to a real zone, and never throws; setUserTimezone writes
 * `user.timezone.changed` (actor = the username) and nothing when unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  AUTO_TIMEZONE,
  serverTimeZone,
  listTimeZones,
  getUserTimezone,
  recordDetectedTimezone,
  setUserTimezone,
} from "../../src/services/userTimezoneService.js";

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("serverTimeZone", () => {
  it("follows a TZ change in the running process (computed per call, rule 170)", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      expect(serverTimeZone()).toBe("Asia/Tokyo");
      process.env.TZ = "America/Chicago";
      expect(serverTimeZone()).toBe("America/Chicago");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("answers UTC when Intl resolves no zone", () => {
    const Real = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((...a: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      const f = new Real(...a);
      return Object.assign(Object.create(f), { resolvedOptions: () => ({ ...f.resolvedOptions(), timeZone: "" }) });
    }) as unknown as typeof Intl.DateTimeFormat);
    expect(serverTimeZone()).toBe("UTC");
  });

  it("answers UTC when Intl throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => { throw new Error("no ICU"); }) as unknown as typeof Intl.DateTimeFormat);
    expect(serverTimeZone()).toBe("UTC");
  });
});

describe("listTimeZones — small-ICU fallback", () => {
  it("offers the static US list when supportedValuesOf is unavailable", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => { throw new RangeError("unsupported"); });
    const zones = listTimeZones();
    expect(zones[0]).toBe("UTC");
    expect(zones).toContain("America/Chicago");
    expect(zones).toContain("Pacific/Honolulu");
  });

  it("falls back on an empty list too", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue([]);
    expect(listTimeZones()).toContain("America/New_York");
  });
});

describe("getUserTimezone", () => {
  it("answers the stored zone", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Europe/London" });
    expect(await getUserTimezone("u1")).toBe("Europe/London");
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { timezone: true } });
  });

  it("degrades an unusable or empty stored value to auto", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Mars/Olympus_Mons" });
    expect(await getUserTimezone("u1")).toBe(AUTO_TIMEZONE);
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: null });
    expect(await getUserTimezone("u1")).toBe(AUTO_TIMEZONE);
  });

  it("404s on an unknown user", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue(null);
    await expect(getUserTimezone("nobody")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("recordDetectedTimezone", () => {
  it("writes a changed zone and reports it stuck", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ detectedTimezone: "America/Chicago" });
    expect(await recordDetectedTimezone("u1", "America/Denver")).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { detectedTimezone: "America/Denver" } });
  });

  it("writes the first detection over a null column", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ detectedTimezone: null });
    expect(await recordDetectedTimezone("u1", " Europe/Paris ")).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { detectedTimezone: "Europe/Paris" } });
  });

  it("does not write an unchanged zone (hit on every page load)", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ detectedTimezone: "America/Chicago" });
    expect(await recordDetectedTimezone("u1", "America/Chicago")).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([["garbage", "Not/AZone"], ["auto", "auto"], ["empty", ""], ["non-string", 42], ["null", null]])(
    "refuses %s without reading the row",
    async (_label, tz) => {
      expect(await recordDetectedTimezone("u1", tz)).toBe(false);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it("answers false for an unknown user", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue(null);
    expect(await recordDetectedTimezone("nobody", "UTC")).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("never throws: a DB failure answers false", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ detectedTimezone: null });
    stubbed(prisma.user.update).mockRejectedValue(new Error("db down"));
    expect(await recordDetectedTimezone("u1", "UTC")).toBe(false);
    stubbed(prisma.user.findUnique).mockRejectedValue(new Error("db down"));
    expect(await recordDetectedTimezone("u1", "UTC")).toBe(false);
  });

  it("is never audited", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ detectedTimezone: null });
    await recordDetectedTimezone("u1", "UTC");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("setUserTimezone", () => {
  it("writes the new zone and audits it with the username as actor", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "auto" });
    expect(await setUserTimezone("u1", "alice", "America/Chicago")).toBe("America/Chicago");
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { timezone: "America/Chicago" } });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "user.timezone.changed",
      resourceType: "user",
      resourceId: "u1",
      resourceName: "alice",
      actor: "alice",
      level: "info",
      message: "Display timezone changed from auto to America/Chicago",
      details: { from: "auto", to: "America/Chicago" },
    });
  });

  it("writes and audits nothing when the value does not change", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Europe/Berlin" });
    expect(await setUserTimezone("u1", "alice", "Europe/Berlin")).toBe("Europe/Berlin");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("treats a case-only difference as no change", async () => {
    // Was a bug until 2026-11-16: "europe/berlin" over "Europe/Berlin" was written and audited.
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Europe/Berlin" });
    expect(await setUserTimezone("u1", "alice", "europe/berlin")).toBe("Europe/Berlin");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("compares NORMALIZED values: a stored unusable zone and an empty request are both auto", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Bogus/Zone" });
    expect(await setUserTimezone("u1", "alice", "")).toBe(AUTO_TIMEZONE);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("back to auto from an explicit zone", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Asia/Tokyo" });
    expect(await setUserTimezone("u1", "bob", "auto")).toBe(AUTO_TIMEZONE);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { timezone: "auto" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { from: "Asia/Tokyo", to: "auto" } });
  });

  it("degrades a bogus requested zone to auto (the route's Zod schema is the strict half)", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Asia/Tokyo" });
    expect(await setUserTimezone("u1", "bob", "Not/AZone")).toBe(AUTO_TIMEZONE);
  });

  it("404s on an unknown user and writes nothing", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue(null);
    await expect(setUserTimezone("nobody", "x", "UTC")).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("a failed audit write does not fail the change", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "auto" });
    eventLog.logEvent.mockRejectedValue(new Error("events table locked"));
    expect(await setUserTimezone("u1", "alice", "UTC")).toBe("UTC");
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("a failed user write propagates and is not audited", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "auto" });
    stubbed(prisma.user.update).mockRejectedValue(new Error("db down"));
    await expect(setUserTimezone("u1", "alice", "UTC")).rejects.toThrow("db down");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});
