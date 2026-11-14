/**
 * tests/unit/rebootScheduleService.test.ts — the own suite for
 * src/services/rebootScheduleService.ts (business rule 115 — the rule-93
 * booking shape for a reboot; CQ-T010).
 *
 * Complements rebootScheduleFiring.test.ts / rebootScheduleCancel.test.ts /
 * rebootAutomationBooking.test.ts. Pins, against the shared Prisma stub:
 *   - booking: guard order, Cc / Bcc only without a picker spec, the note
 *     (rule 115(d)), the P2002 race, the Event wording, the 'scheduled' notice
 *     and its silence for an automation's booking (115(e));
 *   - change / cancel: the race 409s, the inherited-length cap, the reason
 *     diff, the notices;
 *   - nextAutomationRebootTime: wall-clock HH:MM on the server's clock, the
 *     lead, calendar-day stepping across every day of a year (DST-safe, built
 *     from local-time Date parts so it holds in any TZ);
 *   - bookRebootFromAutomation: the two skips (pending, minimum gap), the lost
 *     race, the credential record (rule 112);
 *   - the firing tick's writes, settle, and the three emails (booked results,
 *     run started, run finished) with their once-only claims.
 *
 * No reboot is sent: rebootService is mocked, and so is the email transport
 * (operationNotifyService.deliverOperationEmail).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  checkSchedulable: vi.fn(),
  startReboot: vi.fn(),
  recordCred: vi.fn(),
  resolveNote: vi.fn(),
  deliver: vi.fn(),
  prepareNotify: vi.fn(),
  targetFor: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/rebootService.js", async () => {
  const { AppError } = await import("../../src/utils/errors.js");
  class RebootRunConflictError extends AppError {
    constructor(message: string) { super(409, message); this.name = "RebootRunConflictError"; }
  }
  return { RebootRunConflictError, checkSchedulableReboot: h.checkSchedulable, startReboot: h.startReboot, recordRebootCredentialUse: h.recordCred };
});
vi.mock("../../src/services/rebootSettingsService.js", () => ({ resolveRebootNote: h.resolveNote }));
// firmwareScheduleService is used for real (its guards and firing loop are shared);
// its own heavy imports are cut off here.
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({ FirmwareRunConflictError: class extends Error {}, checkSchedulableUpgrade: vi.fn(), startFirmwareUpgrade: vi.fn() }));
vi.mock("../../src/services/firmwareEmailService.js", () => ({ firmwareEmailAsset: vi.fn(), sendFirmwareEmail: vi.fn() }));
vi.mock("../../src/services/operationNotifyService.js", () => ({ deliverOperationEmail: h.deliver, prepareNotify: h.prepareNotify, targetFor: h.targetFor }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { RebootRunConflictError } from "../../src/services/rebootService.js";
import { MIN_LEAD_MS } from "../../src/services/firmwareScheduleService.js";
import {
  bookRebootFromAutomation,
  cancelRebootSchedule,
  createRebootSchedule,
  getPendingRebootSchedule,
  listRebootSchedulesForAsset,
  nextAutomationRebootTime,
  notifyRebootRunFinished,
  notifyRebootRunStarted,
  notifyScheduledRebootFinished,
  runDueRebootSchedules,
  updateRebootSchedule,
  type AutomationRebootInput,
  type RebootScheduleSummary,
} from "../../src/services/rebootScheduleService.js";

const NOW = new Date("2026-03-07T15:00:00.000Z");
const LATER = new Date("2026-03-08T07:00:00.000Z");
const rs = prisma.rebootSchedule;

function row(over: Partial<RebootScheduleSummary> = {}): RebootScheduleSummary {
  return {
    id: "rs-1", assetId: "a-1", scheduledFor: LATER, notifyEmails: ["ops@example.com"], notifyCc: [], notifyBcc: [],
    note: null, status: "pending", runId: null, error: null, createdBy: "alice", createdAt: NOW, updatedBy: null, updatedAt: NOW,
    cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, notifyRecipients: null, notifyChannelIds: [],
    ...over,
  };
}

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "run-1", assetId: "a-1", status: "succeeded", error: null, method: "fortigate-rest", authority: "admin-cred", note: null,
    startedBy: "bob", startedAt: NOW, finishedAt: LATER, log: [], notifyEmails: [] as string[], notifyRecipients: null,
    notifyChannelIds: [] as string[], notifiedAt: null, schedule: null as Record<string, unknown> | null, ...over,
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

const deliveredFacts = (i = 0) => h.deliver.mock.calls[i][1]("UTC");

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.checkSchedulable.mockResolvedValue({ plan: { method: "fortigate-rest", authority: "admin-cred" }, warnings: [] });
  h.resolveNote.mockImplementation(async (n: unknown) => (typeof n === "string" && n.trim() ? n.trim() : null));
  h.deliver.mockResolvedValue(null);
  h.recordCred.mockResolvedValue(undefined);
  h.targetFor.mockImplementation(async (r: { notifyEmails: string[]; notifyCc?: string[] | null; notifyBcc?: string[] | null; notifyChannelIds?: string[] | null }) => ({
    to: r.notifyEmails, cc: r.notifyCc ?? [], bcc: r.notifyBcc ?? [], channelIds: r.notifyChannelIds ?? [],
  }));
  stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "fw-edge", ipAddress: "10.0.0.1", model: "FG-100F", lastRebootAt: null });
  stubbed(rs.findFirst).mockResolvedValue(null);
  stubbed(rs.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row({ ...data, id: "rs-new" } as Partial<RebootScheduleSummary>));
  stubbed(rs.updateMany).mockResolvedValue({ count: 1 });
  stubbed(prisma.rebootRun.findFirst).mockResolvedValue(null);
  stubbed(prisma.rebootRun.updateMany).mockResolvedValue({ count: 1 });
});

// ─── Reads ────────────────────────────────────────────────────────────────────

describe("reads", () => {
  it("getPendingRebootSchedule: null when none; defaults spec and channels", async () => {
    expect(await getPendingRebootSchedule("a-1")).toBeNull();
    stubbed(rs.findFirst).mockResolvedValue({ ...row(), notifyRecipients: undefined, notifyChannelIds: undefined });
    const s = await getPendingRebootSchedule("a-1");
    expect(s).toMatchObject({ notifyRecipients: null, notifyChannelIds: [] });
  });
  it("listRebootSchedulesForAsset clamps the limit to 1..100", async () => {
    stubbed(rs.findMany).mockResolvedValue([]);
    await listRebootSchedulesForAsset("a-1", -3);
    await listRebootSchedulesForAsset("a-1", 999);
    expect(stubbed(rs.findMany).mock.calls.map((c) => c[0].take)).toEqual([1, 100]);
  });
});

// ─── createRebootSchedule ─────────────────────────────────────────────────────

describe("createRebootSchedule", () => {
  const base = { assetId: "a-1", scheduledFor: LATER, notifyEmails: ["Ops@Example.com"], actor: "alice", now: NOW };

  it("a past time is 400 before the opt-in is checked", async () => {
    await expectStatus(createRebootSchedule({ ...base, scheduledFor: NOW }), 400);
    expect(h.checkSchedulable).not.toHaveBeenCalled();
  });

  it("a blank required note refuses before the opt-in is checked", async () => {
    h.resolveNote.mockRejectedValue(new AppError(400, "this install requires a reboot note"));
    await expectStatus(createRebootSchedule(base), 400, /requires a reboot note/);
    expect(h.checkSchedulable).not.toHaveBeenCalled();
  });

  it("a gate refusal (no opt-in, HA) propagates and books nothing", async () => {
    h.checkSchedulable.mockRejectedValue(new AppError(400, "no opt-in"));
    await expectStatus(createRebootSchedule(base), 400);
    expect(rs.create).not.toHaveBeenCalled();
  });

  it("one pending booking per asset: 409 without creating", async () => {
    stubbed(rs.findFirst).mockResolvedValue({ id: "old" });
    await expectStatus(createRebootSchedule(base), 409, /already scheduled/);
    expect(rs.create).not.toHaveBeenCalled();
  });

  it("the unique index losing a race is the same 409; another failure is rethrown", async () => {
    stubbed(rs.create).mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    await expectStatus(createRebootSchedule(base), 409, /already scheduled/);
    const boom = new Error("db");
    stubbed(rs.create).mockRejectedValueOnce(boom);
    await expect(createRebootSchedule(base)).rejects.toBe(boom);
  });

  it("stores normalized To, empty Cc / Bcc, the resolved note and no spec", async () => {
    await createRebootSchedule({ ...base, note: "  patch Tuesday " });
    expect(stubbed(rs.create).mock.calls[0][0].data).toEqual({ assetId: "a-1", scheduledFor: LATER, notifyEmails: ["ops@example.com"], notifyCc: [], notifyBcc: [], note: "patch Tuesday", createdBy: "alice" });
  });

  it("writes asset.reboot_scheduled naming the authority, Cc, Bcc and reason", async () => {
    h.checkSchedulable.mockResolvedValue({ plan: { method: "agent", authority: "Polaris Agent" }, warnings: ["w"] });
    await createRebootSchedule({ ...base, notifyCc: ["CC@x.io"], notifyBcc: ["bcc@x.io"], note: "leak", context: { automation: true } });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "asset.reboot_scheduled", resourceName: "fw-edge", actor: "alice", level: "info" });
    expect(ev.message).toBe(`Reboot scheduled for ${LATER.toISOString()} (signed by "Polaris Agent"); results to ops@example.com, cc cc@x.io, bcc bcc@x.io — reason: leak`);
    expect(ev.details).toMatchObject({ scheduleId: "rs-new", notifyCc: ["cc@x.io"], notifyBcc: ["bcc@x.io"], method: "agent", authority: "Polaris Agent", warnings: ["w"], note: "leak", automation: true });
  });

  it("omits notifyCc / notifyBcc from the Event details when empty", async () => {
    await createRebootSchedule(base);
    const d = eventLog.logEvent.mock.calls[0][0].details;
    expect(d).not.toHaveProperty("notifyCc");
    expect(d).not.toHaveProperty("notifyBcc");
    expect(eventLog.logEvent.mock.calls[0][0].message).not.toContain("reason");
  });

  it("a bad Cc address is 400", async () => {
    await expectStatus(createRebootSchedule({ ...base, notifyCc: ["nope"] }), 400, /not an email address/);
  });

  it("maxRecipients widens the cap for each list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.io`);
    await expectStatus(createRebootSchedule({ ...base, notifyEmails: many }), 400, /At most 20/);
    await createRebootSchedule({ ...base, notifyEmails: many, maxRecipients: 200 });
    expect(stubbed(rs.create).mock.calls[0][0].data.notifyEmails).toHaveLength(30);
  });

  it("with a picker spec: stores the spec and channels, and drops any Cc / Bcc given", async () => {
    h.prepareNotify.mockResolvedValue({ notifyEmails: ["r@x.io"], notifyRecipients: { to: ["r@x.io"], cc: null, bcc: null }, notifyChannelIds: ["ch-1"] });
    await createRebootSchedule({ ...base, notifyCc: ["cc@x.io"], notify: { to: ["r@x.io"], channelIds: ["ch-1"] } as never });
    expect(stubbed(rs.create).mock.calls[0][0].data).toMatchObject({ notifyEmails: ["r@x.io"], notifyCc: [], notifyBcc: [], notifyRecipients: { to: ["r@x.io"] }, notifyChannelIds: ["ch-1"] });
  });

  it("an operator's booking emails 'scheduled' with the note", async () => {
    await createRebootSchedule({ ...base, note: "why" });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0].to).toEqual(["ops@example.com"]);
    expect(deliveredFacts().subject).toMatch(/^\[Polaris\] Reboot scheduled for .*: fw-edge$/);
    expect(deliveredFacts().text).toContain("why");
  });

  it("an automation's booking sends no 'scheduled' notice (115(e))", async () => {
    await createRebootSchedule({ ...base, actor: "automation:Leak" });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("a notice that cannot be sent is asset.reboot_schedule_email_failed; one that throws is swallowed", async () => {
    h.deliver.mockResolvedValueOnce("no channel");
    await createRebootSchedule(base);
    await flush();
    const failed = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "asset.reboot_schedule_email_failed");
    expect(failed).toMatchObject({ level: "warning", actor: "system:reboot", resourceName: "fw-edge", details: { notice: "scheduled", error: "no channel" } });
    h.targetFor.mockRejectedValueOnce(new Error("resolver down"));
    await expect(createRebootSchedule(base)).resolves.toMatchObject({ id: "rs-new" });
    await flush();
  });

  it("the email names a hostname-less asset by IP, then by id", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: null, ipAddress: null, model: null });
    h.deliver.mockResolvedValue("x");
    await createRebootSchedule(base);
    await flush();
    const failed = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "asset.reboot_schedule_email_failed");
    expect(failed?.resourceName).toBe("a-1");
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBeUndefined();
  });
});

// ─── updateRebootSchedule ─────────────────────────────────────────────────────

describe("updateRebootSchedule", () => {
  const upd = { assetId: "a-1", scheduleId: "rs-1", actor: "bob", now: NOW };

  it("404 for another asset's booking; 409 naming a non-pending status", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ assetId: "x" }));
    await expectStatus(updateRebootSchedule(upd), 404, /Scheduled reboot not found/);
    stubbed(rs.findUnique).mockResolvedValue(row({ status: "missed" }));
    await expectStatus(updateRebootSchedule(upd), 409, /already missed and can no longer be changed/);
  });

  it("an absent note keeps the booking's (not judged); a present one is judged", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ note: "old" }));
    await updateRebootSchedule(upd);
    expect(h.resolveNote).not.toHaveBeenCalled();
    expect(stubbed(rs.updateMany).mock.calls[0][0].data).toEqual({ updatedBy: "bob" });
    await updateRebootSchedule({ ...upd, note: null });
    expect(h.resolveNote).toHaveBeenCalledWith(null);
    expect(stubbed(rs.updateMany).mock.calls[1][0].data).toEqual({ updatedBy: "bob", note: null });
  });

  it("names a removed reason and a new reason in the Event", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ note: "old" }));
    await updateRebootSchedule({ ...upd, note: "" });
    expect(eventLog.logEvent.mock.calls[0][0].message).toBe("Scheduled reboot changed: reason removed");
    await updateRebootSchedule({ ...upd, note: "new why" });
    expect(eventLog.logEvent.mock.calls[1][0].message).toBe('Scheduled reboot changed: reason "new why"');
  });

  it("an automation's long inherited list can be re-saved at its own length", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `u${i}@x.io`);
    stubbed(rs.findUnique).mockResolvedValue(row({ notifyEmails: many }));
    await updateRebootSchedule({ ...upd, notifyEmails: many });
    expect(stubbed(rs.updateMany).mock.calls[0][0].data.notifyEmails).toHaveLength(40);
    await expectStatus(updateRebootSchedule({ ...upd, notifyEmails: [...many, "extra@x.io"] }), 400, /At most 40/);
  });

  it("a picker spec replaces the To and clears Cc / Bcc", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ notifyCc: ["c@x.io"] }));
    h.prepareNotify.mockResolvedValue({ notifyEmails: ["r@x.io"], notifyRecipients: { to: ["r@x.io"], cc: null, bcc: null }, notifyChannelIds: [] });
    await updateRebootSchedule({ ...upd, notify: { to: ["r@x.io"], channelIds: [] } as never });
    expect(stubbed(rs.updateMany).mock.calls[0][0].data).toMatchObject({ notifyEmails: ["r@x.io"], notifyCc: [], notifyBcc: [], notifyChannelIds: [] });
  });

  it("the conditional write losing to a claim is 409", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row());
    stubbed(rs.updateMany).mockResolvedValue({ count: 0 });
    await expectStatus(updateRebootSchedule(upd), 409, /already started or been cancelled/);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a moved time writes asset.reboot_rescheduled and emails everyone 'rescheduled'", async () => {
    const moved = new Date(LATER.getTime() + 7_200_000);
    stubbed(rs.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ scheduledFor: moved }));
    await updateRebootSchedule({ ...upd, scheduledFor: moved });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "asset.reboot_rescheduled", actor: "bob" });
    expect(ev.message).toBe(`Scheduled reboot changed: time ${LATER.toISOString()} → ${moved.toISOString()}`);
    expect(ev.details).toMatchObject({ after: { scheduledFor: moved.toISOString() } });
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0].to).toEqual(["ops@example.com"]);
  });

  it("an added address hears 'scheduled' alone; an unchanged list sends nothing", async () => {
    stubbed(rs.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ notifyEmails: ["ops@example.com", "n@x.io"] }));
    await updateRebootSchedule({ ...upd, notifyEmails: ["ops@example.com", "n@x.io"] });
    await flush();
    expect(h.deliver.mock.calls[0][0]).toEqual({ to: ["n@x.io"], cc: [], bcc: [], channelIds: [] });
    h.deliver.mockClear();
    stubbed(rs.findUnique).mockResolvedValue(row());
    await updateRebootSchedule(upd);
    expect(eventLog.logEvent.mock.calls[1][0].message).toBe("Scheduled reboot changed (no differences)");
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("an automation's booking moved in time sends no notice", async () => {
    const moved = new Date(LATER.getTime() + 60_000 * 90);
    stubbed(rs.findUnique).mockResolvedValueOnce(row({ createdBy: "automation:R" })).mockResolvedValueOnce(row({ createdBy: "automation:R", scheduledFor: moved }));
    await updateRebootSchedule({ ...upd, scheduledFor: moved });
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });
});

// ─── cancelRebootSchedule ─────────────────────────────────────────────────────

describe("cancelRebootSchedule", () => {
  it("cancels conditionally and writes asset.reboot_schedule_cancelled", async () => {
    stubbed(rs.findUnique).mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "cancelled" }));
    const out = await cancelRebootSchedule("a-1", "rs-1", "carol");
    const call = stubbed(rs.updateMany).mock.calls[0][0];
    expect(call.where).toEqual({ id: "rs-1", status: "pending" });
    expect(call.data).toMatchObject({ status: "cancelled", cancelledBy: "carol" });
    expect(call.data.cancelledAt).toBeInstanceOf(Date);
    expect(out.status).toBe("cancelled");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.reboot_schedule_cancelled", actor: "carol", message: `Scheduled reboot (${LATER.toISOString()}) cancelled` });
  });
  it("a fired booking is 409; a race is 409 with no Event", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ status: "started" }));
    await expectStatus(cancelRebootSchedule("a-1", "rs-1", "c"), 409, /already started and can no longer be cancelled/);
    stubbed(rs.findUnique).mockResolvedValue(row());
    stubbed(rs.updateMany).mockResolvedValue({ count: 0 });
    await expectStatus(cancelRebootSchedule("a-1", "rs-1", "c"), 409, /already started — it can no longer/);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── nextAutomationRebootTime ─────────────────────────────────────────────────

describe("nextAutomationRebootTime", () => {
  it("'now' is a minute and a half out", () => {
    expect(nextAutomationRebootTime("now", "ignored", NOW).getTime()).toBe(NOW.getTime() + MIN_LEAD_MS + 30_000);
  });
  it.each(["24:00", "7:30", "12:60", "", "12:30:00", "ab:cd"])("refuses %j with 400", (at) => {
    try { nextAutomationRebootTime("at", at, NOW); expect.unreachable(); } catch (e) {
      expect((e as AppError).httpStatus).toBe(400);
      expect((e as Error).message).toContain("is not a time of day (HH:MM)");
    }
  });
  it("a later time today stays today, on the server's wall clock", () => {
    const now = new Date(2026, 5, 10, 9, 0, 0, 0);
    const d = nextAutomationRebootTime("at", "22:15", now);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 5, 10, 22, 15, 0]);
  });
  it("an earlier time is tomorrow", () => {
    const now = new Date(2026, 5, 10, 9, 0, 0, 0);
    const d = nextAutomationRebootTime("at", "03:00", now);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([11, 3, 0]);
  });
  it("a time less than a minute away rolls to tomorrow; exactly a minute stays today", () => {
    const now = new Date(2026, 5, 10, 2, 59, 30, 0);
    expect(nextAutomationRebootTime("at", "03:00", now).getDate()).toBe(11);
    const exact = new Date(2026, 5, 10, 2, 59, 0, 0);
    expect(nextAutomationRebootTime("at", "03:00", exact).getDate()).toBe(10);
  });
  it("crosses a month and a year end by calendar day", () => {
    const d = nextAutomationRebootTime("at", "01:00", new Date(2026, 11, 31, 23, 0, 0, 0));
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2027, 0, 1, 1]);
  });
  it("lands on the asked wall-clock time the next day for every night of a year (DST-safe)", () => {
    for (let day = 0; day < 366; day++) {
      const now = new Date(2026, 0, 1 + day, 23, 0, 0, 0);
      const d = nextAutomationRebootTime("at", "04:15", now);
      const tomorrow = new Date(2026, 0, 2 + day, 12, 0, 0, 0);
      expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 4, 15]);
    }
  });
});

// ─── bookRebootFromAutomation ─────────────────────────────────────────────────

describe("bookRebootFromAutomation", () => {
  const input = (over: Partial<AutomationRebootInput> = {}): AutomationRebootInput => ({
    assetId: "a-1", when: "now", at: "02:00", notifyEmails: ["ops@example.com"], minGapHours: 6,
    ruleId: "r-1", ruleName: "High memory", notificationId: "n-1", now: NOW, ...over,
  });

  it("skips when a booking is pending, with an info Event naming its time", async () => {
    stubbed(rs.findFirst).mockResolvedValue({ scheduledFor: LATER });
    const out = await bookRebootFromAutomation(input());
    expect(out).toEqual({ booked: false, reason: `a reboot is already booked for ${LATER.toISOString()}` });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.reboot_automation_skipped", actor: "automation:High memory", level: "info",
      message: `Automation "High memory" did not book a reboot: ${out.booked ? "" : out.reason}`,
      details: { automation: true, ruleId: "r-1", ruleName: "High memory", notificationId: "n-1" },
    });
    expect(rs.create).not.toHaveBeenCalled();
  });

  it("skips when a non-failed reboot run started inside the gap", async () => {
    const recent = new Date(NOW.getTime() - 3_600_000);
    stubbed(prisma.rebootRun.findFirst).mockResolvedValue({ startedAt: recent });
    const out = await bookRebootFromAutomation(input());
    expect(out).toEqual({ booked: false, reason: `the device rebooted at ${recent.toISOString()}, within the 6 h minimum gap` });
    const q = stubbed(prisma.rebootRun.findFirst).mock.calls[0][0];
    expect(q.where).toEqual({ assetId: "a-1", startedAt: { gte: new Date(NOW.getTime() - 6 * 3_600_000) }, status: { not: "failed" } });
  });

  it("skips on a monitored reboot (lastRebootAt) inside the gap, naming the newer of the two", async () => {
    const run = new Date(NOW.getTime() - 5 * 3_600_000);
    const mon = new Date(NOW.getTime() - 2 * 3_600_000);
    stubbed(prisma.rebootRun.findFirst).mockResolvedValue({ startedAt: run });
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "fw-edge", ipAddress: null, model: null, lastRebootAt: mon });
    const out = await bookRebootFromAutomation(input());
    expect(out.booked).toBe(false);
    expect(!out.booked && out.reason).toContain(mon.toISOString());
  });

  it("a lastRebootAt older than the gap does not skip", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "fw-edge", ipAddress: null, model: null, lastRebootAt: new Date(NOW.getTime() - 7 * 3_600_000) });
    const out = await bookRebootFromAutomation(input());
    expect(out.booked).toBe(true);
  });

  it("books now + 90 s with the automation's name as actor and note, the widened cap and the context", async () => {
    const out = await bookRebootFromAutomation(input({ notifyCc: ["cc@x.io"] }));
    expect(out).toEqual({ booked: true, scheduleId: "rs-new", scheduledFor: new Date(NOW.getTime() + 90_000) });
    const data = stubbed(rs.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ createdBy: "automation:High memory", note: 'Automation "High memory"', notifyCc: ["cc@x.io"] });
    expect(h.resolveNote).toHaveBeenCalledWith('Automation "High memory"');
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ automation: true, notificationId: "n-1" });
    expect(h.recordCred).toHaveBeenCalledWith("a-1", { username: null, actor: "automation:High memory", mayUseAny: false });
  });

  it("names itself by rule id, then 'unknown', when the rule has no name", async () => {
    await bookRebootFromAutomation(input({ ruleName: null }));
    expect(stubbed(rs.create).mock.calls[0][0].data.createdBy).toBe("automation:r-1");
    await bookRebootFromAutomation(input({ ruleName: null, ruleId: null }));
    expect(stubbed(rs.create).mock.calls[1][0].data).toMatchObject({ createdBy: "automation:unknown", note: 'Automation "unknown"' });
  });

  it("a skip with neither name nor id reads '?'", async () => {
    stubbed(rs.findFirst).mockResolvedValue({ scheduledFor: LATER });
    await bookRebootFromAutomation(input({ ruleName: null, ruleId: null }));
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/^Automation "\?" did not book/);
  });

  it("losing the booking race is a skip, not a failure", async () => {
    stubbed(rs.create).mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const out = await bookRebootFromAutomation(input());
    expect(out).toEqual({ booked: false, reason: "a reboot is already booked for this device" });
    expect(h.recordCred).not.toHaveBeenCalled();
  });

  it("a gate refusal throws for the caller to record", async () => {
    h.checkSchedulable.mockRejectedValue(new AppError(400, "an HA FortiGate cannot be rebooted"));
    await expectStatus(bookRebootFromAutomation(input()), 400, /HA FortiGate/);
  });

  it("an invalid 'at' throws 400", async () => {
    await expectStatus(bookRebootFromAutomation(input({ when: "at", at: "25:00" })), 400);
  });

  it("an automation's booking sends no 'scheduled' notice", async () => {
    await bookRebootFromAutomation(input());
    await flush();
    expect(h.deliver).not.toHaveBeenCalled();
  });
});

// ─── runDueRebootSchedules ────────────────────────────────────────────────────

describe("runDueRebootSchedules", () => {
  it("reads 50 due bookings oldest first", async () => {
    stubbed(rs.findMany).mockResolvedValue([]);
    expect(await runDueRebootSchedules(NOW)).toEqual({ started: 0, refused: 0, missed: 0, waiting: 0 });
    expect(stubbed(rs.findMany).mock.calls[0][0]).toMatchObject({ where: { status: "pending", scheduledFor: { lte: NOW } }, orderBy: { scheduledFor: "asc" }, take: 50 });
  });

  it("claims and starts with the booking's note and booker, then clears the wait", async () => {
    stubbed(rs.findMany).mockResolvedValue([{ id: "rs-1", assetId: "a-1", scheduledFor: NOW, createdBy: "alice", error: null, note: "why" }]);
    stubbed(rs.update).mockResolvedValue(row());
    const out = await runDueRebootSchedules(NOW);
    expect(out.started).toBe(1);
    expect(stubbed(rs.updateMany).mock.calls[0][0]).toEqual({ where: { id: "rs-1", status: "pending" }, data: { status: "started", firedAt: NOW } });
    expect(h.startReboot).toHaveBeenCalledWith({ assetId: "a-1", actor: "alice", scheduleId: "rs-1", note: "why" });
    expect(rs.update).toHaveBeenCalledWith({ where: { id: "rs-1" }, data: { error: null } });
  });

  it("a running reboot makes it wait (pending again, reason stored)", async () => {
    stubbed(rs.findMany).mockResolvedValue([{ id: "rs-1", assetId: "a-1", scheduledFor: NOW, createdBy: "alice", error: null, note: null }]);
    stubbed(rs.update).mockResolvedValue(row());
    h.startReboot.mockRejectedValue(new RebootRunConflictError("a reboot is already running"));
    expect((await runDueRebootSchedules(NOW)).waiting).toBe(1);
    expect(rs.update).toHaveBeenCalledWith({ where: { id: "rs-1" }, data: { status: "pending", firedAt: null, error: "a reboot is already running" } });
  });

  it("a gate refusal settles it refused: row, warning Event, results email with the error", async () => {
    stubbed(rs.findMany).mockResolvedValue([{ id: "rs-1", assetId: "a-1", scheduledFor: NOW, createdBy: "alice", error: null, note: null }]);
    stubbed(rs.update).mockResolvedValue(row({ scheduledFor: NOW }));
    h.startReboot.mockRejectedValue(new AppError(409, "device is down"));
    expect((await runDueRebootSchedules(NOW)).refused).toBe(1);
    expect(rs.update).toHaveBeenCalledWith({ where: { id: "rs-1" }, data: { status: "refused", error: "device is down", firedAt: NOW } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.reboot_schedule_refused", actor: "system:reboot", level: "warning", message: "Scheduled reboot was not started: device is down" });
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });

  it("a booking first seen an hour late is missed, naming 'reboot'", async () => {
    stubbed(rs.findMany).mockResolvedValue([{ id: "rs-1", assetId: "a-1", scheduledFor: new Date(NOW.getTime() - 3_600_000), createdBy: "alice", error: null, note: null }]);
    stubbed(rs.update).mockResolvedValue(row());
    expect((await runDueRebootSchedules(NOW)).missed).toBe(1);
    expect(eventLog.logEvent.mock.calls[0][0].action).toBe("asset.reboot_schedule_missed");
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("first saw this reboot 60 min late");
    expect(h.startReboot).not.toHaveBeenCalled();
  });
});

// ─── notifyScheduledRebootFinished ────────────────────────────────────────────

describe("notifyScheduledRebootFinished", () => {
  it("nothing for an unknown run, an already-notified booking, or an unfinished run", async () => {
    stubbed(rs.findUnique).mockResolvedValue(null);
    await notifyScheduledRebootFinished("run-1");
    stubbed(rs.findUnique).mockResolvedValue(row({ notifiedAt: NOW }));
    await notifyScheduledRebootFinished("run-1");
    stubbed(rs.findUnique).mockResolvedValue(row());
    for (const status of ["queued", "sending", "rebooting"]) {
      stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ status }));
      await notifyScheduledRebootFinished("run-1");
    }
    expect(rs.updateMany).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it.each([["succeeded", " succeeded: "], ["unverified", " finished unverified: "], ["failed", " FAILED: "], ["cancelled", " FAILED: "]])("a %s run emails a subject with %j", async (status, verb) => {
    stubbed(rs.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ status }));
    await notifyScheduledRebootFinished("run-1");
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(deliveredFacts().subject).toContain(`${verb}fw-edge`);
  });

  it("claims notifiedAt; losing the claim sends nothing", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow());
    stubbed(rs.updateMany).mockResolvedValue({ count: 0 });
    await notifyScheduledRebootFinished("run-1");
    expect(stubbed(rs.updateMany).mock.calls[0][0].where).toEqual({ id: "rs-1", notifiedAt: null });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("emails an automation booking's Cc / Bcc as stored", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ runId: "run-1", createdBy: "automation:R", notifyCc: ["cc@x.io"], notifyBcc: ["b@x.io"] }));
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow());
    await notifyScheduledRebootFinished("run-1");
    expect(h.deliver.mock.calls[0][0]).toEqual({ to: ["ops@example.com"], cc: ["cc@x.io"], bcc: ["b@x.io"], channelIds: [] });
  });

  it("labels a known method and passes an unknown one through", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ method: "controller-ap" }));
    await notifyScheduledRebootFinished("run-1");
    expect(deliveredFacts().text).toContain("managed FortiAP restart");
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ method: "device-rest" }));
    await notifyScheduledRebootFinished("run-1");
    expect(deliveredFacts(1).text).toContain("device-rest");
  });

  it("a send failure stores notifyError (≤ 2000 chars) and writes the warning Event", async () => {
    stubbed(rs.findUnique).mockResolvedValue(row({ runId: "run-1" }));
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow());
    stubbed(rs.update).mockRejectedValue(new Error("db")); // a failed write never blocks the Event
    h.deliver.mockResolvedValue("e".repeat(3000));
    await notifyScheduledRebootFinished("run-1");
    expect(rs.update).toHaveBeenCalledWith({ where: { id: "rs-1" }, data: { notifyError: "e".repeat(2000) } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.reboot_schedule_email_failed", level: "warning", details: { scheduleId: "rs-1", notifyEmails: ["ops@example.com"] } });
  });
});

// ─── notifyRebootRunStarted ───────────────────────────────────────────────────

describe("notifyRebootRunStarted", () => {
  it("nothing for an unknown run, an automation booking's run, or no recipients", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValueOnce(null);
    await notifyRebootRunStarted("run-1");
    stubbed(prisma.rebootRun.findUnique).mockResolvedValueOnce(runRow({ schedule: { id: "rs-1", scheduledFor: LATER, createdBy: "automation:R", notifyEmails: ["a@x.io"], notifyRecipients: null, notifyChannelIds: [] } }));
    await notifyRebootRunStarted("run-1");
    stubbed(prisma.rebootRun.findUnique).mockResolvedValueOnce(runRow());
    await notifyRebootRunStarted("run-1");
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("a booked run emails the BOOKING's list, scheduled, by the booker", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["run@x.io"], schedule: { id: "rs-1", scheduledFor: LATER, createdBy: "alice", notifyEmails: ["book@x.io"], notifyRecipients: null, notifyChannelIds: ["ch-1"] } }));
    await notifyRebootRunStarted("run-1");
    expect(h.targetFor.mock.calls[0][0]).toMatchObject({ assetId: "a-1", notifyEmails: ["book@x.io"], notifyChannelIds: ["ch-1"] });
    expect(h.deliver.mock.calls[0][0].to).toEqual(["book@x.io"]);
  });

  it("a reboot-now emails its own list", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["run@x.io"] }));
    await notifyRebootRunStarted("run-1");
    expect(h.deliver.mock.calls[0][0].to).toEqual(["run@x.io"]);
  });

  it("a send failure writes asset.reboot_email_failed with the 'started' notice", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["run@x.io"] }));
    h.deliver.mockResolvedValue("smtp down");
    await notifyRebootRunStarted("run-1");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.reboot_email_failed", actor: "system:reboot", level: "warning",
      message: 'The "started" email for the reboot could not be sent: smtp down',
      details: { runId: "run-1", notice: "started", notifyEmails: ["run@x.io"], error: "smtp down" },
    });
  });
});

// ─── notifyRebootRunFinished ──────────────────────────────────────────────────

describe("notifyRebootRunFinished", () => {
  it("skips a booked run, a run with no recipients, an already-notified run and an unfinished one", async () => {
    const cases = [
      runRow({ notifyEmails: ["a@x.io"], schedule: { id: "rs-1" } }),
      runRow({ notifyEmails: [] }),
      runRow({ notifyEmails: ["a@x.io"], notifiedAt: NOW }),
      runRow({ notifyEmails: ["a@x.io"], status: "rebooting" }),
    ];
    for (const c of cases) {
      stubbed(prisma.rebootRun.findUnique).mockResolvedValueOnce(c);
      await notifyRebootRunFinished("run-1");
    }
    stubbed(prisma.rebootRun.findUnique).mockResolvedValueOnce(null);
    await notifyRebootRunFinished("run-1");
    expect(prisma.rebootRun.updateMany).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("claims RebootRun.notifiedAt once; a lost claim sends nothing", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["a@x.io"] }));
    stubbed(prisma.rebootRun.updateMany).mockResolvedValue({ count: 0 });
    await notifyRebootRunFinished("run-1");
    expect(stubbed(prisma.rebootRun.updateMany).mock.calls[0][0].where).toEqual({ id: "run-1", notifiedAt: null });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("emails the outcome to the run's list", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["a@x.io"], status: "failed", error: "never came back" }));
    await notifyRebootRunFinished("run-1");
    expect(h.deliver.mock.calls[0][0].to).toEqual(["a@x.io"]);
    expect(deliveredFacts().text).toContain("never came back");
  });

  it("a send failure stores notifyError on the run and writes asset.reboot_email_failed with the outcome", async () => {
    stubbed(prisma.rebootRun.findUnique).mockResolvedValue(runRow({ notifyEmails: ["a@x.io"], status: "unverified" }));
    stubbed(prisma.rebootRun.update).mockResolvedValue({});
    h.deliver.mockResolvedValue("nope");
    await notifyRebootRunFinished("run-1");
    expect(prisma.rebootRun.update).toHaveBeenCalledWith({ where: { id: "run-1" }, data: { notifyError: "nope" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.reboot_email_failed", details: { notice: "unverified", notifyEmails: ["a@x.io"] } });
  });
});
