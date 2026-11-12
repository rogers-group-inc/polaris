/**
 * tests/unit/triggers.test.ts — the trigger vocabulary
 * (src/services/notificationTypes/triggers.ts): the threshold comparator, the
 * severity-band ladder (business rule 19 / 19(a)), poll-counted holds and
 * poll-group aggregation (rules 66 / 67), Path Monitor helpers (rule 85), the
 * composite-tree helpers and the trigger Zod schema.
 *
 * Complements (does not repeat):
 *  - notificationSeverityBands.test.ts — severityForValue / resolveTierLadder
 *    over band fixtures;
 *  - countWindow / band-descent / response-time suites — the engine reading
 *    rollingAggregate, bandDescent and prepareResponseTimeWindow;
 *  - pathMonitorTrigger.test.ts, pathCheckAutomation.test.ts — isPathTrigger /
 *    pathMonitorScope through the engine;
 *  - notificationChangeTypes.test.ts, assetTagTrigger.test.ts, cpuCores.test.ts,
 *    fcPortCounters.test.ts, memoryForecast*.test.ts — vocabulary entries.
 * New here: every comparator incl. an unknown one, the met-since clock-step
 * guard, the disjoint-group contract (no sliding, partial group dropped),
 * advanceRun's repeat / unknown-anchor rules, both bandDescent paths, the
 * composite helpers (triggerConditionStats, collapseCompositeTrigger,
 * validateCompositeTrigger, collectTriggerLeaves — none had a direct test) and
 * parseMemberIpFilter edge shapes. Pure module — no database, no network.
 */

import { describe, it, expect, vi } from "vitest";
import type { z } from "zod";
import {
  numMeets,
  severityForValue,
  resolveTierLadder,
  updateTierMetSince,
  sustainedSeverity,
  leadingRun,
  rollingAggregate,
  prepareResponseTimeWindow,
  triggerWindowPolls,
  advanceRun,
  sustainedSeverityByRun,
  triggerHoldPolls,
  resetSustainPolls,
  bandDescent,
  BAND_DESCENT_KEY_PREFIX,
  tierMetSinceChanged,
  ASSET_METRICS,
  BOOLEAN_METRICS,
  BOOLEAN_METRIC_LABELS,
  isBooleanMetric,
  PATH_METRICS,
  isPathMetric,
  isPathTrigger,
  pathTriggerIncludesServer,
  pathMonitorScope,
  AGENT_INSTALLED_RULE,
  eventMatchesPathServer,
  scopeForTrigger,
  CHANGE_TYPES,
  CHANGE_TYPE_ACTIONS,
  triggerSchema,
  triggerConditionStats,
  collapseCompositeTrigger,
  validateCompositeTrigger,
  collectTriggerLeaves,
  parseMemberIpFilter,
  type ResolvedTier,
  type Trigger,
  type CompositeTrigger,
  type CompositeLeaf,
} from "../../src/services/notificationTypes/triggers.js";

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);

const cpuLeaf = (threshold = 90): CompositeLeaf =>
  ({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold }) as CompositeLeaf;
const pathLeaf = (): CompositeLeaf =>
  ({ type: "asset_metric", metric: "pathLatencyMs", aggregation: "latest", windowSec: 0, operator: ">", threshold: 200 }) as CompositeLeaf;
const hostLeaf = (): CompositeLeaf =>
  ({ type: "host_metric", metric: "loadAvg1", aggregation: "latest", windowSec: 0, operator: ">", threshold: 4 }) as CompositeLeaf;

const composite = (over: Partial<CompositeTrigger> & { children: CompositeTrigger["children"] }): CompositeTrigger =>
  ({ type: "composite", kind: "asset", op: "and", forDurationSec: 0, ...over }) as CompositeTrigger;

function ctxSpy(): { ctx: z.RefinementCtx; messages: () => string[] } {
  const addIssue = vi.fn();
  return {
    ctx: { addIssue, path: [] } as unknown as z.RefinementCtx,
    messages: () => addIssue.mock.calls.map((c) => (c[0] as { message: string }).message),
  };
}

describe("numMeets", () => {
  it.each([
    [5, ">", 4, true], [4, ">", 4, false],
    [4, ">=", 4, true], [3, ">=", 4, false],
    [3, "<", 4, true], [4, "<", 4, false],
    [4, "<=", 4, true], [5, "<=", 4, false],
    [4, "==", 4, true], [4.0001, "==", 4, false],
    [5, "!=", 4, true], [4, "!=", 4, false],
  ] as const)("%d %s %d → %s", (v, op, t, want) => {
    expect(numMeets(v, op, t)).toBe(want);
  });

  it("an unknown operator never meets", () => {
    expect(numMeets(5, "~=", 5)).toBe(false);
  });
});

describe("severityForValue", () => {
  it("returns the most severe met tier regardless of band order", () => {
    const bands = [{ threshold: 99, severity: "critical" as const }, { threshold: 95, severity: "serious" as const }];
    expect(severityForValue(">=", 90, "warning", bands, 96)).toBe("serious");
    expect(severityForValue(">=", 90, "warning", bands, 100)).toBe("critical");
    expect(severityForValue(">=", 90, "warning", bands, 50)).toBeNull();
  });

  it("no reading / NaN is null; a band's own operator wins", () => {
    expect(severityForValue(">", 1, "warning", null, null)).toBeNull();
    expect(severityForValue(">", 1, "warning", null, Number.NaN)).toBeNull();
    expect(severityForValue("<", 10, "warning", [{ threshold: 5, severity: "critical", operator: "<=" }], 5)).toBe("critical");
  });
});

describe("tier ladder + met-since clock", () => {
  it("resolveTierLadder: bands inherit operator / seconds / polls unless they carry their own seconds", () => {
    const ladder = resolveTierLadder(">", 80, "warning", 300, [
      { threshold: 90, severity: "serious" },
      { threshold: 95, severity: "critical", forDurationSec: 60, operator: ">=" },
    ], 3.4);
    expect(ladder[0]).toEqual({ threshold: 80, severity: "warning", operator: ">", forDurationSec: 300, forPolls: 3 });
    expect(ladder[1]).toEqual({ threshold: 90, severity: "serious", operator: ">", forDurationSec: 300, forPolls: 3 });
    expect(ladder[2]).toEqual({ threshold: 95, severity: "critical", operator: ">=", forDurationSec: 60, forPolls: undefined });
  });

  it("resolveTierLadder: non-positive polls are absent; negative seconds floor at 0", () => {
    const [base] = resolveTierLadder(">", 1, "warning", -5, null, 0);
    expect(base!.forPolls).toBeUndefined();
    expect(base!.forDurationSec).toBe(0);
  });

  const tiers = resolveTierLadder(">", 80, "warning", 60, [{ threshold: 90, severity: "critical", forDurationSec: 0 }]);

  it("updateTierMetSince keeps a running tier's timestamp and drops tiers no longer met", () => {
    const a = updateTierMetSince(null, tiers, 95, T0);
    expect(a).toEqual({ warning: T0, critical: T0 });
    const b = updateTierMetSince(a, tiers, 85, T0 + 30_000);
    expect(b).toEqual({ warning: T0 });
    expect(updateTierMetSince(b, tiers, null, T0 + 60_000)).toEqual({});
  });

  it("updateTierMetSince restarts a timestamp from the future (clock step) or a non-number", () => {
    expect(updateTierMetSince({ warning: T0 + 3_600_000 }, tiers, 85, T0)).toEqual({ warning: T0 });
    expect(updateTierMetSince({ warning: Number.NaN }, tiers, 85, T0)).toEqual({ warning: T0 });
  });

  it("sustainedSeverity: the most severe tier whose OWN hold has elapsed", () => {
    expect(sustainedSeverity({ warning: T0, critical: T0 }, tiers, T0 + 10_000)).toBe("critical");
    expect(sustainedSeverity({ warning: T0 }, tiers, T0 + 59_999)).toBeNull();
    expect(sustainedSeverity({ warning: T0 }, tiers, T0 + 60_000)).toBe("warning");
    expect(sustainedSeverity(null, tiers, T0)).toBeNull();
  });

  it("tierMetSinceChanged compares keys and values", () => {
    expect(tierMetSinceChanged({ a: 1 }, { a: 1 })).toBe(false);
    expect(tierMetSinceChanged(null, undefined)).toBe(false);
    expect(tierMetSinceChanged({ a: 1 }, { a: 2 })).toBe(true);
    expect(tierMetSinceChanged({ a: 1 }, { b: 1 })).toBe(true);
    expect(tierMetSinceChanged({ a: 1 }, {})).toBe(true);
  });
});

describe("poll-counted holds", () => {
  it("leadingRun counts consecutive leading matches only", () => {
    expect(leadingRun([9, 9, 1, 9], (v) => v > 5)).toBe(2);
    expect(leadingRun([1, 9], (v) => v > 5)).toBe(0);
    expect(leadingRun([], () => true)).toBe(0);
  });

  it("rule 66: rollingAggregate cuts DISJOINT newest-first groups and drops a partial tail", () => {
    expect(rollingAggregate([1, 2, 3, 4, 5, 6, 7], 3, "avg")).toEqual([2, 5]);
    expect(rollingAggregate([1, 2], 3, "avg")).toEqual([]);
    expect(rollingAggregate([5, 1, 3, 2], 2, "latest")).toEqual([5, 3]);
    expect(rollingAggregate([5, 1, 3, 2], 2, "min")).toEqual([1, 2]);
    expect(rollingAggregate([5, 1, 3, 2], 2, "max")).toEqual([5, 3]);
    expect(rollingAggregate([4, 1, 3, 2], 4, "median")).toEqual([2.5]);
    expect(rollingAggregate([4, 1, 3], 3, "median")).toEqual([3]);
  });

  it("rule 66: holes are dropped, not filled — the window counts measurements", () => {
    expect(rollingAggregate([10, null, 20, Number.NaN, 30], 3, "avg")).toEqual([20]);
    expect(rollingAggregate([null, null, 10], 2, "avg")).toEqual([]);
  });

  it("a window under 1 is treated as 1 (the raw readings)", () => {
    expect(rollingAggregate([3, 2, 1], 0, "avg")).toEqual([3, 2, 1]);
    expect(rollingAggregate([3, 2, 1], 1.4, "max")).toEqual([3, 2, 1]);
  });

  it("rule 67: a miss is its timeout, an outage resets the window, an unrecorded timeout is a hole", () => {
    const out = prepareResponseTimeWindow([
      { responseTimeMs: 12, timeoutMs: null, assetDown: false },
      { responseTimeMs: null, timeoutMs: 2000, assetDown: false },
      { responseTimeMs: null, timeoutMs: null, assetDown: false },
      { responseTimeMs: null, timeoutMs: 2000, assetDown: true },
      { responseTimeMs: 9, timeoutMs: null, assetDown: false },
    ]);
    expect(out).toEqual([12, 2000, null]);
    expect(prepareResponseTimeWindow([{ responseTimeMs: null, timeoutMs: 0, assetDown: false }])).toEqual([null]);
  });

  it("triggerWindowPolls only with a real aggregation", () => {
    expect(triggerWindowPolls({ windowPolls: 5, aggregation: "avg" })).toBe(5);
    expect(triggerWindowPolls({ windowPolls: 4.6, aggregation: "max" })).toBe(5);
    expect(triggerWindowPolls({ windowPolls: 5, aggregation: "latest" })).toBe(0);
    expect(triggerWindowPolls({ windowPolls: 5 })).toBe(0);
    expect(triggerWindowPolls({ windowPolls: 0, aggregation: "avg" })).toBe(0);
    expect(triggerWindowPolls(null)).toBe(0);
  });

  it("advanceRun: a repeat anchor is not a reading; unknown anchors count; misses zero the run", () => {
    const t1 = new Date(T0);
    const t2 = new Date(T0 + 300_000);
    expect(advanceRun(2, true, t1, t1)).toEqual({ run: 2, advanced: false });
    expect(advanceRun(2, true, t1, t2)).toEqual({ run: 2, advanced: false });
    expect(advanceRun(2, true, t2, t1)).toEqual({ run: 3, advanced: true });
    expect(advanceRun(2, false, t2, t1)).toEqual({ run: 0, advanced: true });
    expect(advanceRun(2, true, null, t1)).toEqual({ run: 3, advanced: true });
    expect(advanceRun(Number.NaN, true, t2, null)).toEqual({ run: 1, advanced: true });
    expect(advanceRun(-4, true, t2, null)).toEqual({ run: 1, advanced: true });
  });

  it("sustainedSeverityByRun: counted tiers only, count 0 fires on the first reading", () => {
    const ladder: ResolvedTier[] = [
      { threshold: 80, severity: "warning", operator: ">", forDurationSec: 0, forPolls: 3 },
      { threshold: 90, severity: "critical", operator: ">", forDurationSec: 0, forPolls: 0 },
      { threshold: 99, severity: "serious", operator: ">", forDurationSec: 60 },
    ];
    expect(sustainedSeverityByRun({ warning: 3 }, ladder)).toBe("warning");
    expect(sustainedSeverityByRun({ warning: 2 }, ladder)).toBeNull();
    expect(sustainedSeverityByRun({ warning: 3, critical: 1 }, ladder)).toBe("critical");
    expect(sustainedSeverityByRun({ serious: 50 }, ladder)).toBeNull();
    expect(sustainedSeverityByRun(null, ladder)).toBeNull();
  });

  it("triggerHoldPolls / resetSustainPolls round a positive count, else 0", () => {
    expect(triggerHoldPolls({ forPolls: 2.5 })).toBe(3);
    expect(triggerHoldPolls({ forPolls: 0 })).toBe(0);
    expect(triggerHoldPolls(null)).toBe(0);
    expect(resetSustainPolls({ sustainPolls: 4 })).toBe(4);
    expect(resetSustainPolls({ sustainPolls: null })).toBe(0);
    expect(resetSustainPolls(undefined)).toBe(0);
  });
});

describe("bandDescent (rule 19(a))", () => {
  const counted: ResolvedTier[] = [
    { threshold: 80, severity: "warning", operator: ">=", forDurationSec: 900, forPolls: 3 },
    { threshold: 95, severity: "critical", operator: ">=", forDurationSec: 900, forPolls: 3 },
  ];
  const clock: ResolvedTier[] = counted.map((t) => ({ ...t, forPolls: undefined, forDurationSec: 600 }));

  it("an alert at a severity not on the ladder descends at once", () => {
    expect(bandDescent({ tiers: counted, current: "serious", value: 50, series: null, countsReadings: false, metSince: { a: 1 }, prevMetSince: null, nowMs: T0 })).toEqual({ due: true, metSince: { a: 1 } });
  });

  it("counted: descends only after forPolls readings OUT of the tier", () => {
    const base = { tiers: counted, current: "critical", value: 90, countsReadings: true, metSince: {}, prevMetSince: null, nowMs: T0 };
    expect(bandDescent({ ...base, series: [90, 91, 96] }).due).toBe(false);
    expect(bandDescent({ ...base, series: [90, 91, 92, 96] }).due).toBe(true);
    // A non-numeric reading counts as out of the tier.
    expect(bandDescent({ ...base, series: [null, "x", 90] }).due).toBe(true);
  });

  it("wall clock: starts a descent timer, holds it, then descends once the hold elapses", () => {
    const base = { tiers: clock, current: "critical", value: 90, series: null, countsReadings: false, metSince: { warning: T0 } };
    const key = BAND_DESCENT_KEY_PREFIX + "critical";
    const first = bandDescent({ ...base, prevMetSince: null, nowMs: T0 });
    expect(first).toEqual({ due: false, metSince: { warning: T0, [key]: T0 } });
    const mid = bandDescent({ ...base, prevMetSince: first.metSince, nowMs: T0 + 599_000 });
    expect(mid).toEqual({ due: false, metSince: { warning: T0, [key]: T0 } });
    const done = bandDescent({ ...base, prevMetSince: first.metSince, nowMs: T0 + 600_000 });
    expect(done).toEqual({ due: true, metSince: { warning: T0 } });
  });

  it("wall clock: back inside the tier drops the timer; a future timer restarts", () => {
    const key = BAND_DESCENT_KEY_PREFIX + "critical";
    const inside = bandDescent({ tiers: clock, current: "critical", value: 97, series: null, countsReadings: false, metSince: {}, prevMetSince: { [key]: T0 - 1000 }, nowMs: T0 });
    expect(inside).toEqual({ due: false, metSince: {} });
    const future = bandDescent({ tiers: clock, current: "critical", value: 50, series: null, countsReadings: false, metSince: {}, prevMetSince: { [key]: T0 + 9_999_999 }, nowMs: T0 });
    expect(future.metSince[key]).toBe(T0);
  });

  it("a zero hold descends immediately", () => {
    const zero = clock.map((t) => ({ ...t, forDurationSec: 0 }));
    expect(bandDescent({ tiers: zero, current: "critical", value: 97, series: null, countsReadings: false, metSince: null, prevMetSince: null, nowMs: T0 }).due).toBe(true);
  });
});

describe("vocabulary", () => {
  it("every boolean and path metric is an asset metric", () => {
    for (const m of [...BOOLEAN_METRICS, ...PATH_METRICS]) expect(ASSET_METRICS).toContain(m);
    expect(isBooleanMetric("pathOk")).toBe(true);
    expect(isBooleanMetric("cpuPct")).toBe(false);
    expect(isBooleanMetric(null)).toBe(false);
    // customStateValue's labels come per-probe, so it has no metric-wide label.
    expect(BOOLEAN_METRIC_LABELS.customStateValue).toBeUndefined();
    expect(BOOLEAN_METRIC_LABELS.hwSensorAlarm?.trueIsProblem).toBe(true);
  });

  it("every change type maps to an audit action", () => {
    for (const c of CHANGE_TYPES) expect(CHANGE_TYPE_ACTIONS[c]).toMatch(/\./);
    expect(new Set(Object.values(CHANGE_TYPE_ACTIONS)).size).toBe(CHANGE_TYPES.length);
  });
});

describe("Path Monitor helpers (rule 85)", () => {
  const pathMetric = { type: "asset_metric", metric: "pathLatencyMs" };

  it("isPathTrigger: path metric, path change, or an all-path composite", () => {
    expect(isPathMetric("pathOk")).toBe(true);
    expect(isPathMetric(undefined)).toBe(false);
    expect(isPathTrigger(pathMetric)).toBe(true);
    expect(isPathTrigger({ type: "asset_metric", metric: "cpuPct" })).toBe(false);
    expect(isPathTrigger({ type: "change", changeType: "path_check_path_changed" })).toBe(true);
    expect(isPathTrigger({ type: "change", changeType: "firmware_changed" })).toBe(false);
    expect(isPathTrigger({ type: "composite", children: [pathLeaf(), { op: "or", children: [pathLeaf()] }] })).toBe(true);
    expect(isPathTrigger({ type: "composite", children: [pathLeaf(), cpuLeaf()] })).toBe(false);
    expect(isPathTrigger({ type: "composite", children: [] })).toBe(false);
    expect(isPathTrigger(null)).toBe(false);
    expect(isPathTrigger("asset_metric")).toBe(false);
  });

  it("pathTriggerIncludesServer only on a single path condition with the flag true", () => {
    expect(pathTriggerIncludesServer({ ...pathMetric, includeServer: true })).toBe(true);
    expect(pathTriggerIncludesServer({ ...pathMetric, includeServer: false })).toBe(false);
    expect(pathTriggerIncludesServer({ type: "asset_metric", metric: "cpuPct", includeServer: true })).toBe(false);
    expect(pathTriggerIncludesServer({ type: "composite", includeServer: true, children: [pathLeaf(), pathLeaf()] })).toBe(false);
  });

  it("pathMonitorScope ANDs the agent rule without disturbing the operator's tree", () => {
    const own = { op: "or" as const, children: [{ field: "hostname", operator: "contains", value: "x" }] };
    expect(pathMonitorScope({ allAssets: true }).condition).toEqual({ op: "and", children: [AGENT_INSTALLED_RULE] });
    expect(pathMonitorScope({ condition: own }).condition).toEqual({ op: "and", children: [AGENT_INSTALLED_RULE, own] });
    expect(pathMonitorScope({ tags: ["prod"] })).toEqual({ tags: ["prod"], condition: { op: "and", children: [AGENT_INSTALLED_RULE] } });
  });

  it("pathMonitorScope keeps a select-nothing scope selecting nothing", () => {
    expect(pathMonitorScope({})).toEqual({});
    expect(pathMonitorScope(null)).toEqual({});
    expect(pathMonitorScope({ condition: { op: "and", children: [] } })).toEqual({ condition: { op: "and", children: [] } });
  });

  it("eventMatchesPathServer: only the path change about a path-check resource decides", () => {
    const change = { type: "change", changeType: "path_check_path_changed" };
    expect(eventMatchesPathServer(change, false, "asset")).toBeNull();
    expect(eventMatchesPathServer({ type: "change", changeType: "firmware_changed" }, false, "path-check")).toBeNull();
    expect(eventMatchesPathServer(change, false, "path-check")).toBe(true);
    expect(eventMatchesPathServer(change, true, "path-check")).toBe(false);
    expect(eventMatchesPathServer({ ...change, includeServer: true }, true, "path-check")).toBe(true);
    expect(eventMatchesPathServer({ ...change, includeServer: false }, false, "path-check")).toBe(false);
  });

  it("scopeForTrigger narrows path triggers only", () => {
    expect(scopeForTrigger({ allAssets: true }, { type: "asset_metric", metric: "cpuPct" })).toEqual({ allAssets: true });
    expect(scopeForTrigger({ allAssets: true }, pathMetric).condition?.children[0]).toEqual(AGENT_INSTALLED_RULE);
  });
});

describe("composite helpers", () => {
  it("triggerConditionStats: root depth 1, nested groups add depth, leaves counted", () => {
    expect(triggerConditionStats({ op: "and", children: [cpuLeaf(), cpuLeaf()] })).toEqual({ depth: 1, leaves: 2 });
    expect(triggerConditionStats({ op: "and", children: [cpuLeaf(), { op: "or", children: [cpuLeaf(), { op: "and", children: [cpuLeaf()] }] }] })).toEqual({ depth: 3, leaves: 3 });
  });

  it("collectTriggerLeaves flattens in document order", () => {
    const a = cpuLeaf(1), b = cpuLeaf(2), c = cpuLeaf(3);
    expect(collectTriggerLeaves({ children: [a, { op: "or", children: [b, { op: "and", children: [c] }] }] })).toEqual([a, b, c]);
  });

  it("collapseCompositeTrigger: a single leaf becomes the bare trigger and carries the hold in both spellings", () => {
    const out = collapseCompositeTrigger(composite({ children: [{ op: "or", children: [cpuLeaf(75)] }], forDurationSec: 300, forPolls: 5 }) as Trigger);
    expect(out).toEqual({ ...cpuLeaf(75), forDurationSec: 300, forPolls: 5 });
  });

  it("collapseCompositeTrigger unwraps single-child group wrappers but keeps a real tree", () => {
    const out = collapseCompositeTrigger(composite({ op: "and", children: [{ op: "or", children: [cpuLeaf(1), cpuLeaf(2)] }] }) as Trigger) as CompositeTrigger;
    expect(out.type).toBe("composite");
    expect(out.op).toBe("or");
    expect(out.children).toHaveLength(2);
    const plain = { type: "event", actionPattern: "*" } as Trigger;
    expect(collapseCompositeTrigger(plain)).toBe(plain);
  });

  it("validateCompositeTrigger accepts a coherent two-leaf device tree", () => {
    const { ctx, messages } = ctxSpy();
    validateCompositeTrigger(composite({ children: [cpuLeaf(), cpuLeaf()] }), ctx);
    expect(messages()).toEqual([]);
  });

  it("refuses depth > 3, > 10 leaves and < 2 leaves", () => {
    const deep = ctxSpy();
    validateCompositeTrigger(composite({ children: [cpuLeaf(), { op: "or", children: [{ op: "and", children: [{ op: "or", children: [cpuLeaf()] }] }] }] }), deep.ctx);
    expect(deep.messages().join()).toContain("nest at most 3");

    const many = ctxSpy();
    validateCompositeTrigger(composite({ children: [{ op: "or", children: Array.from({ length: 6 }, () => cpuLeaf()) }, { op: "or", children: Array.from({ length: 5 }, () => cpuLeaf()) }] }), many.ctx);
    expect(many.messages().join()).toContain("at most 10 conditions");

    const one = ctxSpy();
    validateCompositeTrigger(composite({ children: [cpuLeaf()] }), one.ctx);
    expect(one.messages().join()).toContain("at least 2 conditions");
  });

  it("refuses mixing path and device conditions, and host leaves in a device tree (and vice versa)", () => {
    const mixed = ctxSpy();
    validateCompositeTrigger(composite({ children: [pathLeaf(), cpuLeaf()] }), mixed.ctx);
    expect(mixed.messages().join()).toContain("Path Monitor conditions cannot be combined");

    const hostInDevice = ctxSpy();
    validateCompositeTrigger(composite({ children: [cpuLeaf(), hostLeaf()] }), hostInDevice.ctx);
    expect(hostInDevice.messages().join()).toContain("device composite triggers may not contain");

    const deviceInHost = ctxSpy();
    validateCompositeTrigger(composite({ kind: "host", children: [hostLeaf(), cpuLeaf()] }), deviceInHost.ctx);
    expect(deviceInHost.messages().join()).toContain("host composite triggers may only contain");

    const allPath = ctxSpy();
    validateCompositeTrigger(composite({ children: [pathLeaf(), pathLeaf()] }), allPath.ctx);
    expect(allPath.messages()).toEqual([]);
  });
});

describe("triggerSchema", () => {
  it("fills the asset-metric defaults", () => {
    const t = triggerSchema.parse({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 });
    expect(t).toMatchObject({ aggregation: "latest", windowSec: 0, forDurationSec: 0 });
  });

  it("caps forPolls / windowPolls / missedPolls and validates the forecast horizon", () => {
    expect(triggerSchema.safeParse({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 1, forPolls: 101 }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 1, windowPolls: 0 }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: 0 }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: "asset_metric", metric: "memForecastPct", operator: ">", threshold: 80, forecastDays: 366 }).success).toBe(false);
  });

  it("the dimension filter is strict and validates the member-IP comparison", () => {
    const base = { type: "asset_metric", metric: "sdwanLatencyMs", operator: ">", threshold: 100 };
    expect(triggerSchema.safeParse({ ...base, dimensionFilter: { bogus: "x" } }).success).toBe(false);
    expect(triggerSchema.safeParse({ ...base, dimensionFilter: { sdwanMemberIp: "!= 0.0.0.0" } }).success).toBe(true);
    expect(triggerSchema.safeParse({ ...base, dimensionFilter: { sdwanMemberIp: "0.0.0.0" } }).success).toBe(false);
    expect(triggerSchema.safeParse({ ...base, dimensionFilter: { sensorClass: "humidity" } }).success).toBe(false);
  });

  it("composite leaves may not carry their own hold", () => {
    const leafWithHold = { ...cpuLeaf(), forPolls: 3 };
    const parsed = triggerSchema.safeParse({ type: "composite", kind: "asset", op: "and", children: [leafWithHold, cpuLeaf()] });
    // zod's object() strips unknown keys rather than refusing them, so the
    // leaf's hold must simply not survive the parse.
    expect(parsed.success).toBe(true);
    const leaves = collectTriggerLeaves(parsed.data as CompositeTrigger);
    expect(leaves[0]).not.toHaveProperty("forPolls");
  });
});

describe("parseMemberIpFilter", () => {
  it("parses == / != with any whitespace and a real address", () => {
    expect(parseMemberIpFilter("!= 0.0.0.0")).toEqual({ operator: "!=", ip: "0.0.0.0" });
    expect(parseMemberIpFilter("  ==10.1.1.1  ")).toEqual({ operator: "==", ip: "10.1.1.1" });
    expect(parseMemberIpFilter("== fe80::1")).toEqual({ operator: "==", ip: "fe80::1" });
  });

  it("refuses other operators, missing / invalid addresses, and extra tokens", () => {
    expect(parseMemberIpFilter("> 10.1.1.1")).toBeNull();
    expect(parseMemberIpFilter("== ")).toBeNull();
    expect(parseMemberIpFilter("== 10.1.1.300")).toBeNull();
    expect(parseMemberIpFilter("== 10.1.1.1 extra")).toBeNull();
    expect(parseMemberIpFilter("== 10.0.0.0/8")).toBeNull();
    expect(parseMemberIpFilter(null)).toBeNull();
  });
});
