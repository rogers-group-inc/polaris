/**
 * tests/unit/rebootResultsCcBcc.test.ts — business rule 115(c): an
 * automation's reboot action names its results recipients with the notify
 * action's To / Cc / Bcc. The booking stores the resolved Cc / Bcc, a resolved
 * list may exceed the 20 a person may type, and a booking carrying a Cc or Bcc
 * sends ONE message to the whole To line instead of one per recipient.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  schedule: null as Record<string, unknown> | null,
  sent: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    rebootSchedule: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => h.schedule),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
        return { id: "sched-1", status: "pending", runId: null, error: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(), cancelledBy: null, cancelledAt: null, firedAt: null, notifiedAt: null, notifyError: null, ...data };
      }),
    },
    rebootRun: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ status: "succeeded", error: null, method: "agent", authority: "Polaris Agent", startedAt: new Date(), finishedAt: new Date(), log: [] })),
    },
    asset: { findUnique: vi.fn(async () => ({ hostname: "SRV-01", ipAddress: "10.0.0.5", model: null, lastRebootAt: null })) },
    user: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("../../src/services/rebootService.js", () => ({
  checkSchedulableReboot: vi.fn(async () => ({ plan: { method: "agent", authority: "Polaris Agent" }, warnings: [] })),
  startReboot: vi.fn(),
  recordRebootCredentialUse: vi.fn(async () => undefined),
  RebootRunConflictError: class extends Error {},
}));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({
  applyBrandLetterhead: vi.fn(async (m: unknown) => m),
  sendEmailThroughChannel: vi.fn(async (_c: unknown, m: Record<string, unknown>) => { h.sent.push(m); }),
}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({ resolveSummaryChannel: vi.fn(async () => ({ type: "smtp", config: {} })) }));

import { bookRebootFromAutomation, createRebootSchedule, notifyScheduledRebootFinished } from "../../src/services/rebootScheduleService.js";

const base = { assetId: "a1", when: "at" as const, at: "02:00", minGapHours: 24, ruleId: "r1", ruleName: "Memory", notificationId: "n1" };
const scheduleRow = (over: Record<string, unknown>) => ({
  id: "s1", assetId: "a1", scheduledFor: new Date(), status: "started", runId: "run-1", error: null, createdBy: "automation:Memory",
  createdAt: new Date(), updatedBy: null, updatedAt: new Date(), cancelledBy: null, cancelledAt: null, firedAt: new Date(),
  notifiedAt: null, notifyError: null, notifyEmails: ["a@example.com", "b@example.com"], notifyCc: [], notifyBcc: [], ...over,
});

beforeEach(() => {
  h.created = [];
  h.sent = [];
  h.schedule = null;
});

describe("booking an automation's reboot", () => {
  it("stores the resolved Cc and Bcc beside the To", async () => {
    await bookRebootFromAutomation({ ...base, notifyEmails: ["a@example.com"], notifyCc: ["Boss@Example.com"], notifyBcc: ["audit@example.com"] });
    expect(h.created[0]).toMatchObject({ notifyEmails: ["a@example.com"], notifyCc: ["boss@example.com"], notifyBcc: ["audit@example.com"] });
  });

  it("accepts a resolved To longer than the 20 a person may type", async () => {
    const many = Array.from({ length: 35 }, (_, i) => `user${i}@example.com`);
    const res = await bookRebootFromAutomation({ ...base, notifyEmails: many });
    expect(res.booked).toBe(true);
    expect((h.created[0].notifyEmails as string[]).length).toBe(35);
  });

  it("an operator's booking keeps the 20-recipient cap and empty Cc / Bcc", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `user${i}@example.com`);
    await expect(createRebootSchedule({ assetId: "a1", scheduledFor: new Date(Date.now() + 3_600_000), notifyEmails: many, actor: "op" })).rejects.toThrow(/At most 20/);
    await createRebootSchedule({ assetId: "a1", scheduledFor: new Date(Date.now() + 3_600_000), notifyEmails: ["a@example.com"], actor: "op" });
    expect(h.created[0]).toMatchObject({ notifyCc: [], notifyBcc: [] });
  });
});

describe("the results email", () => {
  it("goes one message per To recipient when there is no Cc or Bcc", async () => {
    h.schedule = scheduleRow({});
    await notifyScheduledRebootFinished("run-1");
    expect(h.sent.map((m) => m.to)).toEqual([["a@example.com"], ["b@example.com"]]);
  });

  it("goes as ONE message with the whole To line when a Cc or Bcc is set", async () => {
    h.schedule = scheduleRow({ notifyCc: ["boss@example.com"], notifyBcc: ["audit@example.com"] });
    await notifyScheduledRebootFinished("run-1");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: ["a@example.com", "b@example.com"], cc: ["boss@example.com"], bcc: ["audit@example.com"] });
  });
});
