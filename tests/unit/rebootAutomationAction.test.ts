/**
 * tests/unit/rebootAutomationAction.test.ts — the `reboot` automation action
 * (business rule 115(c)) at the action layer:
 *   - executeActions books it for the TRIGGERING asset and never treats it as
 *     a script (the final-else trap);
 *   - a skip is not "executed", a refusal is an automation.action_error;
 *   - assertActionRefs refuses it on reset and resolved lists;
 *   - a Test button never books one;
 *   - saving one needs assets:write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  bookings: [] as Array<Record<string, unknown>>,
  result: { booked: true, scheduleId: "s1", scheduledFor: new Date() } as Record<string, unknown>,
  throws: null as Error | null,
  events: [] as Array<Record<string, any>>,
  scriptRuns: 0,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    notification: { findUnique: vi.fn(async () => null), update: vi.fn() },
    automationScript: { findMany: vi.fn(async () => []) },
    notificationChannel: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: Record<string, unknown>) => { h.events.push(e); }),
  logEventsBatch: vi.fn(async () => 0),
}));
vi.mock("../../src/services/rebootScheduleService.js", () => ({
  bookRebootFromAutomation: vi.fn(async (input: Record<string, unknown>) => {
    h.bookings.push(input);
    if (h.throws) throw h.throws;
    return h.result;
  }),
}));
vi.mock("../../src/services/automationScriptService.js", () => ({
  requestScriptRun: vi.fn(async () => { h.scriptRuns++; }),
}));

import { executeActions } from "../../src/services/automationActionService.js";
import { assertActionRefs } from "../../src/services/notificationRuleService.js";
import { selectTestActions } from "../../src/services/automationTestService.js";
import { assertScriptActionPermission } from "../../src/api/routes/notificationRules.js";
import { actionSchema, escalatableActionSchema, type AutomationAction } from "../../src/services/notificationTypes.js";

const reboot = actionSchema.parse({ type: "reboot", when: "at", at: "03:15", notifyEmails: ["noc@example.com"] }) as AutomationAction;

beforeEach(() => {
  h.bookings = [];
  h.result = { booked: true, scheduleId: "s1", scheduledFor: new Date() };
  h.throws = null;
  h.events = [];
  h.scriptRuns = 0;
});

describe("the reboot action schema", () => {
  it("defaults the time and the gap", () => {
    const a = actionSchema.parse({ type: "reboot", notifyEmails: ["a@b.co"] }) as { when: string; at: string; minGapHours: number };
    expect(a).toMatchObject({ when: "at", at: "02:00", minGapHours: 24 });
  });
  it("needs a real time of day", () => {
    expect(() => actionSchema.parse({ type: "reboot", at: "24:00", notifyEmails: ["a@b.co"] })).toThrow();
  });
  it("takes the notify action's To / Cc / Bcc vocabulary", () => {
    const a = actionSchema.parse({
      type: "reboot", recipientDeviceRegionLevels: [1], recipientUserIds: ["u1"], addresses: ["noc@example.com"],
      cc: { addresses: ["boss@example.com"] }, bcc: { recipientRoles: ["role-1"] },
    }) as Record<string, unknown>;
    expect(a).toMatchObject({ recipientDeviceRegionLevels: [1], cc: { addresses: ["boss@example.com"] }, bcc: { recipientRoles: ["role-1"] } });
    expect(() => actionSchema.parse({ type: "reboot", recipientAllUsers: true })).toThrow();
  });
  it("carries no per-action escalation", () => {
    expect(() => escalatableActionSchema.parse({ type: "reboot", notifyEmails: ["a@b.co"], escalation: { tiers: [] } })).toThrow();
  });
});

describe("executeActions — reboot", () => {
  it("books for the triggering asset and is never run as a script", async () => {
    const out = await executeActions("n1", [reboot], {}, { assetId: "a1", ruleId: "r1", ruleName: "Memory high" });
    expect(out).toEqual({ executed: 1, failed: 0 });
    expect(h.bookings[0]).toMatchObject({ assetId: "a1", when: "at", at: "03:15", notifyEmails: ["noc@example.com"], minGapHours: 24, ruleId: "r1", ruleName: "Memory high", notificationId: "n1" });
    expect(h.scriptRuns).toBe(0);
  });

  it("a skip is neither executed nor failed", async () => {
    h.result = { booked: false, reason: "already booked" };
    expect(await executeActions("n1", [reboot], {}, { assetId: "a1" })).toEqual({ executed: 0, failed: 0 });
  });

  it("a refused gate is an automation.action_error, and later actions still run", async () => {
    h.throws = new Error("the FortiGate is in an HA cluster");
    const out = await executeActions("n1", [reboot, { type: "reboot", when: "now", at: "02:00", notifyEmails: ["x@y.co"], minGapHours: 24 }], {}, { assetId: "a1" });
    expect(out.failed).toBe(2);
    expect(h.bookings).toHaveLength(2);
    expect(h.events[0]).toMatchObject({ action: "automation.action_error" });
    expect(h.events[0].message).toMatch(/\(reboot\) failed: the FortiGate is in an HA cluster/);
  });

  it("resolves To / Cc / Bcc at fire time and books them as addresses", async () => {
    const a = actionSchema.parse({
      type: "reboot", notifyEmails: ["Legacy@Example.com"], addresses: ["noc@example.com"],
      cc: { addresses: ["boss@example.com", "noc@example.com"] }, bcc: { addresses: ["audit@example.com", "boss@example.com"] },
    }) as AutomationAction;
    expect(await executeActions("n1", [a], {}, { assetId: "a1" })).toEqual({ executed: 1, failed: 0 });
    // To wins over Cc, and Bcc never repeats an address already visible.
    expect(h.bookings[0]).toMatchObject({ notifyEmails: ["legacy@example.com", "noc@example.com"], notifyCc: ["boss@example.com"], notifyBcc: ["audit@example.com"] });
  });

  it("a To that resolves to nobody fails the action and books nothing", async () => {
    // The device carries no region tag, so "Asset's L1 Region Users" is empty.
    const a = actionSchema.parse({ type: "reboot", recipientDeviceRegionLevels: [1], cc: { addresses: ["boss@example.com"] } }) as AutomationAction;
    const out = await executeActions("n1", [a], {}, { assetId: "a1", assetRegionTags: [] });
    expect(out).toEqual({ executed: 0, failed: 1 });
    expect(h.bookings).toHaveLength(0);
    expect(h.events[0].message).toMatch(/resolved to no email address/);
  });

  it("an alert with no device fails the action instead of guessing one", async () => {
    const out = await executeActions("n1", [reboot], {}, { assetId: null });
    expect(out.failed).toBe(1);
    expect(h.bookings).toHaveLength(0);
  });
});

describe("assertActionRefs — where a reboot may live", () => {
  it("allows it on the alert's own actions and on an escalation tier", async () => {
    await expect(assertActionRefs({ actions: [reboot] } as never)).resolves.toBeUndefined();
    await expect(assertActionRefs({ actions: [], escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 30, actions: [reboot] }] } } as never)).resolves.toBeUndefined();
  });
  it("refuses one with no To recipient — a Cc-only list has nobody to send to", async () => {
    const noTo = actionSchema.parse({ type: "reboot", cc: { addresses: ["boss@example.com"] } });
    await expect(assertActionRefs({ actions: [noTo] } as never)).rejects.toThrow(/at least one To recipient/);
    const dyn = actionSchema.parse({ type: "reboot", recipientDeviceRegionLevels: [1] });
    await expect(assertActionRefs({ actions: [dyn] } as never)).resolves.toBeUndefined();
  });
  it("refuses it on the reset list", async () => {
    await expect(assertActionRefs({ actions: [], resetActions: [reboot] } as never)).rejects.toThrow(/cannot run when the alert recovers/);
  });
  it("refuses it on a band's resolved list", async () => {
    await expect(assertActionRefs({ actions: [], bandNotify: { resolvedActions: [reboot] } } as never)).rejects.toThrow(/cannot run when the alert recovers/);
  });
});

describe("a Test button never books a reboot", () => {
  it("is skipped with a reason", () => {
    const out = selectTestActions({ actions: [reboot] } as never, { index: 0 } as never, "u1");
    expect(out.actions).toHaveLength(0);
    expect(out.skipped[0]).toMatchObject({ type: "reboot", reason: expect.stringMatching(/never reboots/) });
  });
});

describe("saving a reboot action needs assets:write", () => {
  const req = (assets: string | null) => ({
    roleSnapshot: { permissions: { automationManagement: "write", ...(assets ? { assets } : {}) } },
  });
  it("refuses a saver without it", () => {
    expect(() => assertScriptActionPermission(req("read") as never, { actions: [reboot] } as never)).toThrow(/reboot action requires Read-Write on Assets/);
  });
  it("allows a saver with it", () => {
    expect(() => assertScriptActionPermission(req("write") as never, { actions: [reboot] } as never)).not.toThrow();
  });
  it("is not asked for when the automation has no reboot action", () => {
    expect(() => assertScriptActionPermission(req(null) as never, { actions: [{ type: "event" }] } as never)).not.toThrow();
  });
});
