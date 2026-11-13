/**
 * tests/unit/eventTail.test.ts — the own suite for
 * src/services/notifications/eventTail.ts (CQ-T010).
 *
 * Complements notificationEventTail.test.ts (cooldown, reset.mode=event and
 * the timed clear driven THROUGH evaluateAllNotificationRules with a
 * hand-rolled prisma) and notificationEventTimeSuppression.test.ts by calling
 * the module's exports directly against the shared stub, so each branch is
 * pinned on its own:
 *   - globToRegExp: anchored, case-blind, `*` only (business rule 116);
 *   - suppressedAtEventTime: the INCLUSIVE window bounds (rule 80a);
 *   - runEventRuleTimedClear: which rules it sweeps, the cutoff, reset actions
 *     per alert, the notification.auto_cleared Event;
 *   - runEventTail: the cursor (stored / default lookback / advanced past a
 *     skipped event), the trigger filters (resourceType, minLevel,
 *     detailsMatch, change types), rule 106's email_sent exclusion, the
 *     device-filter gate (rule 46), the trigger gate and the event-time
 *     maintenance gate, cooldown, the subject label, actions + chart keys +
 *     templateCtx on the created row, the batch's one asset prime, and the
 *     event reset (same subject, fire-beats-reset, dedupe, a failing reset
 *     logged without losing the cursor);
 *   - applyLinkedForecastLevels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  fireReset: vi.fn(),
  decorate: vi.fn(),
  scopeMatch: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/notifications/alertActions.js", () => ({ executeActionsSafe: h.execute }));
vi.mock("../../src/services/notifications/alertLifecycle.js", () => ({ fireReset: h.fireReset }));
vi.mock("../../src/services/scopeRelationIndex.js", () => ({ decorateRelationLeafHits: h.decorate }));
vi.mock("../../src/services/notificationRuleService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  scopeMatchesAsset: h.scopeMatch,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { _assetDetailCache } from "../../src/services/notifications/assetDetail.js";
import type { DbRule } from "../../src/services/notifications/ruleModel.js";
import {
  globToRegExp,
  suppressedAtEventTime,
  runEventRuleTimedClear,
  runEventTail,
  applyLinkedForecastLevels,
  type MaintenanceSpan,
} from "../../src/services/notifications/eventTail.js";

const CURSOR_KEY = "notificationEngine.lastEventCursor";
const T0 = new Date("2026-11-13T10:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function dbRule(over: Partial<DbRule> & Record<string, unknown> = {}): DbRule {
  return {
    id: "r1", name: "Agent gone", description: null, severity: "serious",
    trigger: { type: "event", actionPattern: "agent.disconnected" } as never,
    scope: {} as never, reset: { mode: "manual" } as never, actions: [], cooldownSec: null,
    messageTemplate: null, emailComposition: null, escalation: null, severityBands: null,
    bandNotify: null, resetActions: null, repeat: null, groupByAsset: false, alertGroupId: null,
    ...over,
  } as DbRule;
}

type Ev = {
  timestamp: Date; level: string; action: string; resourceType: string; resourceId: string | null;
  resourceName: string | null; actor: string | null; message: string; details: unknown;
};

function ev(over: Partial<Ev> = {}): Ev {
  return {
    timestamp: at(0), level: "warning", action: "agent.disconnected", resourceType: "asset", resourceId: "a1",
    resourceName: "SRV-1", actor: "system", message: "Agent disconnected", details: null, ...over,
  };
}

function asset(id: string, over: Record<string, unknown> = {}) {
  return { id, hostname: `host-${id}`, status: "active", monitored: true, dependencySuppressed: false, tags: [], ...over };
}

let assets: ReturnType<typeof asset>[] = [];
let windows: { assetId: string; startedAt: Date; endedAt: Date | null }[] = [];

const settingFind = stubbed(prisma.setting.findUnique);
const settingUpsert = stubbed(prisma.setting.upsert);
const eventFind = stubbed(prisma.event.findMany);
const notifFind = stubbed(prisma.notification.findMany);
const notifCreate = stubbed(prisma.notification.createMany);
const notifUpdate = stubbed(prisma.notification.updateMany);
const assetFind = stubbed(prisma.asset.findMany);
const assetFindUnique = stubbed(prisma.asset.findUnique);
const windowFind = stubbed(prisma.assetMaintenanceWindow.findMany);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  _assetDetailCache.clear();
  h.execute.mockReset().mockResolvedValue(undefined);
  h.fireReset.mockReset().mockResolvedValue(undefined);
  h.decorate.mockReset().mockResolvedValue(undefined);
  h.scopeMatch.mockReset().mockReturnValue(true);
  assets = [];
  windows = [];
  settingFind.mockResolvedValue({ key: CURSOR_KEY, value: { lastTimestamp: at(-60).toISOString() } });
  settingUpsert.mockResolvedValue({});
  eventFind.mockResolvedValue([]);
  notifFind.mockResolvedValue([]);
  notifCreate.mockResolvedValue({ count: 0 });
  notifUpdate.mockResolvedValue({ count: 0 });
  assetFind.mockImplementation(async ({ where }: any) => assets.filter((a) => where.id.in.includes(a.id)));
  assetFindUnique.mockImplementation(async ({ where }: any) => assets.find((a) => a.id === where.id) ?? null);
  windowFind.mockImplementation(async ({ where }: any) => windows.filter((w) => where.assetId.in.includes(w.assetId)));
});

afterEach(() => {
  vi.useRealTimers();
});

const created = () => notifCreate.mock.calls.flatMap((c) => c[0].data as Record<string, unknown>[]);
const events = (action: string) => eventLog.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.action === action);

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("globToRegExp (rule 116)", () => {
  it("is anchored at both ends", () => {
    const m = globToRegExp("agent.connected");
    expect(m.test("agent.connected")).toBe(true);
    expect(m.test("xagent.connected")).toBe(false);
    expect(m.test("agent.connected.x")).toBe(false);
  });

  it("treats `*` as any run, including none", () => {
    const m = globToRegExp("agent.*");
    expect(m.test("agent.")).toBe(true);
    expect(m.test("agent.upgrade_failed")).toBe(true);
    expect(m.test("integration.agent.x")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(globToRegExp("Agent.*").test("AGENT.CONNECTED")).toBe(true);
  });

  it("matches `?` and `.` literally", () => {
    expect(globToRegExp("a?b").test("a?b")).toBe(true);
    expect(globToRegExp("a?b").test("axb")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("collapses a run of stars rather than backtracking on it", () => {
    const m = globToRegExp(`${"*".repeat(40)}x`);
    expect(m.test(`${"a".repeat(5000)}y`)).toBe(false);
    expect(m.test("ax")).toBe(true);
  });
});

describe("suppressedAtEventTime (rule 80a)", () => {
  const spans = new Map<string, MaintenanceSpan[]>([
    ["a1", [{ startedAt: at(0), endedAt: at(2) }]],
    ["a2", [{ startedAt: at(10), endedAt: null }]],
    ["a3", []],
  ]);

  it("is never suppressed for an event that names no asset", () => {
    expect(suppressedAtEventTime(spans, null, at(1))).toBe(false);
  });

  it("is not suppressed for an asset with no windows", () => {
    expect(suppressedAtEventTime(spans, "zz", at(1))).toBe(false);
    expect(suppressedAtEventTime(spans, "a3", at(1))).toBe(false);
  });

  it("includes both the opening and the closing millisecond", () => {
    expect(suppressedAtEventTime(spans, "a1", at(0))).toBe(true);
    expect(suppressedAtEventTime(spans, "a1", at(2))).toBe(true);
  });

  it("grants no grace either side of the window", () => {
    expect(suppressedAtEventTime(spans, "a1", new Date(at(0).getTime() - 1))).toBe(false);
    expect(suppressedAtEventTime(spans, "a1", new Date(at(2).getTime() + 1))).toBe(false);
  });

  it("treats an open window as running to now and beyond", () => {
    expect(suppressedAtEventTime(spans, "a2", at(9))).toBe(false);
    expect(suppressedAtEventTime(spans, "a2", at(100000))).toBe(true);
  });

  it("is suppressed when any of several windows covers the instant", () => {
    const multi = new Map<string, MaintenanceSpan[]>([["a1", [{ startedAt: at(0), endedAt: at(1) }, { startedAt: at(5), endedAt: at(6) }]]]);
    expect(suppressedAtEventTime(multi, "a1", at(3))).toBe(false);
    expect(suppressedAtEventTime(multi, "a1", at(5))).toBe(true);
  });
});

// ─── runEventRuleTimedClear ────────────────────────────────────────────────

describe("runEventRuleTimedClear", () => {
  const timed = (over: Record<string, unknown> = {}) => dbRule({ reset: { mode: "timed", afterSec: 3600 } as never, ...over });

  it("sweeps only event/change rules on a timed reset with a delay", async () => {
    const rules = [
      timed({ id: "ev" }),
      timed({ id: "chg", trigger: { type: "change", changeType: "lldp_neighbor_removed" } as never }),
      timed({ id: "metric", trigger: { type: "asset_metric", metric: "cpuPct" } as never }),
      dbRule({ id: "manual" }),
      timed({ id: "nodelay", reset: { mode: "timed", afterSec: null } as never }),
    ];
    await runEventRuleTimedClear(rules, T0);
    expect(notifUpdate.mock.calls.map((c) => c[0].where.ruleId)).toEqual(["ev", "chg"]);
  });

  it("clears uncleared alerts triggered at or before now − afterSec", async () => {
    await runEventRuleTimedClear([timed()], T0);
    expect(notifUpdate).toHaveBeenCalledWith({
      where: { ruleId: "r1", cleared: false, triggeredAt: { lte: at(-3600) } },
      data: { cleared: true, clearedBy: "system:timed", clearedAt: T0 },
    });
  });

  it("returns the total cleared and writes one auto_cleared Event per rule that cleared any", async () => {
    notifUpdate.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 0 });
    const n = await runEventRuleTimedClear([timed({ id: "a", name: "A" }), timed({ id: "b", name: "B" })], T0);
    expect(n).toBe(2);
    expect(events("notification.auto_cleared")).toEqual([
      expect.objectContaining({
        resourceType: "notification", resourceName: "A", actor: "system:notification-engine",
        message: 'Timed reset: cleared 2 alert(s) of "A" older than 3600s',
        details: { ruleId: "a", count: 2, afterSec: 3600 },
      }),
    ]);
  });

  it("reads nothing back when the rule has no reset actions", async () => {
    await runEventRuleTimedClear([timed()], T0);
    expect(notifFind).not.toHaveBeenCalled();
    expect(h.fireReset).not.toHaveBeenCalled();
  });

  it("runs the reset actions once per doomed alert, before clearing", async () => {
    const order: string[] = [];
    notifFind.mockResolvedValue([{ id: "n1", assetId: "a1", assetHostname: "h1" }, { id: "n2", assetId: null, assetHostname: "FMG" }]);
    h.fireReset.mockImplementation(async () => { order.push("reset"); });
    notifUpdate.mockImplementation(async () => { order.push("clear"); return { count: 2 }; });
    const rule = timed({ resetActions: [{ type: "event" }] as never });
    await runEventRuleTimedClear([rule], T0);
    expect(notifFind.mock.calls[0]![0]).toMatchObject({ where: { ruleId: "r1", cleared: false, triggeredAt: { lte: at(-3600) } }, take: 500 });
    expect(h.fireReset).toHaveBeenCalledTimes(2);
    expect(h.fireReset.mock.calls[1]).toEqual([
      rule, { assetId: "", hostname: "FMG", tags: [], dimKey: "", dimLabel: "", value: null }, { notificationId: "n2" }, "alert timed out", T0,
    ]);
    expect(order).toEqual(["reset", "reset", "clear"]);
  });

  it("swallows a failing audit write", async () => {
    notifUpdate.mockResolvedValue({ count: 1 });
    eventLog.logEvent.mockRejectedValue(new Error("db"));
    await expect(runEventRuleTimedClear([timed()], T0)).resolves.toBe(1);
  });
});

// ─── runEventTail ──────────────────────────────────────────────────────────

describe("runEventTail — the cursor", () => {
  it("reads nothing when no rule is an event or change rule", async () => {
    await runEventTail([dbRule({ trigger: { type: "asset_metric", metric: "cpuPct" } as never })]);
    expect(settingFind).not.toHaveBeenCalled();
    expect(eventFind).not.toHaveBeenCalled();
  });

  it("reads past the stored cursor, oldest first, a thousand at a time", async () => {
    await runEventTail([dbRule()]);
    const q = eventFind.mock.calls[0]![0];
    expect(q.where).toEqual({ timestamp: { gt: at(-60) } });
    expect(q.orderBy).toEqual({ timestamp: "asc" });
    expect(q.take).toBe(1000);
  });

  it("looks back 15 minutes when no cursor is stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    settingFind.mockResolvedValue(null);
    await runEventTail([dbRule()]);
    expect(eventFind.mock.calls[0]![0].where.timestamp.gt).toEqual(at(-900));
  });

  it("leaves the cursor alone when there was nothing new", async () => {
    await runEventTail([dbRule()]);
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it("advances the cursor to the newest event, matched or not", async () => {
    eventFind.mockResolvedValue([ev({ action: "unrelated.a", timestamp: at(1) }), ev({ action: "unrelated.b", timestamp: at(5) })]);
    await runEventTail([dbRule()]);
    expect(settingUpsert).toHaveBeenCalledWith({
      where: { key: CURSOR_KEY },
      create: { key: CURSOR_KEY, value: { lastTimestamp: at(5).toISOString() } },
      update: { value: { lastTimestamp: at(5).toISOString() } },
    });
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("never fires on the alert-email record, but still moves past it (rule 106)", async () => {
    eventFind.mockResolvedValue([ev({ action: "notification.email_sent", resourceType: "notification", resourceId: "n1", timestamp: at(3) })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "*" } as never })]);
    expect(notifCreate).not.toHaveBeenCalled();
    expect(settingUpsert.mock.calls[0]![0].update.value.lastTimestamp).toBe(at(3).toISOString());
  });
});

describe("runEventTail — firing", () => {
  it("raises one alert per matching event, about the asset it names", async () => {
    assets = [asset("a1", { tags: ["region:Atlanta", "core"] })];
    eventFind.mockResolvedValue([ev()]);
    await runEventTail([dbRule()]);
    expect(created()).toEqual([
      expect.objectContaining({ ruleId: "r1", assetId: "a1", assetHostname: "SRV-1", severity: "serious", message: "Agent gone: Agent disconnected", regionTags: ["Atlanta"] }),
    ]);
    expect(created()[0]).not.toHaveProperty("id");
    expect(created()[0]).not.toHaveProperty("templateCtx");
    expect(created()[0]).not.toHaveProperty("metric");
  });

  it("primes the batch's distinct assets in one read and never point-reads them", async () => {
    assets = [asset("a1"), asset("a2")];
    eventFind.mockResolvedValue([ev(), ev({ resourceId: "a2" }), ev({ timestamp: at(1) }), ev({ resourceType: "integration", resourceId: "i1" })]);
    await runEventTail([dbRule()]);
    expect(assetFind).toHaveBeenCalledTimes(1);
    expect(assetFind.mock.calls[0]![0].where.id.in.sort()).toEqual(["a1", "a2"]);
    expect(assetFindUnique).not.toHaveBeenCalled();
  });

  it("files an event that names no asset under its resource label", async () => {
    eventFind.mockResolvedValue([ev({ action: "integration.discover.error", resourceType: "integration", resourceId: "i1", resourceName: "FMG-1" })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "integration.discover.error" } as never })]);
    expect(created()[0]).toMatchObject({ assetId: null, assetHostname: "FMG-1" });
  });

  it("names a system-scoped event after the Polaris server itself", async () => {
    eventFind.mockResolvedValue([ev({ action: "backup.failed", resourceType: "system", resourceId: null, resourceName: null })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "backup.*" } as never })]);
    expect(created()[0]!.assetHostname).toBe("Polaris server");
  });

  it("stores a null subject when nothing names one", async () => {
    eventFind.mockResolvedValue([ev({ action: "x.y", resourceType: "user", resourceId: null, resourceName: "  " })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "x.y" } as never })]);
    expect(created()[0]!.assetHostname).toBeNull();
  });

  it("renders the rule's message template instead of the default", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev()]);
    await runEventTail([dbRule({ messageTemplate: "{asset} said {value}" })]);
    expect(created()[0]!.message).toBe("SRV-1 said Agent disconnected");
  });

  it("falls back to the default for a whitespace-only template", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev()]);
    await runEventTail([dbRule({ messageTemplate: "   " })]);
    expect(created()[0]!.message).toBe("Agent gone: Agent disconnected");
  });

  it("narrows by resource type", async () => {
    eventFind.mockResolvedValue([ev({ resourceType: "integration", resourceId: "i1" })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "agent.*", resourceType: "asset" } as never })]);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("fires only at or above the minimum level", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev({ level: "info" }), ev({ level: "warning", timestamp: at(1) }), ev({ level: "error", timestamp: at(2) })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "agent.*", minLevel: "warning" } as never })]);
    expect(created()).toHaveLength(2);
  });

  it("requires every details key to match, compared as strings", async () => {
    eventFind.mockResolvedValue([
      ev({ resourceType: "integration", resourceId: "i1", details: { code: 5, mode: "full" } }),
      ev({ resourceType: "integration", resourceId: "i1", details: { code: 5, mode: "fast" }, timestamp: at(1) }),
      ev({ resourceType: "integration", resourceId: "i1", details: null, timestamp: at(2) }),
    ]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "agent.*", detailsMatch: { code: "5", mode: "full" } } as never })]);
    expect(created()).toHaveLength(1);
  });

  it("fires a change trigger on its change type's action", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev({ action: "change.lldp.neighbor_removed" }), ev({ action: "change.lldp.neighbor_added", timestamp: at(1) })]);
    await runEventTail([dbRule({ trigger: { type: "change", changeType: "lldp_neighbor_removed" } as never })]);
    expect(created()).toHaveLength(1);
  });

  it("stamps the SD-WAN chart keys on a failover alert", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev({ action: "change.sdwan.failover", details: { ruleName: "Internet", from: "wan1" } })]);
    await runEventTail([dbRule({ trigger: { type: "change", changeType: "sdwan_failover" } as never })]);
    expect(created()[0]).toMatchObject({ metric: "sdwanSelectedMember", dimension: "Internet|wan1" });
  });

  it("snapshots the template context when the rule composes its own email", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev()]);
    await runEventTail([dbRule({ emailComposition: { subjectTemplate: "{asset}" } })]);
    const ctx = created()[0]!.templateCtx as Record<string, string>;
    expect(ctx.message).toBe("Agent gone: Agent disconnected");
  });

  it("gives an alert with actions a client id and runs its actions after the insert", async () => {
    assets = [asset("a1", { tags: ["region:Atlanta"] })];
    eventFind.mockResolvedValue([ev()]);
    const order: string[] = [];
    notifCreate.mockImplementation(async () => { order.push("insert"); return { count: 1 }; });
    h.execute.mockImplementation(async () => { order.push("actions"); });
    const actions = [{ type: "notify", channelId: "c1" }];
    await runEventTail([dbRule({ actions: actions as never, scope: { tags: ["region:Atlanta"] } as never })]);
    const row = created()[0]!;
    expect(typeof row.id).toBe("string");
    expect(order).toEqual(["insert", "actions"]);
    const [id, acts, ctx, opts] = h.execute.mock.calls[0]!;
    expect(id).toBe(row.id);
    expect(acts).toBe(actions);
    expect(ctx.message).toBe("Agent gone: Agent disconnected");
    expect(opts).toMatchObject({ assetId: "a1", ruleId: "r1", ruleName: "Agent gone", assetRegionTags: ["Atlanta"], actor: "system:notification-engine" });
  });
});

describe("runEventTail — gates", () => {
  it("does not fire about an unmonitored asset", async () => {
    assets = [asset("a1", { monitored: false })];
    eventFind.mockResolvedValue([ev()]);
    await runEventTail([dbRule()]);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("does not fire about an asset in maintenance or dependency-suppressed now", async () => {
    assets = [asset("a1", { status: "maintenance" }), asset("a2", { dependencySuppressed: true })];
    eventFind.mockResolvedValue([ev(), ev({ resourceId: "a2" })]);
    await runEventTail([dbRule()]);
    expect(notifCreate).not.toHaveBeenCalled();
  });

  it("still fires when the asset row is gone — a deletion must stay audible", async () => {
    eventFind.mockResolvedValue([ev({ action: "asset.deleted", resourceId: "gone" })]);
    await runEventTail([dbRule({ trigger: { type: "event", actionPattern: "asset.deleted" } as never })]);
    expect(created()[0]).toMatchObject({ assetId: "gone" });
  });

  it("suppresses an event written inside a window that has since closed (rule 80a)", async () => {
    assets = [asset("a1")];
    windows = [{ assetId: "a1", startedAt: at(-2), endedAt: at(0) }];
    eventFind.mockResolvedValue([ev({ timestamp: at(0) }), ev({ timestamp: at(1) })]);
    await runEventTail([dbRule()]);
    expect(created()).toHaveLength(1);
    expect(windowFind.mock.calls[0]![0].where).toEqual({
      assetId: { in: ["a1"] },
      startedAt: { lte: at(1) },
      OR: [{ endedAt: null }, { endedAt: { gte: at(0) } }],
    });
  });

  it("asks for no windows when the batch names no asset", async () => {
    eventFind.mockResolvedValue([ev({ resourceType: "integration", resourceId: "i1" })]);
    await runEventTail([dbRule()]);
    expect(windowFind).not.toHaveBeenCalled();
    expect(assetFind).not.toHaveBeenCalled();
  });

  describe("device filter (rule 46)", () => {
    const scoped = (over: Record<string, unknown> = {}) => dbRule({ scope: { tags: ["core"] } as never, ...over });

    it("does not match an event that names no asset", async () => {
      eventFind.mockResolvedValue([ev({ resourceType: "integration", resourceId: "i1" })]);
      await runEventTail([scoped()]);
      expect(notifCreate).not.toHaveBeenCalled();
    });

    it("does not match an asset the filter does not select", async () => {
      assets = [asset("a1")];
      h.scopeMatch.mockReturnValue(false);
      eventFind.mockResolvedValue([ev()]);
      await runEventTail([scoped()]);
      expect(notifCreate).not.toHaveBeenCalled();
      expect(h.scopeMatch.mock.calls[0]![0]).toEqual({ tags: ["core"] });
      expect(h.scopeMatch.mock.calls[0]![1]).toMatchObject({ id: "a1" });
    });

    it("does not match a deleted asset — nothing is left to test the filter against", async () => {
      eventFind.mockResolvedValue([ev({ resourceId: "gone" })]);
      await runEventTail([scoped()]);
      expect(notifCreate).not.toHaveBeenCalled();
    });

    it("fires on a selected asset, resolving relation leaves for the batch once", async () => {
      assets = [asset("a1")];
      eventFind.mockResolvedValue([ev()]);
      await runEventTail([scoped()]);
      expect(created()).toHaveLength(1);
      expect(h.decorate).toHaveBeenCalledTimes(1);
      expect(h.decorate.mock.calls[0]![0].map((r: { id: string }) => r.id)).toEqual(["a1"]);
    });

    it("never consults the filter for an unconstrained scope", async () => {
      assets = [asset("a1")];
      eventFind.mockResolvedValue([ev()]);
      await runEventTail([dbRule({ scope: { allAssets: true } as never })]);
      expect(h.scopeMatch).not.toHaveBeenCalled();
      expect(h.decorate).not.toHaveBeenCalled();
      expect(created()).toHaveLength(1);
    });

    it("lets includeServer decide a server-side path change", async () => {
      const pathEv = ev({ action: "path_check.path_changed", resourceType: "path-check", resourceId: "pc1", resourceName: "To DC" });
      eventFind.mockResolvedValue([pathEv]);
      await runEventTail([scoped({ trigger: { type: "change", changeType: "path_check_path_changed", includeServer: true } as never })]);
      expect(created()).toHaveLength(1);
      notifCreate.mockClear();
      await runEventTail([dbRule({ trigger: { type: "change", changeType: "path_check_path_changed", includeServer: false } as never })]);
      expect(notifCreate).not.toHaveBeenCalled();
    });
  });

  describe("cooldown", () => {
    it("skips a subject that fired inside the window, from the recent alerts", async () => {
      assets = [asset("a1")];
      notifFind.mockResolvedValue([{ ruleId: "r1", assetId: "a1", assetHostname: "SRV-1", triggeredAt: at(-30) }]);
      eventFind.mockResolvedValue([ev()]);
      await runEventTail([dbRule({ cooldownSec: 60 })]);
      expect(notifCreate).not.toHaveBeenCalled();
    });

    it("fires once the window has passed", async () => {
      assets = [asset("a1")];
      notifFind.mockResolvedValue([{ ruleId: "r1", assetId: "a1", assetHostname: "SRV-1", triggeredAt: at(-61) }]);
      eventFind.mockResolvedValue([ev()]);
      await runEventTail([dbRule({ cooldownSec: 60 })]);
      expect(created()).toHaveLength(1);
    });

    it("dedupes inside one batch, per subject", async () => {
      eventFind.mockResolvedValue([
        ev({ resourceType: "integration", resourceId: "i1", resourceName: "FMG-1", timestamp: at(0) }),
        ev({ resourceType: "integration", resourceId: "i1", resourceName: "FMG-1", timestamp: at(10) }),
        ev({ resourceType: "integration", resourceId: "i2", resourceName: "FMG-2", timestamp: at(20) }),
        ev({ resourceType: "integration", resourceId: "i1", resourceName: "FMG-1", timestamp: at(90) }),
      ]);
      await runEventTail([dbRule({ cooldownSec: 60 })]);
      expect(created().map((r) => r.assetHostname)).toEqual(["FMG-1", "FMG-2", "FMG-1"]);
    });

    it("reads recent alerts once, over the longest cooldown, and not at all without one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T0);
      eventFind.mockResolvedValue([ev({ resourceType: "integration", resourceId: "i1" })]);
      await runEventTail([dbRule({ id: "a", cooldownSec: 60 }), dbRule({ id: "b", cooldownSec: 600 }), dbRule({ id: "c" })]);
      expect(notifFind).toHaveBeenCalledTimes(1);
      expect(notifFind.mock.calls[0]![0].where).toEqual({ ruleId: { in: ["a", "b"] }, triggeredAt: { gte: at(-600) } });
      notifFind.mockClear();
      await runEventTail([dbRule({ id: "c" })]);
      expect(notifFind).not.toHaveBeenCalled();
    });
  });
});

describe("runEventTail — event reset", () => {
  const resetting = (over: Record<string, unknown> = {}) => dbRule({
    reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } } as never, ...over,
  });

  it("clears the same asset's alerts raised at or before the clearing event", async () => {
    eventFind.mockResolvedValue([ev({ action: "agent.connected", timestamp: at(5) })]);
    notifUpdate.mockResolvedValue({ count: 1 });
    await runEventTail([resetting()]);
    const call = notifUpdate.mock.calls[0]![0];
    expect(call.where).toEqual({ ruleId: "r1", cleared: false, triggeredAt: { lte: at(5) }, assetId: "a1" });
    expect(call.data).toMatchObject({ cleared: true, clearedBy: "system:event-reset" });
    expect(events("notification.auto_cleared")[0]).toMatchObject({
      message: 'Event reset: cleared 1 alert(s) of "Agent gone" — agent.connected occurred for SRV-1',
      details: { ruleId: "r1", count: 1, resetPattern: "agent.connected" },
    });
  });

  it("keys a non-asset subject on its stored label", async () => {
    eventFind.mockResolvedValue([ev({ action: "agent.connected", resourceType: "integration", resourceId: "i1", resourceName: "FMG-1" })]);
    await runEventTail([resetting()]);
    expect(notifUpdate.mock.calls[0]![0].where).toMatchObject({ assetId: null, assetHostname: "FMG-1" });
  });

  it("honours the reset event's resource type narrowing", async () => {
    eventFind.mockResolvedValue([ev({ action: "agent.connected", resourceType: "integration", resourceId: "i1" })]);
    await runEventTail([resetting({ reset: { mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: "asset" } } })]);
    expect(notifUpdate).not.toHaveBeenCalled();
  });

  it("writes no Event when nothing was cleared", async () => {
    eventFind.mockResolvedValue([ev({ action: "agent.connected" })]);
    await runEventTail([resetting()]);
    expect(events("notification.auto_cleared")).toEqual([]);
  });

  it("never clears with the same event that fired the rule", async () => {
    assets = [asset("a1")];
    eventFind.mockResolvedValue([ev({ action: "agent.flap" })]);
    await runEventTail([resetting({
      trigger: { type: "event", actionPattern: "agent.*" },
      reset: { mode: "event", resetEvent: { actionPattern: "agent.*" } },
    })]);
    expect(created()).toHaveLength(1);
    expect(notifUpdate).not.toHaveBeenCalled();
  });

  it("raises the alert BEFORE a later event in the batch clears it", async () => {
    assets = [asset("a1")];
    const order: string[] = [];
    notifCreate.mockImplementation(async () => { order.push("create"); return { count: 1 }; });
    notifUpdate.mockImplementation(async () => { order.push("clear"); return { count: 1 }; });
    eventFind.mockResolvedValue([ev({ timestamp: at(0) }), ev({ action: "agent.connected", timestamp: at(1) })]);
    await runEventTail([resetting()]);
    expect(order).toEqual(["create", "clear"]);
  });

  it("dedupes to the LAST clearing event per subject", async () => {
    eventFind.mockResolvedValue([
      ev({ action: "agent.connected", timestamp: at(1) }),
      ev({ action: "agent.connected", timestamp: at(3) }),
      ev({ action: "agent.connected", resourceId: "a2", resourceName: "SRV-2", timestamp: at(2) }),
    ]);
    await runEventTail([resetting()]);
    expect(notifUpdate.mock.calls.map((c) => [c[0].where.assetId, c[0].where.triggeredAt.lte])).toEqual([["a1", at(3)], ["a2", at(2)]]);
  });

  it("runs reset actions per alert it closes, as a recovery", async () => {
    notifFind.mockResolvedValue([{ id: "n1", assetId: "a1", assetHostname: "SRV-1" }]);
    eventFind.mockResolvedValue([ev({ action: "agent.connected", timestamp: at(5) })]);
    const rule = resetting({ resetActions: [{ type: "event" }] });
    await runEventTail([rule]);
    expect(h.fireReset).toHaveBeenCalledWith(
      rule, { assetId: "a1", hostname: "SRV-1", tags: [], dimKey: "", dimLabel: "", value: null }, { notificationId: "n1" }, "recovered", at(5),
    );
  });

  it("logs a failing reset as an engine error and still advances the cursor", async () => {
    eventFind.mockResolvedValue([ev({ action: "agent.connected", timestamp: at(7) })]);
    notifUpdate.mockRejectedValue(new Error("deadlock"));
    await runEventTail([resetting()]);
    expect(events("notification.engine_error")).toEqual([
      expect.objectContaining({ level: "error", message: 'Event reset for "Agent gone" failed', details: { ruleId: "r1", err: "deadlock" } }),
    ]);
    expect(settingUpsert.mock.calls[0]![0].update.value.lastTimestamp).toBe(at(7).toISOString());
  });
});

// ─── applyLinkedForecastLevels ─────────────────────────────────────────────

describe("applyLinkedForecastLevels", () => {
  const forecast = (levelsFromRuleId?: string) => ({
    trigger: { type: "asset_metric", metric: "memForecastPct", operator: ">=", threshold: 50, levelsFromRuleId } as never,
    severity: "info",
    severityBands: null,
  });

  it("asks nothing when no forecast links its levels", async () => {
    const rules = [forecast(), { trigger: { type: "asset_metric", metric: "cpuPct" } as never, severity: "info", severityBands: null }];
    await applyLinkedForecastLevels(rules);
    expect(stubbed(prisma.notificationRule.findMany)).not.toHaveBeenCalled();
  });

  it("takes the linked automation's threshold, severity and bands, in one read", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([{
      id: "mem", trigger: { type: "asset_metric", metric: "memPct", operator: ">", threshold: 85 }, severity: "warning",
      severityBands: [{ threshold: 95, severity: "critical", actions: [] }],
    }]);
    const a = forecast("mem");
    const b = forecast("mem");
    await applyLinkedForecastLevels([a, b]);
    expect(stubbed(prisma.notificationRule.findMany)).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.notificationRule.findMany).mock.calls[0]![0].where).toEqual({ id: { in: ["mem"] } });
    for (const r of [a, b]) {
      expect(r.trigger).toMatchObject({ operator: ">", threshold: 85, metric: "memForecastPct" });
      expect(r.severity).toBe("warning");
      expect(r.severityBands).toEqual([{ threshold: 95, severity: "critical", actions: [] }]);
    }
  });

  it("keeps the forecast's own levels when the source is gone", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([]);
    const a = forecast("deleted");
    await applyLinkedForecastLevels([a]);
    expect(a.trigger).toMatchObject({ operator: ">=", threshold: 50 });
    expect(a.severity).toBe("info");
  });
});
