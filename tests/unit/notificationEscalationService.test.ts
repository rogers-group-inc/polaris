/**
 * tests/unit/notificationEscalationService.test.ts — src/services/notificationEscalationService.ts (CQ-T010).
 *
 * Complements:
 *   - notificationEscalation.test.ts   (tierIsDue basics + buildComposedEmail)
 *   - notificationEscalationV2.test.ts (legacy output parity, v2 tier actions, bands, per-action chains)
 *   - notificationRepeat.test.ts       (repeatIsDue basics + the repeat pass end to end)
 *   - integration/alertGroupFirstSendHold + resetMatchEscalation
 * Those drive the sweep through the real delivery pipeline. Here the
 * collaborators are stubbed at their seams (executeActions, the quiet-hold
 * resolver, the path-maintenance read) so the sweep's own contracts are
 * pinned directly:
 *   - the early exits (no rules / no chains / no candidates / nothing ran),
 *   - the candidate cutoff = min(tier afterMin, repeat everyMin),
 *   - rule 75: an AlertGroup's chain owns a grouped alert,
 *   - rule 135: a path check in maintenance pauses its alerts' follow-ups,
 *   - rule 92: a held send is HELD — no state movement, one reminders_paused
 *     Event per hold (not per sweep), held count grows; a SPLIT hold (rule
 *     120) sends with the hold attached and counts as sent,
 *   - rule 145: escalatedAt is stamped only on the first escalation; the
 *     escalationTier is the top tier reached; repeats of a tier add no Event,
 *   - clocks restart from quietSummarizedAt / firstSentAt when later.
 * Plus tierIsDue / repeatIsDue edge cases the existing suites leave out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  executeActions: vi.fn(),
  resolveQuietHold: vi.fn(),
  primeQuietHoldAssets: vi.fn(async () => undefined),
  pathCheckIdsInMaintenance: vi.fn(async () => new Set<string>()),
}));
vi.mock("../../src/services/automationActionService.js", () => ({ executeActions: h.executeActions }));
vi.mock("../../src/services/quietTimeHoldService.js", () => ({
  resolveQuietHold: h.resolveQuietHold,
  primeQuietHoldAssets: h.primeQuietHoldAssets,
  newQuietHoldMemo: () => ({ holds: new Map(), assets: new Map() }),
}));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ pathCheckIdsInMaintenance: h.pathCheckIdsInMaintenance }));
vi.mock("../../src/services/notificationEngine.js", () => ({
  isSuppressedForNotifications: (a: { status: string; dependencySuppressed: boolean }) =>
    a.status === "maintenance" || a.dependencySuppressed,
}));
vi.mock("../../src/services/notificationRecipientService.js", () => ({ scopeRegionTagsOf: () => [] }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { runEscalationSweep, tierIsDue, repeatIsDue } from "../../src/services/notificationEscalationService.js";

const NOW = new Date("2026-08-25T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const API = { type: "api_call", method: "POST", url: "https://pager.example.com/x", timeoutSec: 15 };
const NOTIFY = { type: "notify", channelId: "ch-email", addresses: ["oncall@example.com"] };

function rule(o: Record<string, unknown> = {}) {
  return {
    id: "r1", name: "cpu rule", description: null, scope: {}, emailComposition: null, severity: "warning",
    escalation: null, targets: [], clearBehavior: "manual", clearAfterSec: null, reset: { mode: "manual" },
    actions: [], severityBands: null, repeat: null, ...o,
  };
}
function notif(o: Record<string, unknown> = {}) {
  return {
    id: "n1", ruleId: "r1", alertGroupId: null, assetId: null, assetHostname: "sw-core-1", severity: "warning",
    message: "cpu hot", triggeredAt: minsAgo(35), acknowledged: false, templateCtx: { asset: "sw-core-1" },
    escalationState: null, escalationFired: null, escalationTier: null, escalatedAt: null, regionTags: [],
    metric: "cpuPct", quietSummarizedAt: null, dimension: null, firstSentAt: null, ...o,
  };
}
const chain = (afterMins: number[], extra: Record<string, unknown> = {}) => ({
  stopOn: "acknowledge",
  tiers: afterMins.map((afterMin) => ({ afterMin, actions: [API], ...extra })),
});

function seed(rules: unknown[], notifs: unknown[], groups: unknown[] = []) {
  vi.mocked(prisma.notificationRule.findMany).mockResolvedValue(rules as never);
  vi.mocked(prisma.alertGroup.findMany).mockResolvedValue(groups as never);
  vi.mocked(prisma.notification.findMany).mockResolvedValue(notifs as never);
  vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
}
const updates = () => vi.mocked(prisma.notification.update).mock.calls.map((c) => c[0] as { where: { id: string }; data: Record<string, any> });

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.executeActions.mockReset();
  h.executeActions.mockResolvedValue({ executed: 1 });
  h.resolveQuietHold.mockReset();
  h.resolveQuietHold.mockResolvedValue(null);
  h.pathCheckIdsInMaintenance.mockReset();
  h.pathCheckIdsInMaintenance.mockResolvedValue(new Set());
});

describe("tierIsDue — edges", () => {
  const T0 = minsAgo(60);
  it("afterMin 0 is due immediately", () => {
    expect(tierIsDue({ afterMin: 0 }, NOW, undefined, NOW)).toBe(true);
  });
  it("repeatEveryMin 0 / null behaves as run-once", () => {
    const st = { firstSentAt: T0.toISOString(), lastSentAt: T0.toISOString(), count: 1 };
    expect(tierIsDue({ afterMin: 0, repeatEveryMin: 0 }, T0, st, NOW)).toBe(false);
    expect(tierIsDue({ afterMin: 0, repeatEveryMin: null }, T0, st, NOW)).toBe(false);
  });
  it("an explicit maxRepeats of 0 is honoured, not replaced by the default 5", () => {
    const st = { firstSentAt: T0.toISOString(), lastSentAt: T0.toISOString(), count: 1 };
    expect(tierIsDue({ afterMin: 0, repeatEveryMin: 1, maxRepeats: 0 }, T0, st, NOW)).toBe(false);
  });
  it("a null maxRepeats falls back to 5", () => {
    const st = (count: number) => ({ firstSentAt: T0.toISOString(), lastSentAt: T0.toISOString(), count });
    expect(tierIsDue({ afterMin: 0, repeatEveryMin: 1, maxRepeats: null }, T0, st(4), NOW)).toBe(true);
    expect(tierIsDue({ afterMin: 0, repeatEveryMin: 1, maxRepeats: null }, T0, st(5), NOW)).toBe(false);
  });
  it("the afterMin gate holds even when state exists", () => {
    const st = { firstSentAt: NOW.toISOString(), lastSentAt: minsAgo(100).toISOString(), count: 1 };
    expect(tierIsDue({ afterMin: 30, repeatEveryMin: 1 }, minsAgo(10), st, NOW)).toBe(false);
  });
});

describe("repeatIsDue — edges", () => {
  it("stopAfterHours 0 is unbounded (falsy)", () => {
    expect(repeatIsDue({ everyMin: 5, stopAfterHours: 0 }, minsAgo(100_000), undefined, NOW)).toBe(true);
  });
  it("the stop cut-off is measured from startAt, inclusive", () => {
    expect(repeatIsDue({ everyMin: 5, stopAfterHours: 1 }, minsAgo(60), undefined, NOW)).toBe(false);
  });
  it("is due exactly at the interval boundary", () => {
    const st = { firstSentAt: minsAgo(30).toISOString(), lastSentAt: minsAgo(15).toISOString(), count: 1 };
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(30), st, NOW)).toBe(true);
    const st2 = { ...st, lastSentAt: new Date(NOW.getTime() - 15 * 60_000 + 1).toISOString() };
    expect(repeatIsDue({ everyMin: 15 }, minsAgo(30), st2, NOW)).toBe(false);
  });
});

describe("runEscalationSweep — early exits", () => {
  it("no enabled rules or groups → 0 without reading notifications", async () => {
    seed([], []);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("a rule with neither a chain nor a repeat is not swept", async () => {
    seed([rule({ actions: [API] })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("the candidate cutoff is the smallest tier delay or repeat interval, across rules", async () => {
    seed([
      rule({ escalation: chain([30, 60]) }),
      rule({ id: "r2", actions: [{ ...NOTIFY, repeat: { everyMin: 10, stopOn: "acknowledge" } }] }),
    ], []);
    await runEscalationSweep(NOW);
    const where = vi.mocked(prisma.notification.findMany).mock.calls[0][0]!.where as Record<string, any>;
    expect(where.triggeredAt).toEqual({ lte: minsAgo(10) });
    expect(where.cleared).toBe(false);
    expect(where.OR[0]).toEqual({ ruleId: { in: ["r1", "r2"] } });
    // A held grouped first send (rule 75) is never a candidate.
    expect(where.NOT).toEqual({ firstSendDueAt: { not: null }, firstSentAt: null });
  });

  it("a due tier whose actions executed nothing writes no state and counts nothing", async () => {
    h.executeActions.mockResolvedValue({ executed: 0 });
    seed([rule({ escalation: chain([30]) })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("a notification whose owner is unknown is skipped", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ ruleId: "gone" })]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(h.executeActions).not.toHaveBeenCalled();
  });
});

describe("runEscalationSweep — tier sends (rule 145)", () => {
  it("first tier send records state, tier, escalatedAt and one notification.escalated Event", async () => {
    seed([rule({ escalation: chain([30]) })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    const [u] = updates();
    expect(u.where.id).toBe("n1");
    expect(u.data.escalationState.tiers["0"]).toEqual({ firstSentAt: NOW.toISOString(), lastSentAt: NOW.toISOString(), count: 1 });
    expect(u.data.escalationTier).toBe(1);
    expect(u.data.escalatedAt).toEqual(NOW);
    const batch = eventLog.logEventsBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ action: "notification.escalated", resourceId: "n1", level: "warning" });
    expect(batch[0].message).toContain("tier 1 on sw-core-1");
    expect(batch[0].message).toContain("(unhandled)");
    // The executeActions call names the tier and attempt.
    expect(h.executeActions.mock.calls[0][3]).toMatchObject({ escalation: { tier: 1, attempt: 1 }, ruleId: "r1" });
  });

  it("two tiers due in one sweep → topTier 2, one Event naming tier 2", async () => {
    seed([rule({ escalation: chain([10, 30]) })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(2);
    expect(updates()[0].data.escalationTier).toBe(2);
    const batch = eventLog.logEventsBatch.mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].details).toMatchObject({ tiers: [1, 2] });
  });

  it("an alert already escalated keeps its escalatedAt (no re-stamp) when a later tier fires", async () => {
    seed([rule({ escalation: chain([10, 30]) })], [notif({
      escalationState: { tiers: { "0": { firstSentAt: minsAgo(20).toISOString(), lastSentAt: minsAgo(20).toISOString(), count: 1 } } },
      escalationFired: [{ severity: "warning", chain: "", tier: 0, at: minsAgo(20).toISOString() }],
      escalationTier: 1,
      escalatedAt: minsAgo(20),
    })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    const [u] = updates();
    expect(u.data.escalationTier).toBe(2);
    expect("escalatedAt" in u.data).toBe(false);
  });

  it("a tier's REPEAT run updates its count but adds no Event and no fired record", async () => {
    seed([rule({ escalation: chain([10], { repeatEveryMin: 5, maxRepeats: 3 }) })], [notif({
      escalationState: { tiers: { "0": { firstSentAt: minsAgo(25).toISOString(), lastSentAt: minsAgo(6).toISOString(), count: 1 } } },
    })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    const [u] = updates();
    expect(u.data.escalationState.tiers["0"].count).toBe(2);
    expect(u.data.escalationState.tiers["0"].firstSentAt).toBe(minsAgo(25).toISOString());
    expect(u.data.escalationFired).toBeUndefined();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("acknowledged: an acknowledge chain stops; the Event wording names a clear chain", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ acknowledged: true })]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    resetDbStub();
    seed([rule({ escalation: { ...chain([30]), stopOn: "clear" } })], [notif({ acknowledged: true })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(eventLog.logEventsBatch.mock.calls[0][0][0].message).toContain("acknowledged; this chain escalates until cleared");
  });
});

describe("runEscalationSweep — clocks", () => {
  it("restarts from quietSummarizedAt when it is later than the fire", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ triggeredAt: minsAgo(120), quietSummarizedAt: minsAgo(10) })]);
    expect(await runEscalationSweep(NOW)).toBe(0);
  });
  it("restarts from a held grouped alert's firstSentAt (rule 75)", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ triggeredAt: minsAgo(120), firstSentAt: minsAgo(29) })]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    resetDbStub();
    seed([rule({ escalation: chain([30]) })], [notif({ triggeredAt: minsAgo(120), firstSentAt: minsAgo(31) })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
  });
  it("an EARLIER quietSummarizedAt does not pull the clock back", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ triggeredAt: minsAgo(35), quietSummarizedAt: minsAgo(200) })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
  });
});

describe("runEscalationSweep — alert groups (rule 75)", () => {
  it("a grouped alert escalates on the GROUP's chain even when its rule has none", async () => {
    const group = { id: "g1", name: "core group", description: null, emailComposition: null, escalation: chain([30]), actions: [], repeat: null };
    seed([], [notif({ alertGroupId: "g1" })], [group]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    const where = vi.mocked(prisma.notification.findMany).mock.calls[0][0]!.where as Record<string, any>;
    expect(where.OR[1]).toEqual({ alertGroupId: { in: ["g1"] } });
    // Provenance stays the automation's id; the name is the group's.
    expect(h.executeActions.mock.calls[0][3]).toMatchObject({ ruleId: "r1", ruleName: "core group" });
  });
});

describe("runEscalationSweep — suppression pauses", () => {
  it("an asset in maintenance pauses its alert", async () => {
    seed([rule({ escalation: chain([30]) })], [notif({ assetId: "a1" })]);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([{ id: "a1", status: "maintenance", dependencySuppressed: false }] as never);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(h.executeActions).not.toHaveBeenCalled();
  });

  it("rule 135: a path check in maintenance pauses its path alerts; the read happens only for path alerts", async () => {
    seed([rule({ escalation: chain([30]) })], [notif()]);
    await runEscalationSweep(NOW);
    expect(h.pathCheckIdsInMaintenance).not.toHaveBeenCalled();

    resetDbStub();
    h.executeActions.mockClear();
    h.pathCheckIdsInMaintenance.mockResolvedValue(new Set(["pc1"]));
    seed([rule({ escalation: chain([30]) })], [
      notif({ id: "held", metric: "pathLatencyMs", dimension: "pc1" }),
      notif({ id: "other", metric: "pathLatencyMs", dimension: "pc2" }),
    ]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(h.executeActions).toHaveBeenCalledTimes(1);
    expect(h.executeActions.mock.calls[0][0]).toBe("other");
  });
});

describe("runEscalationSweep — quiet time (rules 92, 120)", () => {
  const WINDOW_END = new Date("2026-08-25T18:00:00Z");
  const hold = (split = false) => ({ source: "rule", config: {}, windowEnd: WINDOW_END, split, isHeldFor: () => !split });

  it("a held tier does not move its state; the hold is stamped with ONE reminders_paused Event", async () => {
    h.resolveQuietHold.mockResolvedValue(hold());
    seed([rule({ escalation: chain([30]) })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(0);
    expect(h.executeActions).not.toHaveBeenCalled();
    expect(h.resolveQuietHold.mock.calls[0][0]).toMatchObject({ send: "escalation", ruleId: "r1" });
    const [u] = updates();
    expect(u.data.escalationState.tiers).toEqual({});
    expect(u.data.escalationState.quietHeldSince).toBe(NOW.toISOString());
    expect(u.data.escalationState.quietHeldCount).toBe(1);
    const paused = eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === "notification.reminders_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0].message).toContain("next reminder at");
  });

  it("a hold already open only counts up — no second Event", async () => {
    h.resolveQuietHold.mockResolvedValue(hold());
    seed([rule({ escalation: chain([30]) })], [notif({ escalationState: { tiers: {}, quietHeldSince: minsAgo(30).toISOString(), quietHeldCount: 4 } })]);
    await runEscalationSweep(NOW);
    const [u] = updates();
    expect(u.data.escalationState.quietHeldSince).toBe(minsAgo(30).toISOString());
    expect(u.data.escalationState.quietHeldCount).toBe(5);
    expect(eventLog.logEvent.mock.calls.filter((c) => c[0].action === "notification.reminders_paused")).toHaveLength(0);
  });

  it("a tier's repeat run asks for kind escalationReminder", async () => {
    h.resolveQuietHold.mockResolvedValue(hold());
    seed([rule({ escalation: chain([10], { repeatEveryMin: 5 }) })], [notif({
      escalationState: { tiers: { "0": { firstSentAt: minsAgo(25).toISOString(), lastSentAt: minsAgo(6).toISOString(), count: 1 } } },
    })]);
    await runEscalationSweep(NOW);
    expect(h.resolveQuietHold.mock.calls[0][0].send).toBe("escalationReminder");
  });

  it("a SPLIT hold sends with the hold attached and counts as sent", async () => {
    const split = hold(true);
    h.resolveQuietHold.mockResolvedValue(split);
    seed([rule({ escalation: chain([30]) })], [notif()]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    expect(h.executeActions.mock.calls[0][3].quietHold).toBe(split);
    expect(updates()[0].data.escalationState.quietHeldSince).toBeUndefined();
  });

  it("the reminder that ends a hold says so, and clears the stamp", async () => {
    seed([rule({ actions: [{ ...NOTIFY, repeat: { everyMin: 15, stopOn: "acknowledge" } }] })], [notif({
      escalationState: { tiers: {}, quietHeldSince: minsAgo(120).toISOString(), quietHeldCount: 8 },
    })]);
    expect(await runEscalationSweep(NOW)).toBe(1);
    const [, , ctx, opts] = h.executeActions.mock.calls[0];
    expect(ctx["repeat.quiet"]).toContain("Reminders resumed after a quiet period");
    expect(opts.repeat).toMatchObject({ attempt: 1, quietResumed: true });
    const st = updates()[0].data.escalationState;
    expect(st.quietHeldSince).toBeUndefined();
    expect(st.quietHeldCount).toBeUndefined();
    const repeated = eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === "notification.repeated");
    expect(repeated).toHaveLength(1);
  });
});
