/**
 * tests/unit/firmwareScheduleService.test.ts — the own suite for
 * src/services/firmwareScheduleService.ts (business rule 93, with 122's group
 * guard; CQ-T010).
 *
 * Complements firmwareSchedule.test.ts (an in-memory booking table driving the
 * whole booking → fire → email flow). This file pins, against the shared
 * Prisma stub, what that one does not reach:
 *   - the pure guards' edges (normalizeRecipients' max / allowEmpty / 254-char
 *     cap, assertSchedulableTime's NaN and exact boundaries);
 *   - the reads (summarize defaults, listSchedulesForAsset's limit clamp);
 *   - createSchedule's ordering (time before recipients before group before
 *     image), the picker-spec path, the P2002 race and the Event;
 *   - updateSchedule / cancelSchedule's race 409s and Event wording;
 *   - fireDueBookings as a pure loop over a fake BookingFiring (miss vs wait
 *     vs claim lost vs conflict vs refusal, the boundaries at exactly
 *     LATE_GRACE_MS / CONFLICT_WAIT_MS);
 *   - runDueSchedules' claim / clearWait / wait writes;
 *   - notifyScheduledRunFinished's outcome mapping and log tail, and the
 *     notifiedAt claim that makes the results email once-only.
 *
 * No flash and no SMTP: firmwareUpgradeService, firmwareEmailService and
 * operationNotifyService are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  checkSchedulable: vi.fn(),
  startUpgrade: vi.fn(),
  emailAsset: vi.fn(),
  sendEmail: vi.fn(),
  prepareNotify: vi.fn(),
  targetFor: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/firmwareUpgradeService.js", async () => {
  const { AppError } = await import("../../src/utils/errors.js");
  class FirmwareRunConflictError extends AppError {
    constructor(message: string) { super(409, message); this.name = "FirmwareRunConflictError"; }
  }
  return { FirmwareRunConflictError, checkSchedulableUpgrade: h.checkSchedulable, startFirmwareUpgrade: h.startUpgrade };
});
vi.mock("../../src/services/firmwareEmailService.js", () => ({ firmwareEmailAsset: h.emailAsset, sendFirmwareEmail: h.sendEmail }));
vi.mock("../../src/services/operationNotifyService.js", () => ({ prepareNotify: h.prepareNotify, targetFor: h.targetFor }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { FirmwareRunConflictError } from "../../src/services/firmwareUpgradeService.js";
import {
  AUTOMATION_MAX_RECIPIENTS,
  CONFLICT_WAIT_MS,
  LATE_GRACE_MS,
  MAX_RECIPIENTS,
  MIN_LEAD_MS,
  assertSchedulableTime,
  cancelSchedule,
  createSchedule,
  fireDueBookings,
  getPendingSchedule,
  listSchedulesForAsset,
  normalizeRecipients,
  notifyScheduledRunFinished,
  runDueSchedules,
  updateSchedule,
  type BookingFiring,
  type ScheduleSummary,
} from "../../src/services/firmwareScheduleService.js";

const NOW = new Date("2026-03-07T15:00:00.000Z");
const LATER = new Date("2026-03-08T07:00:00.000Z");

const sched = prisma.firmwareUpgradeSchedule;

function row(over: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "sch-1", assetId: "a-1", imageId: "img-1", toVersion: "7.6.8 build1164", scheduledFor: LATER,
    notifyEmails: ["ops@example.com"], notifyRecipients: null, notifyChannelIds: [], status: "pending",
    runId: null, error: null, createdBy: "alice", createdAt: NOW, updatedBy: null, updatedAt: NOW,
    cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null,
    ...over,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function expectStatus(p: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.checkSchedulable.mockResolvedValue({
    approved: { id: "img-1", versionLabel: "7.6.8 build1164", role: "primary" },
    fromVersion: "7.4.3 build0542",
    warnings: [],
  });
  h.startUpgrade.mockResolvedValue({ id: "run-1" });
  h.emailAsset.mockResolvedValue({ deviceName: "sw-core", model: "FS-448E", osVersion: "7.4.3" });
  h.sendEmail.mockResolvedValue(null);
  h.targetFor.mockImplementation(async (r: { notifyEmails: string[]; notifyChannelIds?: string[] }) => ({ to: r.notifyEmails, cc: [], bcc: [], channelIds: r.notifyChannelIds ?? [] }));
  stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "sw-core", ipAddress: "10.0.0.5", model: "FS-448E" });
  stubbed(prisma.firmwareGroupMember.findFirst).mockResolvedValue(null);
  stubbed(sched.findFirst).mockResolvedValue(null);
  stubbed(sched.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row({ ...data, id: "sch-new" } as Partial<ScheduleSummary>));
  stubbed(sched.updateMany).mockResolvedValue({ count: 1 });
});

// ─── Pure guards ──────────────────────────────────────────────────────────────

describe("normalizeRecipients", () => {
  it("trims, lower-cases, skips blanks and de-duplicates keeping first order", () => {
    expect(normalizeRecipients([" B@x.io ", "", "a@x.io", "b@X.IO"])).toEqual(["b@x.io", "a@x.io"]);
  });
  it("treats null / undefined entries as blanks", () => {
    expect(normalizeRecipients([null as unknown as string, "a@x.io", undefined as unknown as string])).toEqual(["a@x.io"]);
  });
  it("refuses an address with no dot in the domain, quoting the raw input", () => {
    expect(() => normalizeRecipients(["Bob@Local"])).toThrow('"Bob@Local" is not an email address');
  });
  it("refuses an address with an inner space", () => {
    expect(() => normalizeRecipients(["a b@x.io"])).toThrow(/is not an email address/);
  });
  it("refuses an address longer than 254 characters with 400", () => {
    const long = `${"a".repeat(250)}@x.io`;
    try { normalizeRecipients([long]); expect.unreachable(); } catch (e) { expect((e as AppError).httpStatus).toBe(400); }
  });
  it("refuses an empty list by default, but allows it for a Cc / Bcc list", () => {
    expect(() => normalizeRecipients(["  "])).toThrow(/at least one email address/);
    expect(normalizeRecipients([], { allowEmpty: true })).toEqual([]);
  });
  it("caps at MAX_RECIPIENTS after de-duplication", () => {
    const twenty = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `u${i}@x.io`);
    expect(normalizeRecipients([...twenty, "U0@x.io"])).toHaveLength(MAX_RECIPIENTS);
    expect(() => normalizeRecipients([...twenty, "extra@x.io"])).toThrow(`At most ${MAX_RECIPIENTS} recipients`);
  });
  it("a resolved automation list may widen the cap", () => {
    const many = Array.from({ length: 150 }, (_, i) => `u${i}@x.io`);
    expect(normalizeRecipients(many, { max: AUTOMATION_MAX_RECIPIENTS })).toHaveLength(150);
  });
});

describe("assertSchedulableTime", () => {
  it("refuses an invalid date", () => {
    expect(() => assertSchedulableTime(new Date("nope"), NOW)).toThrow(/not a valid date/);
  });
  it("accepts exactly MIN_LEAD_MS ahead and refuses one millisecond less", () => {
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + MIN_LEAD_MS), NOW)).not.toThrow();
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + MIN_LEAD_MS - 1), NOW)).toThrow(/at least a minute/);
  });
  it("accepts 366 days ahead and refuses one millisecond more", () => {
    const max = 366 * 24 * 60 * 60_000;
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + max), NOW)).not.toThrow();
    expect(() => assertSchedulableTime(new Date(NOW.getTime() + max + 1), NOW)).toThrow(/within the next year/);
  });
  it("defaults now to the clock", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      expect(() => assertSchedulableTime(new Date(NOW.getTime() + 30_000))).toThrow(AppError);
      expect(() => assertSchedulableTime(new Date(NOW.getTime() + 120_000))).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
});

// ─── Reads ────────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("getPendingSchedule answers null when nothing is pending", async () => {
    expect(await getPendingSchedule("a-1")).toBeNull();
    expect(sched.findFirst).toHaveBeenCalledWith({ where: { assetId: "a-1", status: "pending" } });
  });
  it("getPendingSchedule defaults a missing spec to null and missing channels to []", async () => {
    stubbed(sched.findFirst).mockResolvedValue({ ...row(), notifyRecipients: undefined, notifyChannelIds: undefined, extra: "dropped" });
    const s = await getPendingSchedule("a-1");
    expect(s?.notifyRecipients).toBeNull();
    expect(s?.notifyChannelIds).toEqual([]);
    expect(s).not.toHaveProperty("extra");
  });
  it("listSchedulesForAsset clamps the limit into 1..100, newest first", async () => {
    stubbed(sched.findMany).mockResolvedValue([row()]);
    await listSchedulesForAsset("a-1", 0);
    expect(stubbed(sched.findMany).mock.calls[0][0]).toMatchObject({ take: 1, orderBy: { createdAt: "desc" } });
    await listSchedulesForAsset("a-1", 5000);
    expect(stubbed(sched.findMany).mock.calls[1][0].take).toBe(100);
    const out = await listSchedulesForAsset("a-1");
    expect(stubbed(sched.findMany).mock.calls[2][0].take).toBe(20);
    expect(out[0].id).toBe("sch-1");
  });
});

// ─── createSchedule ───────────────────────────────────────────────────────────

describe("createSchedule", () => {
  const base = { assetId: "a-1", imageId: "img-1", scheduledFor: LATER, notifyEmails: ["Ops@Example.com"], actor: "alice", now: NOW };

  it("checks the time first: a past time is 400 before anything is read", async () => {
    await expectStatus(createSchedule({ ...base, scheduledFor: new Date(NOW.getTime() - 1) }), 400);
    expect(h.checkSchedulable).not.toHaveBeenCalled();
    expect(prisma.firmwareGroupMember.findFirst).not.toHaveBeenCalled();
  });

  it("refuses bad recipients before the group and image gates", async () => {
    await expectStatus(createSchedule({ ...base, notifyEmails: ["not-an-address"] }), 400);
    expect(prisma.firmwareGroupMember.findFirst).not.toHaveBeenCalled();
    expect(h.checkSchedulable).not.toHaveBeenCalled();
  });

  it("names a running group upgrade in the 409", async () => {
    stubbed(prisma.firmwareGroupMember.findFirst).mockResolvedValue({ group: { status: "running", scheduledFor: LATER } });
    await expectStatus(createSchedule(base), 409, /that is running now/);
  });

  it("names a pending group's time in the 409 and does not take the image gate", async () => {
    stubbed(prisma.firmwareGroupMember.findFirst).mockResolvedValue({ group: { status: "pending", scheduledFor: LATER } });
    await expectStatus(createSchedule(base), 409, new RegExp(`scheduled for ${LATER.toISOString()}`));
    expect(h.checkSchedulable).not.toHaveBeenCalled();
  });

  it("asks only for live group members of pending / running groups", async () => {
    await createSchedule(base);
    expect(stubbed(prisma.firmwareGroupMember.findFirst).mock.calls[0][0].where).toEqual({
      assetId: "a-1", state: { in: ["planned", "waiting", "running"] }, group: { status: { in: ["pending", "running"] } },
    });
  });

  it("a refused image gate propagates and makes no row", async () => {
    h.checkSchedulable.mockRejectedValue(new AppError(400, "image is not approved"));
    await expectStatus(createSchedule(base), 400, /not approved/);
    expect(sched.create).not.toHaveBeenCalled();
  });

  it("refuses a second pending booking (409) without creating", async () => {
    stubbed(sched.findFirst).mockResolvedValue({ id: "sch-old" });
    await expectStatus(createSchedule(base), 409, /already scheduled/);
    expect(sched.create).not.toHaveBeenCalled();
  });

  it("the one-pending-per-asset unique index losing a race is the same 409", async () => {
    stubbed(sched.create).mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expectStatus(createSchedule(base), 409, /already scheduled/);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("any other create failure is rethrown as is", async () => {
    const boom = new Error("db down");
    stubbed(sched.create).mockRejectedValue(boom);
    await expect(createSchedule(base)).rejects.toBe(boom);
  });

  it("stores the APPROVED image's id and version, normalized recipients and no spec", async () => {
    h.checkSchedulable.mockResolvedValue({ approved: { id: "img-9", versionLabel: "7.6.9", role: "backup" }, fromVersion: null, warnings: ["w1"] });
    const out = await createSchedule(base);
    const data = stubbed(sched.create).mock.calls[0][0].data;
    expect(data).toEqual({ assetId: "a-1", imageId: "img-9", toVersion: "7.6.9", scheduledFor: LATER, notifyEmails: ["ops@example.com"], notifyChannelIds: [], createdBy: "alice" });
    expect(data).not.toHaveProperty("notifyRecipients");
    expect(out.warnings).toEqual(["w1"]);
    expect(out.id).toBe("sch-new");
  });

  it("writes firmware.upgrade_scheduled naming the versions, the image role and the recipients", async () => {
    await createSchedule(base);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "firmware.upgrade_scheduled", resourceType: "asset", resourceId: "a-1", resourceName: "sw-core", actor: "alice", level: "info" });
    expect(ev.message).toBe(`Firmware upgrade scheduled for ${LATER.toISOString()}: 7.4.3 build0542 → 7.6.8 build1164 (primary image); results to ops@example.com`);
    expect(ev.details).toMatchObject({ scheduleId: "sch-new", imageId: "img-1", notifyRecipients: null, notifyChannelIds: [], warnings: [] });
  });

  it("an unknown current version reads 'unknown'; a hostname-less asset is named by its IP", async () => {
    h.checkSchedulable.mockResolvedValue({ approved: { id: "img-1", versionLabel: "7.6.8", role: "primary" }, fromVersion: null, warnings: [] });
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: null, ipAddress: "10.9.9.9", model: null });
    await createSchedule(base);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.message).toContain("unknown → 7.6.8");
    expect(ev.resourceName).toBe("10.9.9.9");
  });

  it("with a picker spec, stores what prepareNotify resolved and ignores notifyEmails", async () => {
    h.prepareNotify.mockResolvedValue({ notifyEmails: ["r@x.io"], notifyRecipients: { to: [{ kind: "role" }], cc: null, bcc: null }, notifyChannelIds: ["ch-2"] });
    const notify = { to: ["r@x.io"], channelIds: ["ch-2"] } as never;
    await createSchedule({ ...base, notifyEmails: ["bad"], notify });
    expect(h.prepareNotify).toHaveBeenCalledWith("a-1", notify);
    const data = stubbed(sched.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ notifyEmails: ["r@x.io"], notifyRecipients: { to: [{ kind: "role" }] }, notifyChannelIds: ["ch-2"] });
  });

  it("sends a 'scheduled' notice off the request path to everyone, with the warnings", async () => {
    h.checkSchedulable.mockResolvedValue({ approved: { id: "img-1", versionLabel: "7.6.8", role: "primary" }, fromVersion: "7.4.3", warnings: ["low disk"] });
    await createSchedule(base);
    await flush();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const [target, facts] = h.sendEmail.mock.calls[0];
    expect(target.to).toEqual(["ops@example.com"]);
    expect(facts).toMatchObject({ outcome: "scheduled", scheduled: true, fromVersion: "7.4.3", toVersion: "7.6.8", scheduledBy: "alice", warnings: ["low disk"], log: [] });
  });

  it("a notice that cannot be sent is a warning Event; the booking stands", async () => {
    h.sendEmail.mockResolvedValue("no email channel");
    const out = await createSchedule(base);
    await flush();
    expect(out.status).toBe("pending");
    const failed = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "firmware.upgrade_schedule_email_failed");
    expect(failed).toMatchObject({ level: "warning", actor: "system:firmware", resourceName: "sw-core" });
    expect(failed?.message).toContain('"scheduled" email');
    expect(failed?.details).toMatchObject({ notice: "scheduled", notifyEmails: ["ops@example.com"], error: "no email channel" });
    expect(sched.update).not.toHaveBeenCalled(); // notifyError is the results email's, not the notice's
  });

  it("a notice that throws is swallowed", async () => {
    h.emailAsset.mockRejectedValue(new Error("asset gone"));
    await expect(createSchedule(base)).resolves.toMatchObject({ id: "sch-new" });
    await flush();
  });
});

// ─── updateSchedule ───────────────────────────────────────────────────────────

describe("updateSchedule", () => {
  const upd = { assetId: "a-1", scheduleId: "sch-1", actor: "bob", now: NOW };

  it("404s an unknown id and another asset's id alike", async () => {
    stubbed(sched.findUnique).mockResolvedValue(null);
    await expectStatus(updateSchedule(upd), 404);
    stubbed(sched.findUnique).mockResolvedValue(row({ assetId: "a-2" }));
    await expectStatus(updateSchedule(upd), 404, /not found/);
  });

  it("refuses a booking that is no longer pending, naming its status", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ status: "refused" }));
    await expectStatus(updateSchedule(upd), 409, /already refused/);
    expect(sched.updateMany).not.toHaveBeenCalled();
  });

  it("refuses while the device is in a group", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    stubbed(prisma.firmwareGroupMember.findFirst).mockResolvedValue({ group: { status: "running", scheduledFor: LATER } });
    await expectStatus(updateSchedule(upd), 409, /group firmware upgrade/);
  });

  it("checks a new time", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    await expectStatus(updateSchedule({ ...upd, scheduledFor: NOW }), 400, /at least a minute/);
  });

  it("is conditional on still pending: a claim racing it is 409", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    stubbed(sched.updateMany).mockResolvedValue({ count: 0 });
    await expectStatus(updateSchedule({ ...upd, scheduledFor: new Date(LATER.getTime() + 3_600_000) }), 409, /already started or been cancelled/);
    expect(stubbed(sched.updateMany).mock.calls[0][0].where).toEqual({ id: "sch-1", status: "pending" });
  });

  it("a same-image id does not re-take the image gate", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    await updateSchedule({ ...upd, imageId: "img-1" });
    expect(h.checkSchedulable).not.toHaveBeenCalled();
    expect(stubbed(sched.updateMany).mock.calls[0][0].data).toEqual({ updatedBy: "bob" });
  });

  it("a new image re-takes the gate and stores the approved version; its warnings come back", async () => {
    const before = row();
    const after = row({ imageId: "img-2", toVersion: "7.6.9" });
    stubbed(sched.findUnique).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    h.checkSchedulable.mockResolvedValue({ approved: { id: "img-2", versionLabel: "7.6.9", role: "primary" }, fromVersion: "x", warnings: ["w"] });
    const out = await updateSchedule({ ...upd, imageId: "img-2" });
    expect(stubbed(sched.updateMany).mock.calls[0][0].data).toMatchObject({ imageId: "img-2", toVersion: "7.6.9" });
    expect(out.warnings).toEqual(["w"]);
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("Scheduled firmware upgrade to 7.6.9 changed: image 7.6.8 build1164 → 7.6.9");
    await flush();
    expect(h.sendEmail.mock.calls[0][1].outcome).toBe("rescheduled");
  });

  it("a new time writes firmware.upgrade_rescheduled with before / after and emails everyone 'rescheduled'", async () => {
    const moved = new Date(LATER.getTime() + 3_600_000);
    stubbed(sched.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ scheduledFor: moved }));
    await updateSchedule({ ...upd, scheduledFor: moved });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "firmware.upgrade_rescheduled", actor: "bob", resourceName: "sw-core" });
    expect(ev.message).toContain(`time ${LATER.toISOString()} → ${moved.toISOString()}`);
    expect(ev.details).toMatchObject({ before: { scheduledFor: LATER.toISOString() }, after: { scheduledFor: moved.toISOString() } });
    await flush();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][0].to).toEqual(["ops@example.com"]);
    expect(h.sendEmail.mock.calls[0][1].outcome).toBe("rescheduled");
  });

  it("a re-submitted identical time reads '(no differences)' and sends no notice", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    await updateSchedule({ ...upd, scheduledFor: new Date(LATER.getTime()) });
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("Scheduled firmware upgrade to 7.6.8 build1164 changed (no differences)");
    await flush();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("an added address alone hears 'scheduled' — only that address", async () => {
    stubbed(sched.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ notifyEmails: ["ops@example.com", "new@example.com"] }));
    await updateSchedule({ ...upd, notifyEmails: ["ops@example.com", "NEW@example.com"] });
    expect(stubbed(sched.updateMany).mock.calls[0][0].data.notifyEmails).toEqual(["ops@example.com", "new@example.com"]);
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("recipients ops@example.com, new@example.com");
    await flush();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][0]).toEqual({ to: ["new@example.com"], cc: [], bcc: [], channelIds: [] });
    expect(h.sendEmail.mock.calls[0][1].outcome).toBe("scheduled");
  });

  it("a channel change is named 'email channels'", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    h.prepareNotify.mockResolvedValue({ notifyEmails: ["ops@example.com"], notifyRecipients: { to: ["ops@example.com"], cc: null, bcc: null }, notifyChannelIds: ["ch-9"] });
    await updateSchedule({ ...upd, notify: { to: ["ops@example.com"], channelIds: ["ch-9"] } as never });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("email channels");
  });
});

// ─── cancelSchedule ───────────────────────────────────────────────────────────

describe("cancelSchedule", () => {
  it("marks it cancelled with who and when, and writes the Event", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      stubbed(sched.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "cancelled", cancelledBy: "carol", cancelledAt: NOW }));
      const out = await cancelSchedule("a-1", "sch-1", "carol");
      expect(stubbed(sched.updateMany).mock.calls[0][0]).toEqual({ where: { id: "sch-1", status: "pending" }, data: { status: "cancelled", cancelledBy: "carol", cancelledAt: NOW } });
      expect(out.status).toBe("cancelled");
      expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
        action: "firmware.upgrade_schedule_cancelled", actor: "carol", resourceId: "a-1",
        message: `Scheduled firmware upgrade to 7.6.8 build1164 (${LATER.toISOString()}) cancelled`, details: { scheduleId: "sch-1" },
      });
    } finally { vi.useRealTimers(); }
  });
  it("refuses a booking that already fired", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ status: "started" }));
    await expectStatus(cancelSchedule("a-1", "sch-1", "carol"), 409, /already started and can no longer be cancelled/);
  });
  it("a claim winning the race between read and write is 409, no Event", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row());
    stubbed(sched.updateMany).mockResolvedValue({ count: 0 });
    await expectStatus(cancelSchedule("a-1", "sch-1", "carol"), 409, /already started/);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
  it("another asset's booking is 404", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ assetId: "other" }));
    await expectStatus(cancelSchedule("a-1", "sch-1", "carol"), 404);
  });
});

// ─── fireDueBookings (the shared loop) ────────────────────────────────────────

type B = { id: string; scheduledFor: Date; error: string | null };

function firing(over: Partial<BookingFiring<B>> = {}): BookingFiring<B> & { [k: string]: any } {
  return {
    noun: "thing",
    claim: vi.fn(async () => true),
    start: vi.fn(async () => undefined),
    clearWait: vi.fn(async () => undefined),
    isConflict: vi.fn((e: unknown) => e instanceof FirmwareRunConflictError),
    wait: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    ...over,
  };
}

const at = (msLate: number, error: string | null = null, id = "b"): B => ({ id, scheduledFor: new Date(NOW.getTime() - msLate), error });

describe("fireDueBookings", () => {
  it("an empty batch is all zeros", async () => {
    expect(await fireDueBookings([], NOW, firing())).toEqual({ started: 0, refused: 0, missed: 0, waiting: 0 });
  });

  it("starts an on-time booking: claim, start, clearWait", async () => {
    const f = firing();
    const out = await fireDueBookings([at(0)], NOW, f);
    expect(out).toEqual({ started: 1, refused: 0, missed: 0, waiting: 0 });
    expect(f.claim).toHaveBeenCalledWith("b", NOW);
    expect(f.clearWait).toHaveBeenCalledWith("b");
  });

  it("exactly LATE_GRACE_MS late still starts; one ms more is missed, naming the noun and minutes", async () => {
    const f = firing();
    await fireDueBookings([at(LATE_GRACE_MS, null, "edge"), at(LATE_GRACE_MS + 1, null, "late")], NOW, f);
    expect(f.claim).toHaveBeenCalledTimes(1);
    expect(f.claim).toHaveBeenCalledWith("edge", NOW);
    expect(f.settle).toHaveBeenCalledWith("late", "missed", expect.stringContaining("first saw this thing 15 min late"), NOW);
  });

  it("a missed booking is never claimed", async () => {
    const f = firing();
    const out = await fireDueBookings([at(3_600_000)], NOW, f);
    expect(out.missed).toBe(1);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("a booking already waiting keeps waiting past the grace (it is retried, not missed)", async () => {
    const f = firing();
    const out = await fireDueBookings([at(LATE_GRACE_MS * 3, "peer is flashing")], NOW, f);
    expect(out.started).toBe(1);
    expect(f.settle).not.toHaveBeenCalled();
  });

  it("a waiting booking at exactly CONFLICT_WAIT_MS is tried; one ms later it is refused with the reason", async () => {
    const f = firing();
    await fireDueBookings([at(CONFLICT_WAIT_MS, "peer is flashing", "edge"), at(CONFLICT_WAIT_MS + 1, "peer is flashing", "over")], NOW, f);
    expect(f.claim).toHaveBeenCalledWith("edge", NOW);
    expect(f.settle).toHaveBeenCalledWith("over", "refused", "peer is flashing — still waiting 120 min after the scheduled time, so it was not started", NOW);
  });

  it("a lost claim (another tick or a cancel) is skipped without a count", async () => {
    const f = firing({ claim: vi.fn(async () => false) });
    expect(await fireDueBookings([at(0)], NOW, f)).toEqual({ started: 0, refused: 0, missed: 0, waiting: 0 });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("a conflict puts it back to wait with the message", async () => {
    const f = firing({ start: vi.fn(async () => { throw new FirmwareRunConflictError("a run on the peer"); }) });
    const out = await fireDueBookings([at(0)], NOW, f);
    expect(out.waiting).toBe(1);
    expect(f.wait).toHaveBeenCalledWith("b", "a run on the peer");
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.clearWait).not.toHaveBeenCalled();
  });

  it("any other failure refuses it — a non-Error throw is stringified", async () => {
    const f = firing({ start: vi.fn(async () => { throw "plain string"; }) });
    const out = await fireDueBookings([at(0)], NOW, f);
    expect(out.refused).toBe(1);
    expect(f.settle).toHaveBeenCalledWith("b", "refused", "plain string", NOW);
  });

  it("works through a mixed batch in order and counts each outcome", async () => {
    const order: string[] = [];
    const f = firing({
      claim: vi.fn(async (id: string) => { order.push(id); return id !== "lost"; }),
      start: vi.fn(async (s: B) => {
        if (s.id === "conf") throw new FirmwareRunConflictError("busy");
        if (s.id === "bad") throw new Error("down");
      }),
    });
    const out = await fireDueBookings([at(0, null, "ok"), at(0, null, "conf"), at(0, null, "bad"), at(0, null, "lost"), at(LATE_GRACE_MS + 60_000, null, "miss")], NOW, f);
    expect(out).toEqual({ started: 1, refused: 1, missed: 1, waiting: 1 });
    expect(order).toEqual(["ok", "conf", "bad", "lost"]);
  });
});

// ─── runDueSchedules ──────────────────────────────────────────────────────────

describe("runDueSchedules", () => {
  it("reads at most 50 due pending bookings, oldest first", async () => {
    stubbed(sched.findMany).mockResolvedValue([]);
    await runDueSchedules(NOW);
    expect(stubbed(sched.findMany).mock.calls[0][0]).toMatchObject({ where: { status: "pending", scheduledFor: { lte: NOW } }, orderBy: { scheduledFor: "asc" }, take: 50 });
  });

  it("claims conditionally, starts with the booking's recipients and actor, then clears the wait", async () => {
    const due = { ...row({ scheduledFor: NOW, notifyChannelIds: ["ch-1"], notifyRecipients: { to: ["x@y.io"] } }) };
    stubbed(sched.findMany).mockResolvedValue([due]);
    stubbed(sched.update).mockResolvedValue(due);
    const out = await runDueSchedules(NOW);
    expect(out.started).toBe(1);
    expect(stubbed(sched.updateMany).mock.calls[0][0]).toEqual({ where: { id: "sch-1", status: "pending" }, data: { status: "started", firedAt: NOW } });
    expect(h.startUpgrade).toHaveBeenCalledWith({ assetId: "a-1", imageId: "img-1", actor: "alice", scheduleId: "sch-1", notifyEmails: ["ops@example.com"], notifyRecipients: { to: ["x@y.io"] }, notifyChannelIds: ["ch-1"] });
    expect(sched.update).toHaveBeenCalledWith({ where: { id: "sch-1" }, data: { error: null } });
  });

  it("a null spec rides as null", async () => {
    stubbed(sched.findMany).mockResolvedValue([row({ scheduledFor: NOW })]);
    stubbed(sched.update).mockResolvedValue(row());
    await runDueSchedules(NOW);
    expect(h.startUpgrade.mock.calls[0][0].notifyRecipients).toBeNull();
  });

  it("a clearWait write failure does not undo the start", async () => {
    stubbed(sched.findMany).mockResolvedValue([row({ scheduledFor: NOW })]);
    stubbed(sched.update).mockRejectedValue(new Error("db blip"));
    expect((await runDueSchedules(NOW)).started).toBe(1);
  });

  it("a conflict writes it back to pending, firedAt cleared, with the reason", async () => {
    stubbed(sched.findMany).mockResolvedValue([row({ scheduledFor: NOW })]);
    stubbed(sched.update).mockResolvedValue(row());
    h.startUpgrade.mockRejectedValue(new FirmwareRunConflictError("MCLAG peer is upgrading"));
    const out = await runDueSchedules(NOW);
    expect(out.waiting).toBe(1);
    expect(sched.update).toHaveBeenCalledWith({ where: { id: "sch-1" }, data: { status: "pending", firedAt: null, error: "MCLAG peer is upgrading" } });
  });

  it("a deleted image is refused without starting: the row, a warning Event and the results email", async () => {
    const due = row({ scheduledFor: NOW, imageId: null });
    stubbed(sched.findMany).mockResolvedValue([due]);
    stubbed(sched.update).mockResolvedValue({ ...due, status: "refused" });
    const out = await runDueSchedules(NOW);
    expect(out.refused).toBe(1);
    expect(h.startUpgrade).not.toHaveBeenCalled();
    const msg = "The approved image (7.6.8 build1164) was deleted from the Repository";
    expect(sched.update).toHaveBeenCalledWith({ where: { id: "sch-1" }, data: { status: "refused", error: msg, firedAt: NOW } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "firmware.upgrade_schedule_refused", level: "warning", actor: "system:firmware", message: `Scheduled firmware upgrade to 7.6.8 build1164 was not started: ${msg}` });
    expect(h.sendEmail.mock.calls[0][1]).toMatchObject({ outcome: "refused", error: msg, fromVersion: "7.4.3", startedAt: null });
  });

  it("a missed booking writes firmware.upgrade_schedule_missed", async () => {
    const due = row({ scheduledFor: new Date(NOW.getTime() - 3_600_000) });
    stubbed(sched.findMany).mockResolvedValue([due]);
    stubbed(sched.update).mockResolvedValue(due);
    const out = await runDueSchedules(NOW);
    expect(out.missed).toBe(1);
    expect(eventLog.logEvent.mock.calls[0][0].action).toBe("firmware.upgrade_schedule_missed");
    expect(stubbed(sched.update).mock.calls[0][0].data).toMatchObject({ status: "missed" });
  });

  it("the results email of a settle is skipped when notifiedAt was already claimed", async () => {
    const due = row({ scheduledFor: NOW, imageId: null });
    stubbed(sched.findMany).mockResolvedValue([due]);
    stubbed(sched.update).mockResolvedValue(due);
    stubbed(sched.updateMany).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await runDueSchedules(NOW);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

// ─── notifyScheduledRunFinished ───────────────────────────────────────────────

describe("notifyScheduledRunFinished", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    status: "succeeded", result: "ok", error: null, fromVersion: "7.4.3", toVersion: "7.6.8 build1164 (run)", verifiedVersion: "7.6.8",
    startedAt: NOW, finishedAt: LATER, log: [], ...over,
  });

  it("does nothing for a run no booking points at, or one already notified", async () => {
    stubbed(sched.findUnique).mockResolvedValue(null);
    await notifyScheduledRunFinished("run-1");
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1", notifiedAt: NOW }));
    await notifyScheduledRunFinished("run-1");
    expect(prisma.firmwareUpgradeRun.findUnique).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"])("does nothing while the run is %s", async (status) => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ status }));
    await notifyScheduledRunFinished("run-1");
    expect(sched.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing when the run row is gone", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(null);
    await notifyScheduledRunFinished("run-1");
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["succeeded", "succeeded"],
    ["unverified", "unverified"],
    ["failed", "failed"],
    ["cancelled", "failed"],
  ])("a %s run is emailed as %s", async (status, outcome) => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ status }));
    await notifyScheduledRunFinished("run-1");
    expect(h.sendEmail.mock.calls[0][1].outcome).toBe(outcome);
  });

  it("claims notifiedAt first, uses the RUN's toVersion and only the last 15 log lines", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    const log = Array.from({ length: 40 }, (_, i) => ({ t: "t", level: "info", msg: `line ${i}` }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ log }));
    await notifyScheduledRunFinished("run-1");
    expect(stubbed(sched.updateMany).mock.calls[0][0]).toMatchObject({ where: { id: "sch-1", notifiedAt: null } });
    const facts = h.sendEmail.mock.calls[0][1];
    expect(facts.toVersion).toBe("7.6.8 build1164 (run)");
    expect(facts.log).toHaveLength(15);
    expect(facts.log[0].msg).toBe("line 25");
    expect(facts).toMatchObject({ scheduled: true, fromVersion: "7.4.3", verifiedVersion: "7.6.8", result: "ok", scheduledBy: "alice", scheduledFor: LATER });
  });

  it("a non-array log is sent as []; a null fromVersion falls back to the asset's", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run({ log: { not: "array" }, fromVersion: null }));
    await notifyScheduledRunFinished("run-1");
    expect(h.sendEmail.mock.calls[0][1]).toMatchObject({ log: [], fromVersion: "7.4.3" });
  });

  it("a second caller losing the notifiedAt claim sends nothing", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run());
    stubbed(sched.updateMany).mockResolvedValue({ count: 0 });
    await notifyScheduledRunFinished("run-1");
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("a send failure records notifyError (capped at 2000 chars) and a warning Event", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run());
    stubbed(sched.update).mockResolvedValue(row());
    const err = "x".repeat(2500);
    h.sendEmail.mockResolvedValue(err);
    await notifyScheduledRunFinished("run-1");
    expect(sched.update).toHaveBeenCalledWith({ where: { id: "sch-1" }, data: { notifyError: "x".repeat(2000) } });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "firmware.upgrade_schedule_email_failed", level: "warning", resourceName: "sw-core" });
    expect(ev.message).toContain("The results email for the scheduled firmware upgrade to 7.6.8 build1164 (run)");
    expect(ev.details).toMatchObject({ scheduleId: "sch-1", notifyEmails: ["ops@example.com"] });
  });

  it("a notifyError write failure still writes the Event", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run());
    stubbed(sched.update).mockRejectedValue(new Error("db"));
    h.sendEmail.mockResolvedValue("smtp refused");
    await notifyScheduledRunFinished("run-1");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("emails the target targetFor resolved from the stored spec", async () => {
    stubbed(sched.findUnique).mockResolvedValue(row({ runId: "run-1", notifyRecipients: { to: ["r"] }, notifyChannelIds: ["ch-3"] }));
    stubbed(prisma.firmwareUpgradeRun.findUnique).mockResolvedValue(run());
    h.targetFor.mockResolvedValue({ to: ["resolved@x.io"], cc: ["cc@x.io"], bcc: [], channelIds: ["ch-3"] });
    await notifyScheduledRunFinished("run-1");
    expect(h.targetFor.mock.calls[0][0]).toMatchObject({ notifyRecipients: { to: ["r"] }, notifyChannelIds: ["ch-3"] });
    expect(h.sendEmail.mock.calls[0][0]).toEqual({ to: ["resolved@x.io"], cc: ["cc@x.io"], bcc: [], channelIds: ["ch-3"] });
  });
});
