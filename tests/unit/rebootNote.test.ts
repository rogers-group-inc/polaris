/**
 * tests/unit/rebootNote.test.ts — business rule 115(d): a reboot says why.
 * The note is optional unless the install's `rebootConfig.requireNote` is on;
 * then every operator reboot and booking without one is refused (400), an
 * automation's booking always carries its rule's name, and a booking's note
 * rides onto the run it fires and into the results email.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requireNote: false,
  settingThrows: false,
  pending: null as Record<string, unknown> | null,
  current: null as Record<string, unknown> | null,
  created: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, any>>,
  started: [] as Array<Record<string, unknown>>,
  due: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async () => {
        if (h.settingThrows) throw new Error("db down");
        return { value: { requireNote: h.requireNote } };
      }),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => { h.saved.push(create); return create; }),
    },
    rebootSchedule: {
      findFirst: vi.fn(async () => h.pending),
      findUnique: vi.fn(async () => h.current),
      findMany: vi.fn(async () => h.due),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
        return { id: "sched-1", status: "pending", runId: null, error: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(), cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, ...data };
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.updates.push(data);
        if (h.current && data.note !== undefined) h.current = { ...h.current, note: data.note };
        return { count: 1 };
      }),
      update: vi.fn(async () => ({})),
    },
    rebootRun: { findFirst: vi.fn(async () => null) },
    asset: { findUnique: vi.fn(async (args: { select: Record<string, unknown> }) => ("lastRebootAt" in args.select ? { lastRebootAt: null } : { hostname: "SRV-01", ipAddress: "10.0.0.5" })) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async (e: Record<string, unknown>) => { h.events.push(e); }) }));
vi.mock("../../src/services/rebootService.js", () => ({
  checkSchedulableReboot: vi.fn(async () => ({ plan: { method: "agent", authority: "Polaris Agent" }, warnings: [] })),
  startReboot: vi.fn(async (input: Record<string, unknown>) => { h.started.push(input); return { id: "run-1" }; }),
  recordRebootCredentialUse: vi.fn(async () => undefined),
  RebootRunConflictError: class extends Error {},
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({ applyBrandLetterhead: vi.fn(), sendEmailThroughChannel: vi.fn() }));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn() }));

import {
  normalizeRebootNote,
  parseRebootSettings,
  resolveRebootNote,
  getRebootSettings,
  saveRebootSettings,
  invalidateRebootSettingsCache,
  REBOOT_NOTE_MAX,
} from "../../src/services/rebootSettingsService.js";
import { createRebootSchedule, updateRebootSchedule, bookRebootFromAutomation, runDueRebootSchedules } from "../../src/services/rebootScheduleService.js";
import { renderRebootResultEmail } from "../../src/utils/rebootResultEmailTemplate.js";

const soon = () => new Date(Date.now() + 60 * 60_000);

beforeEach(() => {
  invalidateRebootSettingsCache();
  Object.assign(h, { requireNote: false, settingThrows: false, pending: null, current: null, created: [], updates: [], saved: [], events: [], started: [], due: [] });
});

describe("normalizeRebootNote", () => {
  it("trims, flattens line breaks to one line, and reads blank as no note", () => {
    expect(normalizeRebootNote("  Memory leak\r\nafter  7.4.3 \t ")).toBe("Memory leak after 7.4.3");
    expect(normalizeRebootNote("   ")).toBeNull();
    expect(normalizeRebootNote("")).toBeNull();
    expect(normalizeRebootNote(null)).toBeNull();
    expect(normalizeRebootNote(undefined)).toBeNull();
  });
  it("refuses a note longer than the cap, and anything that is not text", () => {
    expect(normalizeRebootNote("x".repeat(REBOOT_NOTE_MAX))).toHaveLength(REBOOT_NOTE_MAX);
    expect(() => normalizeRebootNote("x".repeat(REBOOT_NOTE_MAX + 1))).toThrow(/keep it to/);
    expect(() => normalizeRebootNote(42)).toThrow(/text/);
  });
});

describe("the requireNote setting", () => {
  it("is off unless the stored value is literally true", () => {
    expect(parseRebootSettings(undefined)).toEqual({ requireNote: false });
    expect(parseRebootSettings({ requireNote: "yes" })).toEqual({ requireNote: false });
    expect(parseRebootSettings({ requireNote: true })).toEqual({ requireNote: true });
  });
  it("reads as optional when the settings row cannot be read — an outage never blocks a reboot", async () => {
    h.settingThrows = true;
    expect(await getRebootSettings()).toEqual({ requireNote: false });
    expect(await resolveRebootNote("")).toBeNull();
  });
  it("refuses a blank note only while required", async () => {
    expect(await resolveRebootNote("")).toBeNull();
    invalidateRebootSettingsCache();
    h.requireNote = true;
    await expect(resolveRebootNote("  ")).rejects.toMatchObject({ httpStatus: 400 });
    expect(await resolveRebootNote("Patch Tuesday")).toBe("Patch Tuesday");
  });
  it("records a change of the switch as an Event, and a re-save of the same value as nothing", async () => {
    await saveRebootSettings({ requireNote: true }, "alice");
    expect(h.saved).toEqual([{ key: "rebootConfig", value: { requireNote: true } }]);
    expect(h.events).toEqual([expect.objectContaining({ action: "setting.reboot_updated", actor: "alice" })]);
    h.events = [];
    await saveRebootSettings({ requireNote: true }, "alice");
    expect(h.events).toEqual([]);
  });
});

describe("a booking's note", () => {
  it("is stored, and named in the booking Event", async () => {
    await createRebootSchedule({ assetId: "a1", scheduledFor: soon(), notifyEmails: ["noc@example.com"], note: "Clear stuck sessions", actor: "alice" });
    expect(h.created[0]).toMatchObject({ note: "Clear stuck sessions" });
    expect(h.events[0]).toMatchObject({ action: "asset.reboot_scheduled", details: expect.objectContaining({ note: "Clear stuck sessions" }) });
    expect(h.events[0].message).toMatch(/reason: Clear stuck sessions/);
  });
  it("is refused blank while required, and nothing is booked", async () => {
    h.requireNote = true;
    await expect(createRebootSchedule({ assetId: "a1", scheduledFor: soon(), notifyEmails: ["noc@example.com"], actor: "alice" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.created).toEqual([]);
  });
  it("is kept when a change leaves it out, and judged again when a change sends one", async () => {
    h.current = { id: "sched-1", assetId: "a1", status: "pending", scheduledFor: soon(), notifyEmails: ["noc@example.com"], notifyCc: [], notifyBcc: [], note: "Old reason" };
    await updateRebootSchedule({ assetId: "a1", scheduleId: "sched-1", notifyEmails: ["ops@example.com"], actor: "bob" });
    expect(h.updates[0]).not.toHaveProperty("note");
    h.requireNote = true;
    await expect(updateRebootSchedule({ assetId: "a1", scheduleId: "sched-1", note: "", actor: "bob" })).rejects.toMatchObject({ httpStatus: 400 });
    await updateRebootSchedule({ assetId: "a1", scheduleId: "sched-1", note: "New reason", actor: "bob" });
    expect(h.updates.at(-1)).toMatchObject({ note: "New reason" });
    expect(h.events.at(-1)?.message).toMatch(/reason "New reason"/);
  });
  it("is the rule's name for an automation's booking, so a required note never fails the action", async () => {
    h.requireNote = true;
    const r = await bookRebootFromAutomation({
      assetId: "a1", when: "now", at: "", notifyEmails: ["noc@example.com"], minGapHours: 24, ruleId: "r1", ruleName: "Memory over 90%", notificationId: "n1",
    });
    expect(r.booked).toBe(true);
    expect(h.created[0]).toMatchObject({ note: 'Automation "Memory over 90%"' });
  });
  it("rides onto the run when the booking fires", async () => {
    h.due = [{ id: "sched-1", assetId: "a1", scheduledFor: new Date(), createdBy: "alice", error: null, note: "Clear stuck sessions" }];
    await runDueRebootSchedules(new Date());
    expect(h.started).toEqual([expect.objectContaining({ scheduleId: "sched-1", note: "Clear stuck sessions", actor: "alice" })]);
  });
});

describe("the results email", () => {
  const base = {
    outcome: "succeeded" as const, assetId: "a1", deviceName: "SRV-01", model: null, method: "the Polaris Agent", authority: "Polaris Agent",
    error: null, scheduledFor: "2026-10-26T02:00:00Z", startedAt: "2026-10-26T02:00:10Z", finishedAt: "2026-10-26T02:04:00Z", scheduledBy: "alice", log: [], zone: "UTC",
  };
  it("says why when the booking had a reason, escaped in the HTML", () => {
    const e = renderRebootResultEmail({ ...base, note: "Leak <after> 7.4.3" });
    expect(e.text).toContain("Reason: Leak <after> 7.4.3");
    expect(e.html).toContain("Leak &lt;after&gt; 7.4.3");
  });
  it("has no Reason line when nobody gave one", () => {
    expect(renderRebootResultEmail({ ...base, note: null }).text).not.toContain("Reason:");
  });
});
