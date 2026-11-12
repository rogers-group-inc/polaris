/**
 * tests/unit/alertLifecycle.test.ts — src/services/notifications/alertLifecycle.ts (CQ-T010).
 *
 * Complements:
 *   - memoryForecastCountdown.test.ts (forecastCountdownMoved on a live countdown)
 *   - notificationEngine*.test.ts, integration/alertGroup*.test.ts (fire / group
 *     folding end to end)
 * Pinned here directly on the shared db stub:
 *   - TickAlertIndex: one live-alert read per tick, remember(), the subnet
 *     placement cache (most specific subnet, deprecated excluded), and the
 *     group-scope resolve — unconstrained ⇒ null ("governs everything"), and a
 *     failed resolve FALLS BACK to governs-everything with an Event (rule 75);
 *   - liveAlertsByAsset for ungrouped / self-grouped / AlertGroup members
 *     (both `grp:` and `rule:` prefixes collected);
 *   - the clear chokepoint: an ungrouped rule clears with NO count query; a
 *     grouped contribution that is not the last leaves the alert standing
 *     (member_recovered Event), the last one clears it (rule 75);
 *   - recover(): auto clears + auto_cleared Event, manual re-arms without
 *     clearing, timed does nothing (the timer pass owns it);
 *   - handoffDependencyFlavour (rule 78) wording both ways, no reset actions;
 *   - readingFromState, fireReset / fireResolved no-op guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  enqueueAlertActions: vi.fn(async () => undefined),
  groupOwnerOf: vi.fn(async () => null),
  loadScopeAssetIds: vi.fn(),
}));
vi.mock("../../src/services/notifications/alertActions.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enqueueAlertActions: h.enqueueAlertActions,
  groupOwnerOf: h.groupOwnerOf,
}));
vi.mock("../../src/services/notifications/scope.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadScopeAssetIds: h.loadScopeAssetIds,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import type { Trigger } from "../../src/services/notificationTypes.js";
import type { DbRule } from "../../src/services/notifications/ruleModel.js";
import {
  TickAlertIndex,
  liveAlertsByAsset,
  readingFromState,
  stillFiringElsewhere,
  clearAlertRow,
  clearActiveNotification,
  recover,
  handoffDependencyFlavour,
  fireReset,
  fireResolved,
  forecastCountdownMoved,
} from "../../src/services/notifications/alertLifecycle.js";

const IFDOWN = { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" } as unknown as Trigger;
const rule = (o: Record<string, unknown> = {}): DbRule => ({
  id: "r1", name: "Port down", description: null, severity: "warning", trigger: IFDOWN, scope: { allAssets: true },
  reset: { mode: "auto" }, severityBands: null, actions: [], resetActions: [], ...o,
}) as unknown as DbRule;
const GROUPED = () => rule({ groupByAsset: true });
const st = (o: Record<string, unknown> = {}) => ({ id: "s1", ruleId: "r1", dimensionKey: "port1", assetId: "a1", notificationId: "n1", ...o });
const events = (action: string) => eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === action);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.enqueueAlertActions.mockClear();
  h.groupOwnerOf.mockReset().mockResolvedValue(null);
  h.loadScopeAssetIds.mockReset();
});

describe("TickAlertIndex", () => {
  it("reads live grouped alerts once and remembers new ones", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: "n1", groupKey: "rule:r1|a1" }, { id: "n2", groupKey: null },
    ] as never);
    const idx = new TickAlertIndex();
    const first = await idx.keysFor();
    expect([...first]).toEqual([["rule:r1|a1", "n1"]]);
    idx.remember("grp:g|a2", "n9");
    const second = await idx.keysFor();
    expect(second.get("grp:g|a2")).toBe("n9");
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.notification.findMany).mock.calls[0][0]!.where).toEqual({ groupKey: { not: null }, cleared: false });
  });

  it("subnetsOf places each device in its most specific non-deprecated subnet and caches", async () => {
    vi.mocked(prisma.subnet.findMany).mockResolvedValue([
      { id: "s16", name: "Plant", cidr: "10.1.0.0/16" },
      { id: "s24", name: "Plant A", cidr: "10.1.2.0/24" },
    ] as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      { id: "a", ipAddress: "10.1.2.5" }, { id: "b", ipAddress: "10.1.9.9" }, { id: "c", ipAddress: null },
    ] as never);
    const idx = new TickAlertIndex();
    const out = await idx.subnetsOf(["a", "b", "c", "d"]);
    expect(out.get("a")).toEqual({ kind: "subnet", id: "s24", label: "Plant A (10.1.2.0/24)" });
    expect(out.get("b")?.id).toBe("s16");
    expect(out.get("c")).toBeNull();
    expect(out.get("d")).toBeNull();
    expect(vi.mocked(prisma.subnet.findMany).mock.calls[0][0]!.where).toEqual({ status: { not: "deprecated" } });
    await idx.subnetsOf(["a", "b"]);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.subnet.findMany).toHaveBeenCalledTimes(1);
  });

  it("governedAssetIds: no scope or an unconstrained one governs everything (null)", async () => {
    vi.mocked(prisma.alertGroup.findUnique).mockResolvedValueOnce({ scope: null } as never);
    const idx = new TickAlertIndex();
    expect(await idx.governedAssetIds("g1")).toBeNull();
    vi.mocked(prisma.alertGroup.findUnique).mockResolvedValueOnce({ scope: { allAssets: true } } as never);
    expect(await idx.governedAssetIds("g2")).toBeNull();
    expect(h.loadScopeAssetIds).not.toHaveBeenCalled();
  });

  it("governedAssetIds resolves a scoped group once per tick, NOT monitored-only", async () => {
    vi.mocked(prisma.alertGroup.findUnique).mockResolvedValue({ scope: { tags: ["core"] } } as never);
    h.loadScopeAssetIds.mockResolvedValue(["a", "b"]);
    const idx = new TickAlertIndex();
    expect([...(await idx.governedAssetIds("g1"))!]).toEqual(["a", "b"]);
    await idx.governedAssetIds("g1");
    expect(h.loadScopeAssetIds).toHaveBeenCalledTimes(1);
    expect(h.loadScopeAssetIds.mock.calls[0]).toEqual([{ tags: ["core"] }]);
  });

  it("a failed group-scope resolve falls back to governs-everything and says so as an Event", async () => {
    vi.mocked(prisma.alertGroup.findUnique).mockResolvedValue({ scope: { tags: ["core"] } } as never);
    h.loadScopeAssetIds.mockRejectedValue(new Error("boom"));
    const idx = new TickAlertIndex();
    expect(await idx.governedAssetIds("g1")).toBeNull();
    const e = events("notification.engine_error");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ level: "warning", details: { alertGroupId: "g1", err: "boom" } });
  });
});

describe("liveAlertsByAsset", () => {
  const states = [
    { state: "firing", assetId: "a1", notificationId: "n1" },
    { state: "pending", assetId: "a2", notificationId: "n2" },
    { state: "firing", assetId: null, notificationId: "n3" },
  ];
  it("an ungrouped rule joins nothing", async () => {
    expect((await liveAlertsByAsset(rule(), states, null)).size).toBe(0);
  });
  it("a self-grouping rule reads its own firing rows", async () => {
    expect([...(await liveAlertsByAsset(GROUPED(), states, null))]).toEqual([["a1", "n1"]]);
  });
  it("an AlertGroup member reads the tick index under both its grp: and rule: keys", async () => {
    const r = rule({ alertGroupId: "g1" });
    expect((await liveAlertsByAsset(r, states, null)).size).toBe(0); // no index → nothing
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: "nG", groupKey: "grp:g1|a1" }, { id: "nR", groupKey: "rule:r1|a2" }, { id: "nX", groupKey: "rule:other|a3" },
    ] as never);
    const out = await liveAlertsByAsset(r, states, new TickAlertIndex());
    expect([...out].sort()).toEqual([["a1", "nG"], ["a2", "nR"]]);
  });
});

describe("readingFromState", () => {
  it("builds a minimal reading from the state row", () => {
    expect(readingFromState({ assetId: null, dimensionKey: "hc|wan1", lastValue: 42 })).toEqual({
      assetId: "", hostname: null, tags: [], dimKey: "hc|wan1", dimLabel: "hc|wan1", value: 42,
    });
    expect(readingFromState({ assetId: "a", dimensionKey: "" }).value).toBeNull();
  });
});

describe("the clear chokepoint (rule 75)", () => {
  it("stillFiringElsewhere: no query for an ungrouped rule or no notification", async () => {
    expect(await stillFiringElsewhere(st(), rule())).toBe(false);
    expect(await stillFiringElsewhere(st({ notificationId: null }), GROUPED())).toBe(false);
    expect(prisma.notificationRuleState.count).not.toHaveBeenCalled();
  });

  it("stillFiringElsewhere counts OTHER firing rows on the same alert", async () => {
    vi.mocked(prisma.notificationRuleState.count).mockResolvedValue(2 as never);
    expect(await stillFiringElsewhere(st(), GROUPED())).toBe(true);
    expect(vi.mocked(prisma.notificationRuleState.count).mock.calls[0][0]!.where).toEqual({ notificationId: "n1", state: "firing", id: { not: "s1" } });
  });

  it("clearAlertRow soft-clears an uncleared alert, and is a no-op without one", async () => {
    await clearAlertRow({ notificationId: null }, "x");
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    await clearAlertRow({ notificationId: "n1" }, "system:auto-resolve");
    const arg = vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!;
    expect(arg.where).toEqual({ id: "n1", cleared: false });
    expect(arg.data).toMatchObject({ cleared: true, clearedBy: "system:auto-resolve" });
  });

  it("an ungrouped clear asks nothing and clears", async () => {
    await clearActiveNotification(st(), "system:out-of-scope", rule());
    expect(prisma.notificationRuleState.count).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!.data).toMatchObject({ cleared: true, clearedBy: "system:out-of-scope" });
  });

  it("a grouped contribution that is NOT the last leaves the alert standing and logs member_recovered", async () => {
    vi.mocked(prisma.notificationRuleState.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({
      id: "n1",
      members: [
        { ruleId: "r1", key: "port1", label: "port1", severity: "warning", assetId: "a1" },
        { ruleId: "r1", key: "port2", label: "port2", severity: "warning", assetId: "a1" },
      ],
      firstSendDueAt: null, firstSentAt: null, sendIntervalSec: null, pendingChanges: null, templateCtx: null,
    } as never);
    vi.mocked(prisma.notificationRuleState.findMany).mockResolvedValue([] as never);
    await clearActiveNotification(st(), "system:out-of-scope", GROUPED());
    const writes = vi.mocked(prisma.notification.updateMany).mock.calls.map((c) => c[0]!.data as Record<string, unknown>);
    expect(writes.some((d) => d.cleared === true)).toBe(false);
    expect(writes[0]).toMatchObject({ dimensionCount: 1 });
    const e = events("notification.member_recovered");
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("1 still affected");
  });

  it("the LAST grouped contribution keeps the departure in the snapshot and clears the alert", async () => {
    vi.mocked(prisma.notificationRuleState.count).mockResolvedValue(0 as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue({
      id: "n1", members: [{ ruleId: "r1", key: "port1", label: "port1", severity: "warning", assetId: "a1" }],
      firstSendDueAt: null, firstSentAt: null, sendIntervalSec: null, pendingChanges: null, templateCtx: null,
    } as never);
    await clearActiveNotification(st(), "system:out-of-scope", GROUPED());
    const writes = vi.mocked(prisma.notification.updateMany).mock.calls.map((c) => c[0]!.data as Record<string, any>);
    expect(writes[0].dimensionCount).toBe(0);
    expect(writes[0].members[0].leftAt).toBeTruthy();
    expect(writes[1]).toMatchObject({ cleared: true });
    expect(events("notification.member_recovered")).toHaveLength(0);
  });
});

describe("recover", () => {
  const NOW = new Date("2026-04-01T12:00:00Z");

  it("auto: clears the alert, re-arms the row, logs auto_cleared", async () => {
    await recover(rule(), st(), undefined, NOW);
    expect(vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!.data).toMatchObject({ cleared: true, clearedBy: "system:auto-resolve" });
    expect(vi.mocked(prisma.notificationRuleState.update).mock.calls[0][0]).toMatchObject({ where: { id: "s1" }, data: { state: "clear", notificationId: null } });
    expect(events("notification.auto_cleared")[0]).toMatchObject({ resourceId: "n1", details: { assetId: "a1", dimension: "port1" } });
  });

  it("condition recovers exactly like auto", async () => {
    await recover(rule({ reset: { mode: "condition" } }), st(), undefined, NOW);
    expect(events("notification.auto_cleared")).toHaveLength(1);
  });

  it("auto, grouped, not the last: re-arms only this row; the alert stands, no auto_cleared", async () => {
    vi.mocked(prisma.notificationRuleState.count).mockResolvedValue(3 as never);
    vi.mocked(prisma.notification.findFirst).mockResolvedValue(null as never);
    await recover(GROUPED(), st(), undefined, NOW);
    expect(prisma.notificationRuleState.update).toHaveBeenCalledTimes(1);
    const cleared = vi.mocked(prisma.notification.updateMany).mock.calls.some((c) => (c[0]!.data as any).cleared === true);
    expect(cleared).toBe(false);
    expect(events("notification.auto_cleared")).toHaveLength(0);
  });

  it("manual: re-arms the row and leaves the alert for a human", async () => {
    await recover(rule({ reset: { mode: "manual" } }), st(), undefined, NOW);
    expect(prisma.notificationRuleState.update).toHaveBeenCalledTimes(1);
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(events("notification.auto_cleared")).toHaveLength(0);
  });

  it("timed: nothing — the timer pass owns the clear", async () => {
    await recover(rule({ reset: { mode: "timed", afterSec: 60 } }), st(), undefined, NOW);
    expect(prisma.notificationRuleState.update).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });
});

describe("handoffDependencyFlavour (rule 78)", () => {
  it("to dependency-down: clears as system:dependency-down, re-arms, logs superseded naming the upstream", async () => {
    await handoffDependencyFlavour(rule(), st(), true);
    expect(vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!.data).toMatchObject({ clearedBy: "system:dependency-down" });
    expect(vi.mocked(prisma.notificationRuleState.update).mock.calls[0][0]!.data).toMatchObject({ state: "clear", notificationId: null });
    const e = events("notification.superseded")[0];
    expect(e.details).toMatchObject({ reason: "dependency-down", assetId: "a1" });
    expect(e.message).toContain("naming the upstream device");
    expect(h.enqueueAlertActions).not.toHaveBeenCalled();
  });
  it("released: clears as system:dependency-released with the own-outage wording", async () => {
    await handoffDependencyFlavour(rule(), st(), false);
    expect(vi.mocked(prisma.notification.updateMany).mock.calls[0][0]!.data).toMatchObject({ clearedBy: "system:dependency-released" });
    expect(events("notification.superseded")[0].message).toContain("as its own outage");
  });
});

describe("fireReset / fireResolved guards", () => {
  const reading = readingFromState({ assetId: "a1", dimensionKey: "port1" });
  const NOW = new Date("2026-04-01T12:00:00Z");

  it("fireReset does nothing without a notification or without reset actions", async () => {
    await fireReset(rule({ resetActions: [{ type: "notify" }] }), reading, { notificationId: null }, "recovered", NOW);
    await fireReset(rule(), reading, { notificationId: "n1" }, "recovered", NOW);
    expect(h.enqueueAlertActions).not.toHaveBeenCalled();
  });

  it("fireResolved does nothing when the band policy sends no all-clear", async () => {
    await fireResolved(rule(), reading, { id: "s1", notificationId: "n1", firingSeverity: "warning" }, NOW);
    expect(h.enqueueAlertActions).not.toHaveBeenCalled();
  });
});

describe("forecastCountdownMoved — edges", () => {
  const levels = [{ threshold: 90, severity: "serious", operator: ">=" }] as never;
  it("no countdown now (trend not growing) is never 'moved'", () => {
    expect(forecastCountdownMoved(null, { usedPct: 50, slopePerDay: 0, levels }, "serious")).toBe(false);
  });
  it("a snapshot without a stored countdown counts as moved", () => {
    expect(forecastCountdownMoved(null, { usedPct: 80, slopePerDay: 1, levels }, "serious")).toBe(true);
    expect(forecastCountdownMoved({}, { usedPct: 80, slopePerDay: 1, levels }, "serious")).toBe(true);
  });
});
