/**
 * tests/unit/firmwareSchedule.test.ts
 *
 * Scheduled firmware upgrades (business rule 93): what a booking checks when
 * it is made, how the job fires it (start / refuse / wait on a related flash /
 * miss), that a booking fires at most once, that cancel and change only touch
 * a PENDING booking, and that the recipients hear every outcome exactly once.
 *
 * startFirmwareUpgrade is mocked: the gates it re-takes at fire time are
 * firmwareUpgradeGates.test.ts's subject. This file is about the booking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  class FakeAppError extends Error {
    httpStatus: number;
    constructor(status: number, msg: string) { super(msg); this.httpStatus = status; this.name = "AppError"; }
  }
  class FakeConflict extends FakeAppError {
    constructor(msg: string) { super(409, msg); this.name = "FirmwareRunConflictError"; }
  }
  const state = {
    rows: [] as Array<Record<string, any>>,
    runs: new Map<string, Record<string, any>>(),
    users: [] as Array<{ email: string; timezone: string; detectedTimezone: string | null }>,
    channel: { id: "ch-1", type: "smtp", enabled: true, config: {} } as Record<string, unknown> | null,
    sent: [] as Array<{ to: string[]; subject: string; text: string }>,
    sendFails: new Set<string>(),
    seq: 0,
  };
  return {
    state, FakeAppError, FakeConflict,
    logEvent: vi.fn(async () => {}),
    checkSchedulableUpgrade: vi.fn(async (_assetId: string, imageId: string) => ({
      approved: { id: imageId, versionLabel: imageId === "img-backup" ? "7.6.5 build1105" : "7.6.8 build1164", role: imageId === "img-backup" ? "backup" : "primary" },
      fromVersion: "7.4.3 build0542",
      warnings: [] as string[],
    })),
    startFirmwareUpgrade: vi.fn(async () => ({ id: "run-1" })),
  };
});

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      if ("lte" in v && !(row[k] <= v.lte)) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

vi.mock("../../src/utils/errors.js", () => ({ AppError: h.FakeAppError }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    firmwareUpgradeSchedule: {
      // Copies, as Prisma returns: a read must not see a later write.
      findFirst: vi.fn(async ({ where }: any) => { const r = h.state.rows.find((x) => matches(x, where)); return r ? { ...r } : null; }),
      findUnique: vi.fn(async ({ where }: any) => { const r = h.state.rows.find((x) => (where.id ? x.id === where.id : x.runId === where.runId)); return r ? { ...r } : null; }),
      findMany: vi.fn(async ({ where }: any) => h.state.rows.filter((r) => matches(r, where)).sort((a, b) => a.scheduledFor - b.scheduledFor)),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `sch-${++h.state.seq}`, status: "pending", runId: null, error: null, updatedBy: null, cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        h.state.rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = h.state.rows.find((x) => x.id === where.id);
        if (!r) throw new Error("no row");
        Object.assign(r, data);
        return r;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = h.state.rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
    firmwareUpgradeRun: { findUnique: vi.fn(async ({ where }: any) => h.state.runs.get(where.id) ?? null) },
    asset: { findUnique: vi.fn(async () => ({ hostname: "lab-sw1", ipAddress: "10.0.0.5", model: "FortiSwitch S108FF", osVersion: "7.4.3 build0542" })) },
    user: { findMany: vi.fn(async () => h.state.users), findUnique: vi.fn(async () => ({ email: "Ops@Example.com" })) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({
  checkSchedulableUpgrade: h.checkSchedulableUpgrade,
  startFirmwareUpgrade: h.startFirmwareUpgrade,
  FirmwareRunConflictError: h.FakeConflict,
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn(async () => h.state.channel) }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: vi.fn(async (m: any) => m),
  sendEmailThroughChannel: vi.fn(async (_c: unknown, m: any) => {
    if (h.state.sendFails.has(m.to[0])) throw new Error("SMTP 550");
    h.state.sent.push(m);
  }),
}));
vi.mock("../../src/services/userTimezoneService.js", () => ({
  resolveTimeZone: (tz: string) => (tz === "auto" ? "UTC" : tz),
  serverTimeZone: () => "America/Chicago",
}));

import {
  normalizeRecipients,
  assertSchedulableTime,
  createSchedule,
  updateSchedule,
  cancelSchedule,
  runDueSchedules,
  notifyScheduledRunFinished,
  defaultRecipientsFor,
  LATE_GRACE_MS,
  CONFLICT_WAIT_MS,
} from "../../src/services/firmwareScheduleService.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const LATER = new Date("2026-10-07T07:00:00Z");

async function book(over: Partial<{ scheduledFor: Date; notifyEmails: string[]; imageId: string }> = {}) {
  return createSchedule({
    assetId: "asset-1",
    imageId: over.imageId ?? "img-primary",
    scheduledFor: over.scheduledFor ?? LATER,
    notifyEmails: over.notifyEmails ?? ["ops@example.com"],
    actor: "alice",
    now: NOW,
  });
}

beforeEach(() => {
  h.state.rows = [];
  h.state.runs = new Map();
  h.state.users = [];
  h.state.channel = { id: "ch-1", type: "smtp", enabled: true, config: {} };
  h.state.sent = [];
  h.state.sendFails = new Set();
  h.logEvent.mockClear();
  h.startFirmwareUpgrade.mockReset();
  h.startFirmwareUpgrade.mockImplementation(async () => ({ id: "run-1" }));
  h.checkSchedulableUpgrade.mockClear();
});

describe("normalizeRecipients / assertSchedulableTime (pure)", () => {
  it("lower-cases, trims, de-duplicates and accepts comma leftovers", () => {
    expect(normalizeRecipients([" Ops@Example.com", "ops@example.com", "", "noc@example.com "])).toEqual(["ops@example.com", "noc@example.com"]);
  });
  it("refuses a non-address, naming it", () => {
    expect(() => normalizeRecipients(["ops@example.com", "not-an-address"])).toThrow(/"not-an-address" is not an email address/);
  });
  it("refuses an empty list — someone always hears the outcome", () => {
    expect(() => normalizeRecipients(["", "  "])).toThrow(/at least one email/);
  });
  it("refuses a time in the past, within the next minute, or more than a year out", () => {
    expect(() => assertSchedulableTime(new Date(NOW.getTime() - 1000), NOW)).toThrow(/at least a minute/);
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + 30_000), NOW)).toThrow(/at least a minute/);
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + 400 * 86_400_000), NOW)).toThrow(/within the next year/);
    expect(() => assertSchedulableTime(LATER, NOW)).not.toThrow();
  });
});

describe("booking", () => {
  it("takes the image gates, stores the approved image's version and writes an Event", async () => {
    const s = await book({ imageId: "img-backup" });
    expect(h.checkSchedulableUpgrade).toHaveBeenCalledWith("asset-1", "img-backup");
    expect(s.status).toBe("pending");
    expect(s.toVersion).toBe("7.6.5 build1105");
    expect(s.notifyEmails).toEqual(["ops@example.com"]);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "firmware.upgrade_scheduled", actor: "alice" }));
  });

  it("refuses a second pending booking on the same device (409)", async () => {
    await book();
    await expect(book()).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("a refused image gate makes no row", async () => {
    h.checkSchedulableUpgrade.mockRejectedValueOnce(new h.FakeAppError(400, "Image x is not offered for this device"));
    await expect(book()).rejects.toThrow(/not offered/);
    expect(h.state.rows).toHaveLength(0);
  });

  it("pre-fills the booker's own profile email, lower-cased", async () => {
    expect(await defaultRecipientsFor("user-1")).toEqual(["ops@example.com"]);
    expect(await defaultRecipientsFor(null)).toEqual([]);
  });
});

describe("change and cancel touch only a PENDING booking", () => {
  it("changes the time and recipients and writes a rescheduled Event naming the change", async () => {
    const s = await book();
    const next = new Date("2026-10-08T07:00:00Z");
    const u = await updateSchedule({ assetId: "asset-1", scheduleId: s.id, scheduledFor: next, notifyEmails: ["noc@example.com"], actor: "bob", now: NOW });
    expect(u.scheduledFor).toEqual(next);
    expect(u.notifyEmails).toEqual(["noc@example.com"]);
    expect(h.logEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: "firmware.upgrade_rescheduled", actor: "bob", message: expect.stringContaining("time") }));
  });

  it("re-takes the image gates only when the image changes", async () => {
    const s = await book();
    h.checkSchedulableUpgrade.mockClear();
    await updateSchedule({ assetId: "asset-1", scheduleId: s.id, notifyEmails: ["noc@example.com"], actor: "bob", now: NOW });
    expect(h.checkSchedulableUpgrade).not.toHaveBeenCalled();
    const u = await updateSchedule({ assetId: "asset-1", scheduleId: s.id, imageId: "img-backup", actor: "bob", now: NOW });
    expect(h.checkSchedulableUpgrade).toHaveBeenCalledWith("asset-1", "img-backup");
    expect(u.toVersion).toBe("7.6.5 build1105");
  });

  it("cancel marks it cancelled; a started booking can be neither changed nor cancelled", async () => {
    const s = await book();
    const c = await cancelSchedule("asset-1", s.id, "bob");
    expect(c.status).toBe("cancelled");
    expect(c.cancelledBy).toBe("bob");
    await expect(cancelSchedule("asset-1", s.id, "bob")).rejects.toMatchObject({ httpStatus: 409 });

    const s2 = await book();
    h.state.rows.find((r) => r.id === s2.id)!.status = "started";
    await expect(updateSchedule({ assetId: "asset-1", scheduleId: s2.id, scheduledFor: LATER, actor: "bob", now: NOW })).rejects.toMatchObject({ httpStatus: 409 });
    await expect(cancelSchedule("asset-1", s2.id, "bob")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("another asset's booking id answers 404", async () => {
    const s = await book();
    await expect(cancelSchedule("asset-2", s.id, "bob")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("firing (runDueSchedules)", () => {
  it("leaves a booking that is not yet due alone", async () => {
    await book();
    const res = await runDueSchedules(NOW);
    expect(res).toEqual({ started: 0, refused: 0, missed: 0, waiting: 0 });
    expect(h.startFirmwareUpgrade).not.toHaveBeenCalled();
  });

  it("starts a due booking through startFirmwareUpgrade with the booked image, the booker and the booking id — once", async () => {
    const s = await book();
    const at = new Date(LATER.getTime() + 20_000);
    expect((await runDueSchedules(at)).started).toBe(1);
    expect(h.startFirmwareUpgrade).toHaveBeenCalledWith({ assetId: "asset-1", imageId: "img-primary", actor: "alice", scheduleId: s.id });
    expect(h.state.rows[0].status).toBe("started");
    expect(h.state.rows[0].firedAt).toEqual(at);
    // A second tick finds nothing pending.
    await runDueSchedules(new Date(at.getTime() + 60_000));
    expect(h.startFirmwareUpgrade).toHaveBeenCalledTimes(1);
    // Nobody is emailed at START — only when the run ends.
    expect(h.state.sent).toHaveLength(0);
  });

  it("a gate refusal at fire time is recorded, logged and emailed — never retried", async () => {
    await book({ notifyEmails: ["ops@example.com", "noc@example.com"] });
    h.startFirmwareUpgrade.mockRejectedValueOnce(new h.FakeAppError(409, "Cannot start: the device is down — an upgrade needs a device that is answering"));
    const res = await runDueSchedules(new Date(LATER.getTime() + 1000));
    expect(res.refused).toBe(1);
    expect(h.state.rows[0]).toMatchObject({ status: "refused", error: expect.stringContaining("device is down") });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "firmware.upgrade_schedule_refused", level: "warning" }));
    expect(h.state.sent.map((m) => m.to[0])).toEqual(["ops@example.com", "noc@example.com"]);
    expect(h.state.sent[0].subject).toMatch(/was not started: lab-sw1 → 7\.6\.8 build1164/);
    await runDueSchedules(new Date(LATER.getTime() + 120_000));
    expect(h.startFirmwareUpgrade).toHaveBeenCalledTimes(1);
  });

  it("a booking whose image was deleted is refused without calling the start", async () => {
    await book();
    h.state.rows[0].imageId = null;
    await runDueSchedules(new Date(LATER.getTime() + 1000));
    expect(h.startFirmwareUpgrade).not.toHaveBeenCalled();
    expect(h.state.rows[0]).toMatchObject({ status: "refused", error: expect.stringContaining("deleted from the Repository") });
  });

  it("first seen more than the grace late = missed: nothing starts, the recipients are told", async () => {
    await book();
    const res = await runDueSchedules(new Date(LATER.getTime() + LATE_GRACE_MS + 60_000));
    expect(res.missed).toBe(1);
    expect(h.startFirmwareUpgrade).not.toHaveBeenCalled();
    expect(h.state.rows[0].status).toBe("missed");
    expect(h.state.sent[0].subject).toMatch(/was missed/);
  });

  it("a related flash in progress makes it WAIT (still pending, reason shown), then start when it clears", async () => {
    await book();
    h.startFirmwareUpgrade.mockRejectedValueOnce(new h.FakeConflict("A firmware upgrade is running on core-sw1, which is above, below or paired with this device — wait for it to finish"));
    const r1 = await runDueSchedules(new Date(LATER.getTime() + 1000));
    expect(r1.waiting).toBe(1);
    expect(h.state.rows[0]).toMatchObject({ status: "pending", firedAt: null, error: expect.stringContaining("core-sw1") });
    expect(h.state.sent).toHaveLength(0);
    // Past the late grace it keeps waiting — it was seen on time.
    const r2 = await runDueSchedules(new Date(LATER.getTime() + LATE_GRACE_MS + 5 * 60_000));
    expect(r2.started).toBe(1);
    expect(h.state.rows[0]).toMatchObject({ status: "started", error: null });
  });

  it("a wait longer than CONFLICT_WAIT_MS gives up: refused and emailed", async () => {
    await book();
    h.startFirmwareUpgrade.mockRejectedValue(new h.FakeConflict("A firmware upgrade is running on core-sw1, which is above, below or paired with this device — wait for it to finish"));
    await runDueSchedules(new Date(LATER.getTime() + 1000));
    const res = await runDueSchedules(new Date(LATER.getTime() + CONFLICT_WAIT_MS + 60_000));
    expect(res.refused).toBe(1);
    expect(h.state.rows[0]).toMatchObject({ status: "refused", error: expect.stringContaining("still waiting") });
    expect(h.state.sent).toHaveLength(1);
  });
});

describe("the results email (notifyScheduledRunFinished)", () => {
  async function startedBooking(run: Record<string, unknown>) {
    const s = await book({ notifyEmails: ["ops@example.com", "noc@example.com"] });
    Object.assign(h.state.rows[0], { status: "started", runId: "run-1", firedAt: LATER });
    h.state.runs.set("run-1", {
      status: "succeeded", result: "upgraded", error: null, fromVersion: "7.4.3 build0542", toVersion: "7.6.8 build1164",
      verifiedVersion: "7.6.8 build1164", startedAt: LATER, finishedAt: new Date(LATER.getTime() + 9 * 60_000),
      log: Array.from({ length: 40 }, (_, i) => ({ t: LATER.toISOString(), level: "info", msg: `line ${i}` })),
      ...run,
    });
    return s;
  }

  it("emails every recipient once, with the outcome, the versions and the log tail", async () => {
    await startedBooking({});
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent.map((m) => m.to[0])).toEqual(["ops@example.com", "noc@example.com"]);
    expect(h.state.sent[0].subject).toBe("[Polaris] Scheduled firmware upgrade succeeded: lab-sw1 → 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("Device reports: 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("line 39");
    expect(h.state.sent[0].text).not.toContain("line 10\n");
    expect(h.state.rows[0].notifiedAt).toBeInstanceOf(Date);
    // A second caller (runner + boot sweep racing) sends nothing.
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent).toHaveLength(2);
  });

  it("says FAILED with the error on a failed run", async () => {
    await startedBooking({ status: "failed", result: "failed", error: "device web UI unreachable", verifiedVersion: null });
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent[0].subject).toMatch(/FAILED/);
    expect(h.state.sent[0].text).toContain("device web UI unreachable");
  });

  it("draws each recipient's times in their own zone when the address is a user's, else the server's", async () => {
    h.state.users = [{ email: "ops@example.com", timezone: "America/New_York", detectedTimezone: null }];
    await startedBooking({});
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent[0].text).toContain("Times are shown in America/New_York");
    expect(h.state.sent[1].text).toContain("Times are shown in America/Chicago");
  });

  it("does nothing for a run nobody booked, or one still running", async () => {
    await notifyScheduledRunFinished("run-unbooked");
    await startedBooking({ status: "running" });
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.rows[0].notifiedAt).toBeNull();
  });

  it("no email channel: records why and writes a warning Event instead", async () => {
    h.state.channel = null;
    await startedBooking({});
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.rows[0].notifyError).toMatch(/no enabled email channel/);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "firmware.upgrade_schedule_email_failed", level: "warning" }));
  });

  it("one recipient failing does not stop the others, and the failure is recorded", async () => {
    h.state.sendFails.add("ops@example.com");
    await startedBooking({});
    await notifyScheduledRunFinished("run-1");
    expect(h.state.sent.map((m) => m.to[0])).toEqual(["noc@example.com"]);
    expect(h.state.rows[0].notifyError).toMatch(/ops@example.com: SMTP 550/);
  });
});
