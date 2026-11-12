/**
 * tests/unit/evaluation.test.ts — src/services/notifications/evaluation.ts (CQ-T010).
 *
 * Complements:
 *   - cpuCores.test.ts (evaluationOrder, rule 89 ordering)
 *   - notificationEngine*.test.ts, notificationDeviceDownHandoff, notificationProbeLossGate,
 *     notificationMaintenanceSuppression (the threshold sweep end to end through the engine)
 * Pinned here directly, with the reading resolvers stubbed at their seam:
 *   - the composite tree: resolveLeafTruths (identical leaves share one
 *     resolve; host leaves land on ""; ANY-dimension fold with the first
 *     meeting dimension as witness; newest readingAt), compositeOutcomeForAsset
 *     (and/or/nested, absent evidence never fires), leafConditionLabel and
 *     compositeFireInfo wording;
 *   - evaluateThresholdRule's ASSET SELECTION — which assets reach the
 *     resolver: suppressed (rule 16), not answering on probeLossPct (rule 29),
 *     down on a hand-off metric (rule 29(i)), and the rule-89 per-core
 *     hand-off to a live all-cores alert; an event trigger returns early;
 *   - evaluationOrder stability with nothing to reorder;
 *   - serverPathReadings re-keys the Polaris server to subject "" (rule 85).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({
  resolveAssetMetricReadings: vi.fn(),
  resolveAssetStateReadings: vi.fn(),
  resolveHostMetricReading: vi.fn(),
}));
vi.mock("../../src/services/notifications/readings.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAssetMetricReadings: h.resolveAssetMetricReadings,
  resolveAssetStateReadings: h.resolveAssetStateReadings,
  resolveHostMetricReading: h.resolveHostMetricReading,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import type { Trigger, CompositeLeaf } from "../../src/services/notificationTypes.js";
import type { DbRule, Reading, LeafRef } from "../../src/services/notifications/ruleModel.js";
import { collectLeafRefs } from "../../src/services/notifications/ruleModel.js";
import { clearScopeAssetCache } from "../../src/services/notifications/scope.js";
import { POLARIS_SERVER_SUBJECT } from "../../src/services/pathCheckIngestService.js";
import {
  evaluationOrder,
  evaluateThresholdRule,
  resolveLeafTruths,
  compositeOutcomeForAsset,
  leafConditionLabel,
  compositeFireInfo,
  HOST_PSEUDO_ASSET,
  serverPathReadings,
} from "../../src/services/notifications/evaluation.js";

const L = (l: Record<string, unknown>): CompositeLeaf => l as unknown as CompositeLeaf;
const CPU90 = L({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 90 });
const MEM80 = L({ type: "asset_metric", metric: "memUsedPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80 });
const IFDOWN = L({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" });
const HOSTCPU = L({ type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 50 });

const rd = (assetId: string, value: number | string, dimKey = "", readingAt: Date | null = null): Reading =>
  ({ assetId, hostname: assetId, tags: [], dimKey, dimLabel: dimKey, value, series: [value], readingAt }) as Reading;

beforeEach(() => {
  resetDbStub();
  clearScopeAssetCache(false);
  h.resolveAssetMetricReadings.mockReset().mockResolvedValue([]);
  h.resolveAssetStateReadings.mockReset().mockResolvedValue([]);
  h.resolveHostMetricReading.mockReset().mockResolvedValue(null);
});

describe("evaluationOrder", () => {
  it("returns the input order when no rule is per-core", () => {
    const rules = [{ trigger: { type: "event" } }, { trigger: null }, { trigger: { type: "asset_metric", metric: "cpuPct" } }];
    expect(evaluationOrder(rules)).toEqual(rules);
  });
  it("does not mutate the input", () => {
    const rules = [{ trigger: { type: "asset_metric", metric: "cpuCorePct" } }, { trigger: { type: "event" } }];
    const copy = [...rules];
    expect(evaluationOrder(rules)[0]).toBe(rules[1]);
    expect(rules).toEqual(copy);
  });
});

describe("resolveLeafTruths", () => {
  const assets = [{ id: "a" }, { id: "b" }] as never;

  it("identical leaves share one resolve; each leafId gets its truths", async () => {
    h.resolveAssetMetricReadings.mockResolvedValue([rd("a", 95), rd("b", 10)]);
    const leaves: LeafRef[] = [{ leafId: "0", leaf: CPU90 }, { leafId: "1.0", leaf: { ...CPU90 } as CompositeLeaf }];
    const truths = await resolveLeafTruths(leaves, assets);
    expect(h.resolveAssetMetricReadings).toHaveBeenCalledTimes(1);
    // A leaf carries no sustain of its own — the resolver gets forDurationSec 0.
    expect(h.resolveAssetMetricReadings.mock.calls[0][0]).toMatchObject({ metric: "cpuPct", forDurationSec: 0 });
    expect(truths.get("0")!.get("a")!.met).toBe(true);
    expect(truths.get("1.0")!.get("b")!.met).toBe(false);
  });

  it("ANY-dimension fold: met if any dimension meets; the witness is the first meeting one; readingAt is the newest", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-01T00:05:00Z");
    h.resolveAssetStateReadings.mockResolvedValue([
      rd("a", "up", "port1", t2), rd("a", "down", "port2", t1), rd("a", "down", "port3", null),
    ]);
    const truths = await resolveLeafTruths([{ leafId: "0", leaf: IFDOWN }], assets);
    const t = truths.get("0")!.get("a")!;
    expect(t.met).toBe(true);
    expect(t.witness).toEqual({ dimLabel: "port2", value: "down" });
    expect(t.sample).toEqual({ dimLabel: "port1", value: "up" });
    expect(t.readingAt).toEqual(t2);
    expect(t.hasReading).toBe(true);
  });

  it("a host leaf lands on the pseudo-asset id ''; no host reading → no entry", async () => {
    h.resolveHostMetricReading.mockResolvedValueOnce(rd("", 70));
    let truths = await resolveLeafTruths([{ leafId: "0", leaf: HOSTCPU }], []);
    expect(truths.get("0")!.get("")!.met).toBe(true);
    truths = await resolveLeafTruths([{ leafId: "0", leaf: HOSTCPU }], []);
    expect(truths.get("0")!.size).toBe(0);
  });
});

describe("compositeOutcomeForAsset", () => {
  const truth = (met: boolean, readingAt: Date | null = null) => ({ met, witness: met ? { dimLabel: "", value: 1 } : null, sample: null, hasReading: true, readingAt });
  const tree = (op: "and" | "or", children: unknown[]) => ({ op, children }) as never;

  it("AND needs every leaf; OR needs one; met leaves are listed", () => {
    const t = tree("and", [CPU90, MEM80]);
    const leaves = collectLeafRefs(t);
    const truths = new Map([["0", new Map([["a", truth(true)]])], ["1", new Map([["a", truth(false)]])]]);
    const and = compositeOutcomeForAsset(t, "a", leaves, truths);
    expect(and.meets).toBe(false);
    expect(and.metLeaves.map((m) => m.leafId)).toEqual(["0"]);
    expect(and.totalLeaves).toBe(2);
    expect(compositeOutcomeForAsset(tree("or", [CPU90, MEM80]), "a", leaves, truths).meets).toBe(true);
  });

  it("absent evidence is never met, and an asset with no leaf readings says so", () => {
    const t = tree("or", [CPU90, MEM80]);
    const out = compositeOutcomeForAsset(t, "zz", collectLeafRefs(t), new Map());
    expect(out).toMatchObject({ meets: false, hasAnyReading: false, readingAt: null, metLeaves: [] });
  });

  it("nested groups evaluate on their tree-path ids; readingAt is the newest leaf reading", () => {
    const t = tree("and", [CPU90, { op: "or", children: [MEM80, IFDOWN] }]);
    const leaves = collectLeafRefs(t);
    expect(leaves.map((l) => l.leafId)).toEqual(["0", "1.0", "1.1"]);
    const early = new Date("2026-01-01T00:00:00Z");
    const late = new Date("2026-01-01T01:00:00Z");
    const truths = new Map([
      ["0", new Map([["a", truth(true, early)]])],
      ["1.0", new Map([["a", truth(false, late)]])],
      ["1.1", new Map([["a", truth(true)]])],
    ]);
    const out = compositeOutcomeForAsset(t, "a", leaves, truths);
    expect(out.meets).toBe(true);
    expect(out.readingAt).toEqual(late);
    expect(out.hasAnyReading).toBe(true);
  });
});

describe("leafConditionLabel / compositeFireInfo", () => {
  it("uses the metric / field label, falling back to the raw key", () => {
    expect(leafConditionLabel(CPU90)).toMatch(/>= 90$/);
    expect(leafConditionLabel(CPU90)).not.toMatch(/^cpuPct/);
    expect(leafConditionLabel(L({ type: "asset_metric", metric: "noSuchMetric", operator: ">", threshold: 1 }))).toBe("noSuchMetric > 1");
    expect(leafConditionLabel(L({ type: "asset_state", field: "noSuchField", operator: "==", value: "x" }))).toBe("noSuchField == x");
  });

  it("joins met leaves with ' and ', rounds numeric witnesses, names the dimension", () => {
    const info = compositeFireInfo({
      meets: true, hasAnyReading: true, totalLeaves: 3,
      metLeaves: [
        { leafId: "0", leaf: CPU90, witness: { dimLabel: "", value: 93.456 } },
        { leafId: "1", leaf: IFDOWN, witness: { dimLabel: "port7", value: "down" } },
      ],
    });
    expect(info.conditions).toBe("2 of 3 conditions met");
    expect(info.summary).toContain("(93.46)");
    expect(info.summary).toContain(" and ");
    expect(info.summary).toContain("(port7 = down)");
  });

  it("a leaf without a witness is its bare label; nothing met → 'conditions met'", () => {
    expect(compositeFireInfo({ meets: true, hasAnyReading: true, totalLeaves: 1, metLeaves: [{ leafId: "0", leaf: CPU90, witness: null }] }).summary)
      .toBe(leafConditionLabel(CPU90));
    expect(compositeFireInfo({ meets: false, hasAnyReading: false, totalLeaves: 2, metLeaves: [] }))
      .toEqual({ summary: "conditions met", conditions: "0 of 2 conditions met" });
  });
});

describe("HOST_PSEUDO_ASSET / serverPathReadings (rule 85)", () => {
  it("the host pseudo-asset is an active, unsuppressed, id-less row", () => {
    expect(HOST_PSEUDO_ASSET).toMatchObject({ id: "", status: "active", dependencySuppressed: false, tags: [] });
  });
  it("resolves against the reserved server subject and re-keys to ''", async () => {
    h.resolveAssetMetricReadings.mockResolvedValue([{ ...rd(POLARIS_SERVER_SUBJECT, 120, "chk1"), tags: ["x"] }]);
    const trig = { type: "asset_metric", metric: "pathLatencyMs", operator: ">", threshold: 100 } as unknown as Extract<Trigger, { type: "asset_metric" }>;
    const out = await serverPathReadings(trig);
    expect(h.resolveAssetMetricReadings.mock.calls[0][1][0].id).toBe(POLARIS_SERVER_SUBJECT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ assetId: "", tags: [], dimKey: "chk1", value: 120 });
    expect(out[0].hostname).not.toBe(POLARIS_SERVER_SUBJECT);
  });
});

describe("evaluateThresholdRule — who reaches the resolver", () => {
  const baseRule = (trigger: Record<string, unknown>): DbRule => ({
    id: "r1", name: "rule", description: null, severity: "warning", trigger: trigger as unknown as Trigger,
    scope: { allAssets: true }, reset: { mode: "auto" }, severityBands: null, actions: [],
  }) as unknown as DbRule;
  const row = (id: string, o: Record<string, unknown> = {}) => ({
    id, hostname: id, tags: [], status: "active", dependencySuppressed: false, monitorStatus: "up", monitored: true, ...o,
  });
  const resolvedIds = () => (h.resolveAssetMetricReadings.mock.calls[0][1] as { id: string }[]).map((a) => a.id);

  beforeEach(() => {
    vi.mocked(prisma.notificationRuleState.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
  });

  it("an event trigger is not this function's: no scope load, no state read", async () => {
    await evaluateThresholdRule(baseRule({ type: "event", actionPattern: "*" }));
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationRuleState.findMany).not.toHaveBeenCalled();
  });

  it("a host metric reads the host, not the fleet", async () => {
    await evaluateThresholdRule(baseRule({ type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0 }));
    expect(h.resolveHostMetricReading).toHaveBeenCalledTimes(1);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationRuleState.findMany).toHaveBeenCalledWith({ where: { ruleId: "r1" } });
  });

  it("loads monitored assets only and drops suppressed ones (rule 16)", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row("ok"), row("maint", { status: "maintenance" }), row("dep", { dependencySuppressed: true }),
    ] as never);
    await evaluateThresholdRule(baseRule({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 90, forDurationSec: 0 }));
    expect(vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where).toEqual({ monitored: true });
    expect(resolvedIds()).toEqual(["ok"]);
  });

  it("probeLossPct reaches only answering devices (rule 29)", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      row("up"), row("warn", { monitorStatus: "warning" }), row("down", { monitorStatus: "down" }),
      row("passive", { monitorStatus: "passive" }), row("unknown", { monitorStatus: "unknown" }),
    ] as never);
    await evaluateThresholdRule(baseRule({ type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 0 }));
    expect(resolvedIds()).toEqual(["up", "warn"]);
  });

  it("responseTimeMs hands off only `down` devices (rule 29(i)); cpuPct freezes rather than hands off", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row("up"), row("down", { monitorStatus: "down" }), row("passive", { monitorStatus: "passive" })] as never);
    await evaluateThresholdRule(baseRule({ type: "asset_metric", metric: "responseTimeMs", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 0 }));
    expect(resolvedIds()).toEqual(["up", "passive"]);

    h.resolveAssetMetricReadings.mockClear();
    await evaluateThresholdRule(baseRule({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 0 }));
    expect(resolvedIds()).toEqual(["up", "down", "passive"]);
  });

  it("a per-core CPU rule hands off assets holding a live all-cores alert (rule 89)", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row("a"), row("b")] as never);
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ assetId: "a" }] as never);
    await evaluateThresholdRule(baseRule({ type: "asset_metric", metric: "cpuCorePct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0 }));
    const where = vi.mocked(prisma.notification.findMany).mock.calls[0][0]!.where;
    expect(where).toEqual({ assetId: { in: ["a", "b"] }, metric: "cpuPct", cleared: false, testRun: false, ruleId: { not: null } });
    expect(resolvedIds()).toEqual(["b"]);
  });

  it("an asset_state trigger goes to the state resolver", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValue([row("a")] as never);
    await evaluateThresholdRule(baseRule({ type: "asset_state", field: "fortilinkStatus", operator: "==", value: "down", forDurationSec: 0 }));
    expect(h.resolveAssetStateReadings).toHaveBeenCalledTimes(1);
    expect(h.resolveAssetMetricReadings).not.toHaveBeenCalled();
  });
});
