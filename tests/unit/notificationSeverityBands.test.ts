/**
 * tests/unit/notificationSeverityBands.test.ts — severity bands: input
 * validation (ordered numeric trigger, monotonic thresholds, strictly
 * increasing severities), read-path normalization, and the engine's tier /
 * notify-policy resolution. The DB-bound fire/escalate/resolve transitions are
 * exercised by the integration suite + the podman mock walkthrough.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  normalizeRuleToV2,
  resolveTierLadder,
  updateTierMetSince,
  sustainedSeverity,
  tierMetSinceChanged,
  bandDescent,
  BAND_DESCENT_KEY_PREFIX,
} from "../../src/services/notificationTypes.js";
import { tierForSeverity, bandNotifyOf } from "../../src/services/notificationEngine.js";

const bandedRule = (over: any = {}) => ({
  name: "Core temp",
  trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 55 },
  severity: "warning",
  scope: { allAssets: true },
  severityBands: [
    { threshold: 60, severity: "serious" },
    { threshold: 65, severity: "critical" },
  ],
  ...over,
});

describe("ruleInputSchema — severity bands", () => {
  it("accepts a valid ascending banded rule", () => {
    const parsed = ruleInputSchema.parse(bandedRule());
    expect(parsed.severityBands).toHaveLength(2);
    expect(parsed.severityBands![0]).toMatchObject({ threshold: 60, severity: "serious", actions: [] });
  });

  it("accepts a descending (<=) banded rule (e.g. days-until-full)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_metric", metric: "storageDaysUntilFull", operator: "<=", threshold: 30 },
      severityBands: [{ threshold: 14, severity: "serious" }, { threshold: 7, severity: "critical" }],
    }))).not.toThrow();
  });

  it("rejects bands whose severity does not strictly increase above the base", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "warning" }], // same as base
    }))).toThrow();
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "critical" }, { threshold: 65, severity: "serious" }], // decreasing
    }))).toThrow();
  });

  it("accepts a per-tier operator override (tiers share sampling, vary the comparison)", () => {
    const parsed = ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "serious", operator: ">" }],
    }));
    expect((parsed.severityBands![0] as any).operator).toBe(">");
  });

  it("rejects a per-tier equality operator (needs an ordered comparison)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 60, severity: "serious", operator: "==" }],
    }))).toThrow();
  });

  it("no longer requires monotonic thresholds — the most-severe MET tier wins", () => {
    // Threshold below the base is allowed now (per-tier operators make strict
    // threshold ordering meaningless); only severity must strictly increase.
    expect(() => ruleInputSchema.parse(bandedRule({
      severityBands: [{ threshold: 50, severity: "serious" }],
    }))).not.toThrow();
  });

  it("rejects bands on a non-numeric trigger", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
    }))).toThrow();
  });

  it("rejects bands with an equality operator (no ordering)", () => {
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_metric", metric: "hwSensorValue", operator: "==", threshold: 55 },
    }))).toThrow();
  });

  it("rejects bands on a 0/1 state metric, naming the metric rather than the operator", () => {
    // A flag has two values, so a threshold ladder can't mean anything. The
    // message has to point at the metric: an operator who wrote ">= 1" on a
    // state probe would otherwise be told to pick an ordered comparator and try
    // again with the same broken idea.
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: {
        type: "asset_metric", metric: "customStateValue", operator: ">=", threshold: 1,
        dimensionFilter: { stateProbeId: "p1" },
      },
    }))).toThrow(/0\/1 state metric/);
    // Same guard covers the probeless boolean metric — it's driven by
    // BOOLEAN_METRICS, not by a per-metric special case.
    expect(() => ruleInputSchema.parse(bandedRule({
      trigger: {
        type: "asset_metric", metric: "hwSensorAlarm", operator: ">=", threshold: 1,
        dimensionFilter: { sensorClass: "power" },
      },
    }))).toThrow(/0\/1 state metric/);
  });

  it("accepts an unbanded hwSensorAlarm rule with the shared sensor dimensions", () => {
    const parsed = ruleInputSchema.parse(bandedRule({
      trigger: {
        type: "asset_metric", metric: "hwSensorAlarm", operator: "==", threshold: 1,
        dimensionFilter: { sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE" },
      },
      severityBands: undefined,
    }));
    expect(parsed.trigger).toMatchObject({
      metric: "hwSensorAlarm", operator: "==", threshold: 1,
      dimensionFilter: { sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE" },
    });
  });

  it("accepts an unbanded state-metric rule", () => {
    const parsed = ruleInputSchema.parse(bandedRule({
      trigger: {
        type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
        dimensionFilter: { stateProbeId: "p1", stateRowPattern: "PSU" },
      },
      severityBands: undefined,
    }));
    expect(parsed.trigger).toMatchObject({
      metric: "customStateValue", operator: "==", threshold: 1,
      dimensionFilter: { stateProbeId: "p1", stateRowPattern: "PSU" },
    });
  });

  it("accepts a per-tier sustained duration and leaves it absent when unset", () => {
    const parsed = ruleInputSchema.parse(bandedRule({
      trigger: { type: "asset_metric", metric: "probeLossPct", operator: ">", threshold: 5, forDurationSec: 1800 },
      severityBands: [
        { threshold: 15, severity: "serious", forDurationSec: 900 },
        { threshold: 25, severity: "critical", forDurationSec: 0 },
      ],
    }));
    expect(parsed.severityBands![0]).toMatchObject({ forDurationSec: 900 });
    expect(parsed.severityBands![1]).toMatchObject({ forDurationSec: 0 });
    expect((ruleInputSchema.parse(bandedRule()).severityBands![0] as any).forDurationSec).toBeUndefined();
  });

  it("applies bandNotify defaults and accepts a resolved policy", () => {
    const parsed = ruleInputSchema.parse(bandedRule({ bandNotify: { onDecrease: true, resolvedMode: "dedicated", resolvedActions: [] } }));
    expect(parsed.bandNotify).toMatchObject({ onIncrease: true, onDecrease: true, onResolved: true, resolvedMode: "dedicated" });
  });
});

describe("normalizeRuleToV2 — bands round-trip", () => {
  it("surfaces stored severityBands + bandNotify", () => {
    const v2 = normalizeRuleToV2({
      severityBands: [{ threshold: 60, severity: "serious", actions: [] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    expect(v2.severityBands).toHaveLength(1);
    expect(v2.bandNotify).toMatchObject({ resolvedMode: "reuse" });
  });

  it("returns null bands/policy for a pre-band row", () => {
    const v2 = normalizeRuleToV2({});
    expect(v2.severityBands).toBeNull();
    expect(v2.bandNotify).toBeNull();
  });
});

describe("tierForSeverity", () => {
  const rule: any = {
    severity: "warning",
    actions: [{ type: "notify", channelId: "base" }],
    escalation: null,
    severityBands: [
      { threshold: 60, severity: "serious", actions: [{ type: "notify", channelId: "sev" }], escalation: null },
      { threshold: 65, severity: "critical", actions: [{ type: "notify", channelId: "crit" }], escalation: null },
    ],
  };
  it("maps the base severity to the base (tier 0) actions", () => {
    expect(tierForSeverity(rule, "warning").actions[0]).toMatchObject({ channelId: "base" });
  });
  it("maps a band severity to that band's actions", () => {
    expect(tierForSeverity(rule, "critical").actions[0]).toMatchObject({ channelId: "crit" });
  });
  it("falls back to tier 0 for an unknown severity", () => {
    expect(tierForSeverity(rule, "notice").actions[0]).toMatchObject({ channelId: "base" });
  });
});

// ─── Per-tier sustained durations ───────────────────────────────────────────
// The scenario throughout: packet loss > 5% for 30 min = warning, > 15% for
// 15 min = serious, > 25% immediately = critical.
describe("resolveTierLadder", () => {
  const bands = [
    { threshold: 15, severity: "serious" as const, forDurationSec: 900 },
    { threshold: 25, severity: "critical" as const, forDurationSec: 0 },
  ];
  it("puts the base tier first with the trigger's own operator + duration", () => {
    const ladder = resolveTierLadder(">", 5, "warning", 1800, bands);
    expect(ladder[0]).toEqual({ threshold: 5, severity: "warning", operator: ">", forDurationSec: 1800 });
  });
  it("inherits the base operator + duration for a band that carries neither", () => {
    const ladder = resolveTierLadder(">", 5, "warning", 1800, [{ threshold: 15, severity: "serious" }]);
    expect(ladder[1]).toEqual({ threshold: 15, severity: "serious", operator: ">", forDurationSec: 1800 });
  });
  it("keeps a band's own operator + duration, including an explicit 0", () => {
    const ladder = resolveTierLadder(">", 5, "warning", 1800, [{ threshold: 25, severity: "critical", operator: ">=", forDurationSec: 0 }]);
    expect(ladder[1]).toMatchObject({ operator: ">=", forDurationSec: 0 });
  });
});

describe("updateTierMetSince / sustainedSeverity", () => {
  const tiers = resolveTierLadder(">", 5, "warning", 1800, [
    { threshold: 15, severity: "serious", forDurationSec: 900 },
    { threshold: 25, severity: "critical", forDurationSec: 0 },
  ]);
  const T0 = 1_000_000_000_000;
  const min = (n: number) => T0 + n * 60_000;

  it("starts a run per satisfied tier and keeps it while the value holds", () => {
    const a = updateTierMetSince(null, tiers, 20, T0);
    expect(a).toEqual({ warning: T0, serious: T0 });
    const b = updateTierMetSince(a, tiers, 20, min(5));
    expect(b).toEqual({ warning: T0, serious: T0 }); // continued, not restarted
  });

  it("holds the alert pending until the tier's OWN duration elapses", () => {
    let map = updateTierMetSince(null, tiers, 8, T0); // warning band only
    expect(sustainedSeverity(map, tiers, T0)).toBeNull();
    expect(sustainedSeverity(map, tiers, min(29))).toBeNull();
    expect(sustainedSeverity(map, tiers, min(30))).toBe("warning");
  });

  it("a tier with sustain 0 applies on the first reading", () => {
    const map = updateTierMetSince(null, tiers, 30, T0);
    expect(sustainedSeverity(map, tiers, T0)).toBe("critical");
  });

  it("escalates only once the higher tier has held for its own duration", () => {
    // 8% from T0 (warning sustains at 30m), climbs to 20% at 40m.
    let map = updateTierMetSince(null, tiers, 8, T0);
    map = updateTierMetSince(map, tiers, 20, min(40));
    expect(sustainedSeverity(map, tiers, min(40))).toBe("warning"); // serious run just started
    expect(sustainedSeverity(map, tiers, min(54))).toBe("warning");
    expect(sustainedSeverity(map, tiers, min(55))).toBe("serious"); // +15 min
  });

  it("does not restart the lower tier's run when the value climbs", () => {
    let map = updateTierMetSince(null, tiers, 8, T0);
    map = updateTierMetSince(map, tiers, 20, min(10));
    expect(map.warning).toBe(T0); // the base run is continuous, so it still fires at 30m
    expect(sustainedSeverity(map, tiers, min(20))).toBeNull(); // neither tier has served its time
    // The serious tier hits ITS 15 minutes at min(25) — before the base tier's
    // 30 — and that's the point: each tier earns its own severity.
    expect(sustainedSeverity(map, tiers, min(25))).toBe("serious");
  });

  it("restarts a tier's run after it drops out (flapping never sustains)", () => {
    let map = updateTierMetSince(null, tiers, 20, T0);
    map = updateTierMetSince(map, tiers, 8, min(10)); // out of the serious band
    expect(map.serious).toBeUndefined();
    map = updateTierMetSince(map, tiers, 20, min(12)); // back in — clock restarts
    expect(map.serious).toBe(min(12));
    expect(map.warning).toBe(T0); // but the base run never broke
    // At min(20) the restarted serious run is 8m old — short of its 15m — while
    // the unbroken warning run has passed 30m by min(30).
    expect(sustainedSeverity(map, tiers, min(20))).toBeNull();
    expect(sustainedSeverity(map, tiers, min(30))).toBe("serious");
  });

  it("clears every run when the value drops below the base threshold", () => {
    const map = updateTierMetSince(updateTierMetSince(null, tiers, 30, T0), tiers, 1, min(5));
    expect(map).toEqual({});
    expect(sustainedSeverity(map, tiers, min(5))).toBeNull();
  });

  it("treats a null / NaN reading as no evidence", () => {
    expect(updateTierMetSince({ warning: T0 }, tiers, null, min(1))).toEqual({});
    expect(updateTierMetSince({ warning: T0 }, tiers, NaN, min(1))).toEqual({});
  });

  it("restarts rather than locking out when a stored timestamp is in the future", () => {
    const map = updateTierMetSince({ warning: min(99) }, tiers, 8, T0);
    expect(map.warning).toBe(T0);
  });

  // The ENGINE holds the descent (rule 19(a), bandDescent); the ladder alone
  // still answers "which tier has sustained", and the lower one has.
  it("the lower tier's run is already old, so the ladder answers it at once", () => {
    let map = updateTierMetSince(null, tiers, 30, T0); // critical (sustain 0)
    map = updateTierMetSince(map, tiers, 8, min(60)); // back to the warning band
    expect(sustainedSeverity(map, tiers, min(60))).toBe("warning");
  });
});

describe("tierMetSinceChanged", () => {
  it("is false for equal maps (the engine skips the write)", () => {
    expect(tierMetSinceChanged({ warning: 1 }, { warning: 1 })).toBe(false);
    expect(tierMetSinceChanged(null, {})).toBe(false);
  });
  it("is true when a tier enters, leaves, or restarts", () => {
    expect(tierMetSinceChanged({ warning: 1 }, { warning: 1, serious: 2 })).toBe(true);
    expect(tierMetSinceChanged({ warning: 1, serious: 2 }, { warning: 1 })).toBe(true);
    expect(tierMetSinceChanged({ serious: 2 }, { serious: 3 })).toBe(true);
  });
});

describe("bandNotifyOf", () => {
  it("defaults to increase + resolved (reuse), decrease off", () => {
    expect(bandNotifyOf({ bandNotify: null } as any)).toEqual({ onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse", resolvedActions: [] });
  });
  it("honors an explicit policy", () => {
    expect(bandNotifyOf({ bandNotify: { onIncrease: false, onDecrease: true, onResolved: false, resolvedMode: "dedicated", resolvedActions: [] } } as any))
      .toMatchObject({ onIncrease: false, onDecrease: true, onResolved: false, resolvedMode: "dedicated" });
  });
});

describe("bandDescent — business rule 19(a): a band is left on the hold it was entered on", () => {
  // The incident: memPct > 90 serious, band critical at 95, hold 3 polls.
  const counted = resolveTierLadder(">", 90, "serious", 360, [{ threshold: 95, severity: "critical", actions: [] } as any], 3);
  const wall = resolveTierLadder(">", 90, "serious", 300, [{ threshold: 95, severity: "critical", actions: [] } as any]);
  const NOW = 1_800_000_000_000;

  it("one reading under the band does not ease a counted alert (newest first)", () => {
    const d = bandDescent({ tiers: counted, current: "critical", value: 94, series: [94, 96, 97, 96], countsReadings: true, metSince: {}, prevMetSince: {}, nowMs: NOW });
    expect(d.due).toBe(false);
  });

  it("eases once the value has stayed out of the band for the band's own count", () => {
    const d = bandDescent({ tiers: counted, current: "critical", value: 93, series: [93, 94, 92, 96], countsReadings: true, metSince: {}, prevMetSince: {}, nowMs: NOW });
    expect(d.due).toBe(true);
  });

  it("dead-band readings count toward the descent too", () => {
    const d = bandDescent({ tiers: counted, current: "critical", value: 80, series: [80, 85, 88], countsReadings: true, metSince: {}, prevMetSince: {}, nowMs: NOW });
    expect(d.due).toBe(true);
  });

  it("a wall-clock band starts a descent timer, keeps it, and eases when it has run", () => {
    const first = bandDescent({ tiers: wall, current: "critical", value: 94, series: null, countsReadings: false, metSince: { serious: NOW - 900_000 }, prevMetSince: null, nowMs: NOW });
    expect(first.due).toBe(false);
    expect(first.metSince).toEqual({ serious: NOW - 900_000, [BAND_DESCENT_KEY_PREFIX + "critical"]: NOW });
    const later = bandDescent({ tiers: wall, current: "critical", value: 94, series: null, countsReadings: false, metSince: { serious: NOW - 900_000 }, prevMetSince: first.metSince, nowMs: NOW + 299_000 });
    expect(later.due).toBe(false);
    expect(later.metSince[BAND_DESCENT_KEY_PREFIX + "critical"]).toBe(NOW);
    const done = bandDescent({ tiers: wall, current: "critical", value: 94, series: null, countsReadings: false, metSince: { serious: NOW - 900_000 }, prevMetSince: later.metSince, nowMs: NOW + 300_000 });
    expect(done.due).toBe(true);
    expect(Object.keys(done.metSince)).toEqual(["serious"]);
  });

  it("the descent timer key never reads as a sustained severity", () => {
    expect(sustainedSeverity({ [BAND_DESCENT_KEY_PREFIX + "critical"]: NOW - 1e9 }, wall, NOW)).toBeNull();
  });

  it("a zero hold, or a severity off the ladder, descends at once (pre-19(a) behaviour)", () => {
    const zero = resolveTierLadder(">", 90, "serious", 0, [{ threshold: 95, severity: "critical", actions: [] } as any]);
    expect(bandDescent({ tiers: zero, current: "critical", value: 94, series: null, countsReadings: false, metSince: {}, prevMetSince: null, nowMs: NOW }).due).toBe(true);
    expect(bandDescent({ tiers: counted, current: "error", value: 94, series: [94], countsReadings: true, metSince: {}, prevMetSince: {}, nowMs: NOW }).due).toBe(true);
  });
});
