/**
 * tests/unit/rebootEmailNotices.test.ts — the reboot emails beyond a
 * booking's results (business rule 115, the rule-93 shape, 2026-11-09): an
 * operator's booking emails `scheduled` / `rescheduled` and, when it fires,
 * `started`; an AUTOMATION's booking gets only its result; a reboot started
 * now with recipients emails `started` and its outcome, once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  runs: new Map<string, Record<string, any>>(),
  sent: [] as Array<{ to: string[]; cc?: string[]; subject: string; text: string }>,
  channel: { type: "smtp", config: {} } as Record<string, unknown> | null,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: any) => { const r = h.rows.find((x) => x.id === where.id); return r ? { ...r } : null; }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `s${h.rows.length + 1}`, status: "pending", runId: null, error: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(), cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, ...data };
        h.rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const r = h.rows.find((x) => x.id === where.id);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: vi.fn(async () => ({})),
    },
    rebootRun: {
      findUnique: vi.fn(async ({ where }: any) => { const r = h.runs.get(where.id); return r ? { ...r } : null; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const r = h.runs.get(where.id);
        if (!r || (where.notifiedAt === null && r.notifiedAt)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.runs.get(where.id)!, data)),
    },
    asset: { findUnique: vi.fn(async () => ({ hostname: "GATE-1", ipAddress: "10.0.0.1", model: "FortiGate 60F" })) },
    user: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/rebootService.js", () => ({
  checkSchedulableReboot: vi.fn(async () => ({ plan: { method: "fortigate-rest", authority: "Lab FG" }, warnings: ["the device is down"] })),
  startReboot: vi.fn(),
  recordRebootCredentialUse: vi.fn(async () => undefined),
  RebootRunConflictError: class extends Error {},
}));
vi.mock("../../src/services/rebootSettingsService.js", () => ({ resolveRebootNote: vi.fn(async (n: unknown) => (n as string) ?? null) }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: vi.fn(async (m: unknown) => m),
  sendEmailThroughChannel: vi.fn(async (_c: unknown, m: any) => { h.sent.push(m); }),
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn(async () => h.channel) }));

import { createRebootSchedule, updateRebootSchedule, notifyRebootRunStarted, notifyRebootRunFinished } from "../../src/services/rebootScheduleService.js";

const drain = () => new Promise((r) => setTimeout(r, 0));
const LATER = new Date(Date.now() + 6 * 3_600_000);

function run(over: Record<string, unknown> = {}) {
  const r = {
    id: "run-1", assetId: "a1", status: "rebooting", error: null, method: "fortigate-rest", authority: "Lab FG", note: null,
    startedBy: "alice", startedAt: new Date(), finishedAt: null, log: [], notifyEmails: [] as string[], notifiedAt: null, notifyError: null,
    schedule: null as Record<string, unknown> | null, ...over,
  };
  h.runs.set(r.id, r);
  return r;
}

beforeEach(() => {
  h.rows = [];
  h.runs = new Map();
  h.sent = [];
  h.channel = { type: "smtp", config: {} };
  eventLog.logEvent.mockClear();
});

describe("booking notices", () => {
  it("an operator's booking emails every recipient that it is scheduled, with today's blocker", async () => {
    await createRebootSchedule({ assetId: "a1", scheduledFor: LATER, notifyEmails: ["ops@example.com", "noc@example.com"], actor: "alice" });
    await drain();
    expect(h.sent.map((m) => m.to[0])).toEqual(["ops@example.com", "noc@example.com"]);
    expect(h.sent[0].subject).toMatch(/^\[Polaris\] Reboot scheduled for .+: GATE-1$/);
    expect(h.sent[0].text).toContain("Right now the device is down");
    expect(h.sent[0].text).toContain("Scheduled by: alice");
  });

  it("an automation's booking sends no notice — only its result, later", async () => {
    await createRebootSchedule({ assetId: "a1", scheduledFor: LATER, notifyEmails: ["ops@example.com"], actor: "automation:Memory" });
    await drain();
    expect(h.sent).toHaveLength(0);
  });

  it("a new time emails everyone 'rescheduled'; a new address alone hears 'scheduled'", async () => {
    const s = await createRebootSchedule({ assetId: "a1", scheduledFor: LATER, notifyEmails: ["ops@example.com"], actor: "alice" });
    await drain();
    h.sent = [];
    await updateRebootSchedule({ assetId: "a1", scheduleId: s.id, notifyEmails: ["ops@example.com", "noc@example.com"], actor: "bob" });
    await drain();
    expect(h.sent.map((m) => m.to[0])).toEqual(["noc@example.com"]);
    expect(h.sent[0].subject).toMatch(/Reboot scheduled for/);
    h.sent = [];
    await updateRebootSchedule({ assetId: "a1", scheduleId: s.id, scheduledFor: new Date(LATER.getTime() + 3_600_000), actor: "bob" });
    await drain();
    expect(h.sent.map((m) => m.to[0])).toEqual(["ops@example.com", "noc@example.com"]);
    expect(h.sent[0].subject).toMatch(/Reboot rescheduled for/);
  });

  it("a notice with no email channel is a warning Event naming it; the booking stands", async () => {
    h.channel = null;
    const s = await createRebootSchedule({ assetId: "a1", scheduledFor: LATER, notifyEmails: ["ops@example.com"], actor: "alice" });
    await drain();
    expect(s.status).toBe("pending");
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.reboot_schedule_email_failed", details: expect.objectContaining({ notice: "scheduled" }) }));
  });
});

describe("started", () => {
  it("a booked run emails the booking's recipients 'Scheduled reboot started'", async () => {
    run({ schedule: { id: "s1", scheduledFor: LATER, createdBy: "alice", notifyEmails: ["ops@example.com"] } });
    await notifyRebootRunStarted("run-1");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].subject).toBe("[Polaris] Scheduled reboot started: GATE-1");
    expect(h.sent[0].text).toContain("Scheduled by: alice");
  });

  it("an automation's booked run is silent at start", async () => {
    run({ schedule: { id: "s1", scheduledFor: LATER, createdBy: "automation:Memory", notifyEmails: ["ops@example.com"] } });
    await notifyRebootRunStarted("run-1");
    expect(h.sent).toHaveLength(0);
  });

  it("a reboot started now emails its own recipients 'Reboot started', naming who started it", async () => {
    run({ notifyEmails: ["ops@example.com"] });
    await notifyRebootRunStarted("run-1");
    expect(h.sent[0].subject).toBe("[Polaris] Reboot started: GATE-1");
    expect(h.sent[0].text).toContain("Started by: alice");
    expect(h.sent[0].text).not.toContain("Scheduled for");
  });

  it("no recipients, no email", async () => {
    run();
    await notifyRebootRunStarted("run-1");
    expect(h.sent).toHaveLength(0);
  });
});

describe("finished (a reboot started now)", () => {
  it("emails the outcome once; a second caller sends nothing", async () => {
    run({ status: "succeeded", finishedAt: new Date(), notifyEmails: ["ops@example.com", "noc@example.com"] });
    await notifyRebootRunFinished("run-1");
    await notifyRebootRunFinished("run-1");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0].subject).toBe("[Polaris] Reboot succeeded: GATE-1");
  });

  it("is silent while live and for a booked run — its booking's results email covers it", async () => {
    run({ status: "rebooting", notifyEmails: ["ops@example.com"] });
    await notifyRebootRunFinished("run-1");
    run({ status: "failed", finishedAt: new Date(), notifyEmails: ["ops@example.com"], schedule: { id: "s1", scheduledFor: LATER, createdBy: "alice", notifyEmails: ["ops@example.com"] } });
    await notifyRebootRunFinished("run-1");
    expect(h.sent).toHaveLength(0);
  });

  it("a failed send is recorded on the run and as an Event", async () => {
    h.channel = null;
    run({ status: "failed", error: "did not come back", finishedAt: new Date(), notifyEmails: ["ops@example.com"] });
    await notifyRebootRunFinished("run-1");
    expect(h.runs.get("run-1")!.notifyError).toMatch(/no enabled email channel/);
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.reboot_email_failed" }));
  });
});
