/**
 * tests/unit/rebootAutomationBooking.test.ts — business rule 115(c): an
 * automation BOOKS a reboot of the triggering device, through the reboot
 * scheduler, and skips (an Event, not a failure) when one is already booked
 * or the device rebooted within the minimum gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  pending: null as { scheduledFor: Date } | null,
  recentRun: null as { startedAt: Date } | null,
  lastRebootAt: null as Date | null,
  created: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, any>>,
  credUses: [] as Array<{ assetId: string; actor: Record<string, unknown> }>,
  checkThrows: null as Error | null,
  createThrows: null as unknown,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findFirst: vi.fn(async () => h.pending),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (h.createThrows) throw h.createThrows;
        h.created.push(data);
        return { id: "sched-1", status: "pending", runId: null, error: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(), cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, ...data };
      }),
    },
    rebootRun: { findFirst: vi.fn(async () => h.recentRun) },
    asset: { findUnique: vi.fn(async (args: { select: Record<string, unknown> }) => ("lastRebootAt" in args.select ? { lastRebootAt: h.lastRebootAt } : { hostname: "SRV-01", ipAddress: "10.0.0.5" })) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async (e: Record<string, unknown>) => { h.events.push(e); }) }));
vi.mock("../../src/services/rebootService.js", () => ({
  checkSchedulableReboot: vi.fn(async () => { if (h.checkThrows) throw h.checkThrows; return { plan: { method: "agent", authority: "Polaris Agent" }, warnings: [] }; }),
  startReboot: vi.fn(),
  recordRebootCredentialUse: vi.fn(async (assetId: string, actor: Record<string, unknown>) => { h.credUses.push({ assetId, actor }); }),
  RebootRunConflictError: class extends Error {},
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({ applyBrandLetterhead: vi.fn(), sendEmailThroughChannel: vi.fn() }));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn() }));

import { bookRebootFromAutomation, nextAutomationRebootTime } from "../../src/services/rebootScheduleService.js";
import { AppError } from "../../src/utils/errors.js";

const base = {
  assetId: "a1", when: "at" as const, at: "02:00", notifyEmails: ["noc@example.com"], minGapHours: 24,
  ruleId: "r1", ruleName: "Memory over 90%", notificationId: "n1",
};

beforeEach(() => {
  h.pending = null;
  h.recentRun = null;
  h.lastRebootAt = null;
  h.created = [];
  h.events = [];
  h.credUses = [];
  h.checkThrows = null;
  h.createThrows = null;
});

describe("nextAutomationRebootTime", () => {
  it("books the next occurrence of the time today when it is still ahead", () => {
    const now = new Date(2026, 9, 13, 14, 0, 0);
    const d = nextAutomationRebootTime("at", "22:30", now);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([13, 22, 30]);
  });
  it("rolls to tomorrow when the time has passed today", () => {
    const now = new Date(2026, 9, 13, 14, 0, 0);
    const d = nextAutomationRebootTime("at", "02:00", now);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([14, 2, 0]);
  });
  it("rolls to tomorrow when the time is less than the booking lead away", () => {
    const now = new Date(2026, 9, 13, 1, 59, 30);
    const d = nextAutomationRebootTime("at", "02:00", now);
    expect(d.getDate()).toBe(14);
  });
  it("'now' books just past the minimum lead", () => {
    const now = new Date(2026, 9, 13, 14, 0, 0);
    const d = nextAutomationRebootTime("now", "02:00", now);
    expect(d.getTime() - now.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(d.getTime() - now.getTime()).toBeLessThan(5 * 60_000);
  });
  it("refuses a malformed time", () => {
    expect(() => nextAutomationRebootTime("at", "25:00", new Date())).toThrow(AppError);
  });
});

describe("bookRebootFromAutomation", () => {
  it("books through the scheduler, named for the automation, and audits the credential use", async () => {
    const res = await bookRebootFromAutomation(base);
    expect(res.booked).toBe(true);
    expect(h.created[0]).toMatchObject({ assetId: "a1", createdBy: "automation:Memory over 90%", notifyEmails: ["noc@example.com"] });
    const ev = h.events.find((e) => e.action === "asset.reboot_scheduled")!;
    expect(ev.details).toMatchObject({ automation: true, ruleId: "r1", notificationId: "n1" });
    expect(h.credUses[0]).toMatchObject({ assetId: "a1", actor: { username: null, actor: "automation:Memory over 90%", mayUseAny: false } });
  });

  it("skips — not fails — when a reboot is already booked for the device", async () => {
    h.pending = { scheduledFor: new Date("2026-10-14T07:00:00Z") };
    const res = await bookRebootFromAutomation(base);
    expect(res).toMatchObject({ booked: false });
    expect(h.created).toHaveLength(0);
    expect(h.events[0]).toMatchObject({ action: "asset.reboot_automation_skipped", level: "info" });
  });

  it("skips when Polaris rebooted the device within the gap", async () => {
    h.recentRun = { startedAt: new Date(Date.now() - 3 * 3_600_000) };
    const res = await bookRebootFromAutomation(base);
    expect(res.booked).toBe(false);
    expect((res as { reason: string }).reason).toMatch(/24 h minimum gap/);
  });

  it("skips when monitoring saw the device reboot on its own within the gap", async () => {
    h.lastRebootAt = new Date(Date.now() - 3_600_000);
    expect((await bookRebootFromAutomation(base)).booked).toBe(false);
  });

  it("books when the last reboot is older than the gap", async () => {
    h.lastRebootAt = new Date(Date.now() - 30 * 3_600_000);
    expect((await bookRebootFromAutomation(base)).booked).toBe(true);
  });

  it("a refusing gate (no opt-in, HA) throws for the action-error Event", async () => {
    h.checkThrows = new AppError(400, "the FortiGate is in an HA cluster");
    await expect(bookRebootFromAutomation(base)).rejects.toThrow(/HA cluster/);
    expect(h.created).toHaveLength(0);
  });

  it("losing the booking race to another booking is a skip", async () => {
    h.createThrows = Object.assign(new Error("unique"), { code: "P2002" });
    const res = await bookRebootFromAutomation(base);
    expect(res.booked).toBe(false);
    expect(h.credUses).toHaveLength(0);
  });
});
