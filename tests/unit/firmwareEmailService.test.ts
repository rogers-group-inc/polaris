/**
 * tests/unit/firmwareEmailService.test.ts
 *
 * The firmware upgrade emails beyond a booking's results (business rule 93,
 * 2026-11-09): a run that carries recipients emails them when it starts, and
 * a flash started NOW with recipients also emails how it ended — once. A
 * booked run's outcome is the booking's results email (firmwareSchedule.test),
 * so the run notifier stays silent for it. Plus the template's wording for a
 * flash started now, which has no booking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    runs: new Map<string, Record<string, any>>(),
    users: [] as Array<{ email: string; timezone: string; detectedTimezone: string | null }>,
    channel: { id: "ch-1", type: "smtp", enabled: true, config: {} } as Record<string, unknown> | null,
    sent: [] as Array<{ to: string[]; subject: string; text: string; html: string }>,
    sendFails: new Set<string>(),
  };
  return { state, logEvent: vi.fn(async () => {}) };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    firmwareUpgradeRun: {
      findUnique: vi.fn(async ({ where }: any) => { const r = h.state.runs.get(where.id); return r ? { ...r } : null; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const r = h.state.runs.get(where.id);
        if (!r || (where.notifiedAt === null && r.notifiedAt)) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.state.runs.get(where.id)!, data)),
    },
    asset: { findUnique: vi.fn(async () => ({ hostname: "lab-sw1", ipAddress: "10.0.0.5", model: "FortiSwitch S108FF", osVersion: "7.4.3 build0542" })) },
    user: { findMany: vi.fn(async () => h.state.users) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn(async () => h.state.channel) }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: vi.fn(async (m: any) => m),
  sendEmailThroughChannel: vi.fn(async (_c: unknown, m: any) => {
    if (h.state.sendFails.has(m.to[0])) throw new Error("SMTP 550");
    h.state.sent.push(m);
  }),
}));
vi.mock("../../src/services/userTimezoneService.js", () => ({
  resolveTimeZone: (tz: string) => tz,
  serverTimeZone: () => "America/Chicago",
}));

import { notifyRunStarted, notifyRunFinished, sendFirmwareEmail } from "../../src/services/firmwareEmailService.js";
import { renderFirmwareResultEmail } from "../../src/utils/firmwareResultEmailTemplate.js";

const STARTED = new Date("2026-11-09T14:00:00Z");

function run(over: Record<string, unknown> = {}) {
  const r = {
    id: "run-1", assetId: "asset-1", status: "running", result: null, error: null, fromVersion: "7.4.3 build0542", toVersion: "7.6.8 build1164",
    verifiedVersion: null, startedBy: "alice", startedAt: STARTED, finishedAt: null, log: [],
    notifyEmails: ["ops@example.com", "noc@example.com"], notifiedAt: null, notifyError: null, schedule: null,
    ...over,
  };
  h.state.runs.set(r.id as string, r);
  return r;
}

beforeEach(() => {
  h.state.runs = new Map();
  h.state.users = [];
  h.state.channel = { id: "ch-1", type: "smtp", enabled: true, config: {} };
  h.state.sent = [];
  h.state.sendFails = new Set();
  h.logEvent.mockClear();
});

describe("started", () => {
  it("a flash started now emails each recipient that it began, naming who started it", async () => {
    run();
    await notifyRunStarted("run-1");
    expect(h.state.sent.map((m) => m.to[0])).toEqual(["ops@example.com", "noc@example.com"]);
    expect(h.state.sent[0].subject).toBe("[Polaris] Firmware upgrade started: lab-sw1 → 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("UPGRADE STARTED");
    expect(h.state.sent[0].text).toContain("Started by: alice");
    expect(h.state.sent[0].text).not.toContain("Scheduled for");
    expect(h.state.sent[0].text).toContain("another email when it finishes");
  });

  it("a booked run says 'Scheduled firmware upgrade started' with the booked time and the booker", async () => {
    run({ startedBy: "alice", schedule: { id: "sch-1", scheduledFor: STARTED, createdBy: "bob" } });
    await notifyRunStarted("run-1");
    expect(h.state.sent[0].subject).toBe("[Polaris] Scheduled firmware upgrade started: lab-sw1 → 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("Scheduled for:");
    expect(h.state.sent[0].text).toContain("Scheduled by: bob");
  });

  it("a run with no recipients sends nothing", async () => {
    run({ notifyEmails: [] });
    await notifyRunStarted("run-1");
    await notifyRunFinished("run-1");
    expect(h.state.sent).toHaveLength(0);
  });

  it("no email channel is a warning Event naming the notice — never a throw", async () => {
    h.state.channel = null;
    run();
    await expect(notifyRunStarted("run-1")).resolves.toBeUndefined();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "firmware.upgrade_email_failed", level: "warning", details: expect.objectContaining({ notice: "started", runId: "run-1" }),
    }));
  });
});

describe("finished (a flash started now)", () => {
  it("emails the outcome once, with the log tail; a second caller (runner + boot sweep) sends nothing", async () => {
    run({
      status: "succeeded", result: "upgraded", verifiedVersion: "7.6.8 build1164", finishedAt: new Date(STARTED.getTime() + 8 * 60_000),
      log: Array.from({ length: 30 }, (_, i) => ({ t: STARTED.toISOString(), level: "info", msg: `line ${i}` })),
    });
    await notifyRunFinished("run-1");
    expect(h.state.sent).toHaveLength(2);
    expect(h.state.sent[0].subject).toBe("[Polaris] Firmware upgrade succeeded: lab-sw1 → 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("line 29");
    expect(h.state.sent[0].text).toContain("Duration:");
    expect(h.state.runs.get("run-1")!.notifiedAt).toBeInstanceOf(Date);
    await notifyRunFinished("run-1");
    expect(h.state.sent).toHaveLength(2);
  });

  it("says FAILED with the error", async () => {
    run({ status: "failed", result: "failed", error: "device web UI unreachable", finishedAt: new Date() });
    await notifyRunFinished("run-1");
    expect(h.state.sent[0].subject).toBe("[Polaris] Firmware upgrade FAILED: lab-sw1 → 7.6.8 build1164");
    expect(h.state.sent[0].text).toContain("device web UI unreachable");
  });

  it("stays silent while the run is live, and for a BOOKED run — the booking's results email covers it", async () => {
    run({ status: "running" });
    await notifyRunFinished("run-1");
    run({ status: "succeeded", finishedAt: new Date(), schedule: { id: "sch-1", scheduledFor: STARTED, createdBy: "bob" } });
    await notifyRunFinished("run-1");
    expect(h.state.sent).toHaveLength(0);
    expect(h.state.runs.get("run-1")!.notifiedAt).toBeNull();
  });

  it("a recipient that fails is recorded on the run; the others still get it", async () => {
    h.state.sendFails.add("ops@example.com");
    run({ status: "unverified", result: "unverified", finishedAt: new Date() });
    await notifyRunFinished("run-1");
    expect(h.state.sent.map((m) => m.to[0])).toEqual(["noc@example.com"]);
    expect(h.state.runs.get("run-1")!.notifyError).toMatch(/ops@example.com: SMTP 550/);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "firmware.upgrade_email_failed" }));
  });
});

describe("sendFirmwareEmail", () => {
  it("draws each reader's times in their own zone when the address is a user's, else the server's", async () => {
    h.state.users = [{ email: "ops@example.com", timezone: "America/New_York", detectedTimezone: null }];
    const err = await sendFirmwareEmail({ to: ["ops@example.com", "noc@example.com"], cc: [], bcc: [], channelIds: [] }, {
      outcome: "started", scheduled: false, assetId: "asset-1", deviceName: "lab-sw1", model: null, fromVersion: null, toVersion: "7.6.8",
      verifiedVersion: null, result: null, error: null, scheduledFor: null, startedAt: STARTED, finishedAt: null, scheduledBy: "alice", log: [],
    });
    expect(err).toBeNull();
    expect(h.state.sent[0].text).toContain("Times are shown in America/New_York");
    expect(h.state.sent[1].text).toContain("Times are shown in America/Chicago");
  });

  it("an empty list sends nothing and is not an error", async () => {
    expect(await sendFirmwareEmail({ to: [], cc: [], bcc: [], channelIds: [] }, {} as any)).toBeNull();
    expect(h.state.sent).toHaveLength(0);
  });
});

describe("the template (pure)", () => {
  const base = {
    assetId: "asset-1", deviceName: "lab-sw1", model: "FortiSwitch S108FF", fromVersion: "7.4.3", toVersion: "7.6.8",
    verifiedVersion: null, result: null, error: null, startedAt: null, finishedAt: null, scheduledBy: "alice", log: [], zone: "UTC",
  };

  it("a booking notice names the time in the subject and keeps the booked-flash label", () => {
    const r = renderFirmwareResultEmail({ ...base, outcome: "scheduled", scheduledFor: "2026-11-10T07:00:00Z" });
    expect(r.subject).toMatch(/^\[Polaris\] Firmware upgrade scheduled for .*2026.*: lab-sw1 → 7\.6\.8$/);
    expect(r.html).toContain("Scheduled firmware upgrade");
    expect(r.text).toContain("Sent by Polaris · scheduled firmware upgrade");
  });

  it("warnings appear only on a booking notice", () => {
    const sched = renderFirmwareResultEmail({ ...base, outcome: "rescheduled", scheduledFor: "2026-11-10T07:00:00Z", warnings: ["the device is down"] });
    expect(sched.text).toContain("Right now the device is down.");
    const started = renderFirmwareResultEmail({ ...base, outcome: "started", scheduledFor: null, scheduled: false, warnings: ["the device is down"] });
    expect(started.text).not.toContain("Right now");
  });

  it("a flash started now reads 'Firmware upgrade' and 'Started by', with no booked time", () => {
    const r = renderFirmwareResultEmail({ ...base, outcome: "succeeded", scheduled: false, scheduledFor: null, verifiedVersion: "7.6.8" });
    expect(r.subject).toBe("[Polaris] Firmware upgrade succeeded: lab-sw1 → 7.6.8");
    expect(r.text).toContain("Started by: alice");
    expect(r.text).not.toContain("Scheduled");
    expect(r.html).not.toContain("Scheduled firmware upgrade");
  });
});
