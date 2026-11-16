/**
 * tests/unit/ruleModel.test.ts — own unit suite for
 * src/services/notifications/ruleModel.ts (CQ-T010).
 *
 * The lookback windows a trigger needs (business rules 66 and 178), the
 * comparators trigger evaluation shares with band evaluation, the clear-sustain
 * count with its down-detection carve-out (rule 36), and the composite leaf walk.
 * Everything here is pure.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOOKBACK_MS,
  SERIES_CAP,
  lookbackMsFor,
  fireLookbackMsFor,
  withRecoveryLookback,
  timeWindowMs,
  aggregateSinceMs,
  aggregateFallbackSinceMs,
  compareNum,
  compareValue,
  engineSustainPolls,
  collectLeafRefs,
} from "../../src/services/notifications/ruleModel.js";
import { numMeets } from "../../src/services/notificationTypes.js";

const MIN = 60_000;
const CAP = 6 * 60 * MIN;
const NOW = 1_800_000_000_000;

const cpuTrigger = (extra: Record<string, unknown> = {}) =>
  ({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90, ...extra }) as never;
const downTrigger = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never;

describe("constants", () => {
  it("finds the latest sample over 15 minutes and keeps 200 readings per dimension", () => {
    expect(DEFAULT_LOOKBACK_MS).toBe(15 * MIN);
    // A hold is capped at 100 polls; the series must cover the longest one.
    expect(SERIES_CAP).toBeGreaterThanOrEqual(100);
  });
});

describe("fireLookbackMsFor", () => {
  it("is the 15-minute floor for a plain latest trigger", () => {
    expect(fireLookbackMsFor({})).toBe(15 * MIN);
    expect(fireLookbackMsFor({ windowSec: 300, aggregation: "avg" })).toBe(15 * MIN);
  });

  it("widens to the aggregation's own window when that is longer", () => {
    expect(fireLookbackMsFor({ windowSec: 1800, aggregation: "avg" })).toBe(30 * MIN);
  });

  it("covers twice a poll-counted hold's wall-clock mirror", () => {
    expect(fireLookbackMsFor({ forPolls: 10, forDurationSec: 3600 })).toBe(120 * MIN);
  });

  it("never narrows below the floor for a short poll-counted hold", () => {
    expect(fireLookbackMsFor({ forPolls: 3, forDurationSec: 180 })).toBe(15 * MIN);
  });

  it("caps a poll-counted hold at six hours", () => {
    expect(fireLookbackMsFor({ forPolls: 100, forDurationSec: 86_400 })).toBe(CAP);
  });

  it("ignores a wall-clock hold (no forPolls) — the engine times it off its state row", () => {
    expect(fireLookbackMsFor({ forDurationSec: 3600 })).toBe(15 * MIN);
  });

  // Was a bug until 2026-11-14: a poll-counted hold that states the COUNT but no wall-clock mirror
  // ({forPolls: 30}, no forDurationSec — API-authored) fetches only the
  // 15-minute floor, so on a one-minute cadence it can never see 30 readings
  // and never fires. Its siblings in the same file (the count window just
  // above it, and withRecoveryLookback, "same sizing as a poll-counted hold")
  // give a count with no mirror the six-hour cap "rather than a guess".
  // Expected 6 h; actual 15 min.
  it("gives a poll-counted hold with no wall-clock mirror the cap rather than a guess", () => {
    expect(fireLookbackMsFor({ forPolls: 30 })).toBe(CAP);
  });

  describe("a window counted in readings (rule 66)", () => {
    it("fetches twice the group's mirror times the number of groups the hold counts", () => {
      // 4 groups x 600 s x 2 = 80 min.
      expect(fireLookbackMsFor({ windowPolls: 5, aggregation: "avg", windowSec: 600, forPolls: 4 })).toBe(80 * MIN);
    });

    it("treats a count window with no hold as one group, floored at 15 minutes", () => {
      expect(fireLookbackMsFor({ windowPolls: 5, aggregation: "avg", windowSec: 300 })).toBe(15 * MIN);
      expect(fireLookbackMsFor({ windowPolls: 5, aggregation: "avg", windowSec: 1200 })).toBe(40 * MIN);
    });

    it("gives a count window with no wall-clock mirror the full cap", () => {
      expect(fireLookbackMsFor({ windowPolls: 5, aggregation: "avg" })).toBe(CAP);
    });

    it("caps the product at six hours", () => {
      expect(fireLookbackMsFor({ windowPolls: 50, aggregation: "max", windowSec: 3000, forPolls: 20 })).toBe(CAP);
    });

    it("ignores windowPolls on a latest trigger (nothing to measure over)", () => {
      expect(fireLookbackMsFor({ windowPolls: 5, aggregation: "latest", windowSec: 600 })).toBe(15 * MIN);
      expect(fireLookbackMsFor({ windowPolls: 5 })).toBe(15 * MIN);
    });
  });
});

describe("lookbackMsFor", () => {
  it("is the fire lookback when no reset widened it", () => {
    expect(lookbackMsFor({ windowSec: 1800, aggregation: "avg" })).toBe(30 * MIN);
  });

  it("takes the reset's own span when it is wider", () => {
    expect(lookbackMsFor({ recoveryLookbackMs: 45 * MIN })).toBe(45 * MIN);
  });

  it("never narrows the fire lookback for a shorter reset span", () => {
    expect(lookbackMsFor({ windowSec: 1800, aggregation: "avg", recoveryLookbackMs: 5 * MIN })).toBe(30 * MIN);
  });
});

describe("withRecoveryLookback", () => {
  it("returns the very same trigger when there is no reset or it counts nothing", () => {
    const t = cpuTrigger();
    expect(withRecoveryLookback(t, null)).toBe(t);
    expect(withRecoveryLookback(t, undefined)).toBe(t);
    expect(withRecoveryLookback(t, { mode: "auto", sustainSec: 300 } as never)).toBe(t);
  });

  it("stamps twice the mirror for a counted clear, without mutating the input", () => {
    const t = cpuTrigger();
    const out = withRecoveryLookback(t, { mode: "auto", sustainPolls: 10, sustainSec: 600 } as never);
    expect((out as { recoveryLookbackMs?: number }).recoveryLookbackMs).toBe(20 * MIN);
    expect((t as { recoveryLookbackMs?: number }).recoveryLookbackMs).toBeUndefined();
  });

  it("caps the stamped span and gives a mirror-less count the cap", () => {
    const capped = withRecoveryLookback(cpuTrigger(), { mode: "auto", sustainPolls: 10, sustainSec: 86_400 } as never);
    expect((capped as { recoveryLookbackMs?: number }).recoveryLookbackMs).toBe(CAP);
    const bare = withRecoveryLookback(cpuTrigger(), { mode: "auto", sustainPolls: 10, sustainSec: 0 } as never);
    expect((bare as { recoveryLookbackMs?: number }).recoveryLookbackMs).toBe(CAP);
  });

  it("adds nothing for a down rule whose sustain the monitor state machine consumes (rule 36)", () => {
    const out = withRecoveryLookback(downTrigger, { mode: "auto", sustainPolls: 5, sustainSec: 300 } as never);
    expect(out).toBe(downTrigger);
  });
});

describe("timeWindowMs (rule 178)", () => {
  it("is the stated window for a time aggregate", () => {
    expect(timeWindowMs({ windowSec: 300, aggregation: "avg" })).toBe(5 * MIN);
    expect(timeWindowMs({ windowSec: 60, aggregation: "median" })).toBe(MIN);
  });

  it("is 0 for latest, a missing aggregation, a missing or non-positive window, or a count window", () => {
    expect(timeWindowMs({ windowSec: 300, aggregation: "latest" })).toBe(0);
    expect(timeWindowMs({ windowSec: 300 })).toBe(0);
    expect(timeWindowMs({ aggregation: "avg" })).toBe(0);
    expect(timeWindowMs({ windowSec: -5, aggregation: "avg" })).toBe(0);
    expect(timeWindowMs({ windowSec: 300, aggregation: "avg", windowPolls: 5 })).toBe(0);
  });
});

describe("aggregateSinceMs", () => {
  it("bounds a time aggregate to the stated window, not the 15-minute fetch", () => {
    expect(aggregateSinceMs({ windowSec: 300, aggregation: "avg" }, NOW)).toBe(NOW - 5 * MIN);
  });

  it("has no bound when nothing widened the fetch past the fire window", () => {
    expect(aggregateSinceMs({}, NOW)).toBe(-Infinity);
  });

  it("bounds to the fire window when a reset widened the fetch", () => {
    expect(aggregateSinceMs({ recoveryLookbackMs: 60 * MIN }, NOW)).toBe(NOW - 15 * MIN);
  });
});

describe("aggregateFallbackSinceMs", () => {
  it("lets the newest reading stand in, no older than the fire lookback, for a stated window", () => {
    expect(aggregateFallbackSinceMs({ windowSec: 300, aggregation: "avg" }, NOW)).toBe(NOW - 15 * MIN);
    expect(aggregateFallbackSinceMs({ windowSec: 1800, aggregation: "avg" }, NOW)).toBe(NOW - 30 * MIN);
  });

  it("is -Infinity (no stand-in) when no window is stated", () => {
    expect(aggregateFallbackSinceMs({ aggregation: "latest", windowSec: 300 }, NOW)).toBe(-Infinity);
  });
});

describe("compareNum / compareValue", () => {
  it("compareNum is the shared numMeets comparator", () => {
    expect(compareNum).toBe(numMeets);
  });

  it("compares numbers with all six operators and refuses an unknown one", () => {
    expect(compareValue(5, ">", 3)).toBe(true);
    expect(compareValue(3, ">=", 3)).toBe(true);
    expect(compareValue(2, "<", 3)).toBe(true);
    expect(compareValue(3, "<=", 2)).toBe(false);
    expect(compareValue(3, "==", 3)).toBe(true);
    expect(compareValue(3, "!=", 3)).toBe(false);
    expect(compareValue(3, "~", 3)).toBe(false);
  });

  it("never meets on a null reading, whatever the operator", () => {
    expect(compareValue(null, "!=", "down")).toBe(false);
    expect(compareValue(null, "==", 0)).toBe(false);
  });

  it("compares strings and booleans case-insensitively on equality", () => {
    expect(compareValue("DOWN", "==", "down")).toBe(true);
    expect(compareValue("up", "!=", "Down")).toBe(true);
    expect(compareValue(true, "==", "TRUE")).toBe(true);
    expect(compareValue(false, "!=", true)).toBe(true);
  });

  it("falls back to a numeric comparison when both sides coerce", () => {
    expect(compareValue("7", ">", 3)).toBe(true);
    expect(compareValue(5, "<", "10")).toBe(true);
  });

  it("refuses an ordering comparison on text that is not a number", () => {
    expect(compareValue("abc", ">", 1)).toBe(false);
    expect(compareValue("up", "<", "down")).toBe(false);
  });

  it("coerces an empty string to 0 for an ordering comparison (current behaviour)", () => {
    // Number("") is 0, so an empty reading meets ">= 0". Recorded, not endorsed.
    expect(compareValue("", ">=", 0)).toBe(true);
  });
});

describe("engineSustainPolls", () => {
  it("is the reset's counted clear for an ordinary trigger", () => {
    expect(engineSustainPolls({ trigger: cpuTrigger(), reset: { mode: "auto", sustainPolls: 4 } as never })).toBe(4);
    expect(engineSustainPolls({ trigger: cpuTrigger(), reset: { mode: "auto", sustainPolls: 2.6 } as never })).toBe(3);
  });

  it("is 0 when the reset counts nothing", () => {
    expect(engineSustainPolls({ trigger: cpuTrigger(), reset: { mode: "auto", sustainSec: 300 } as never })).toBe(0);
    expect(engineSustainPolls({ trigger: cpuTrigger(), reset: { mode: "auto", sustainPolls: 0 } as never })).toBe(0);
  });

  it("is 0 for a down trigger whose auto-reset hold the monitor state machine serves (rule 36)", () => {
    expect(engineSustainPolls({ trigger: downTrigger, reset: { mode: "auto", sustainPolls: 4 } as never })).toBe(0);
    expect(engineSustainPolls({ trigger: downTrigger, reset: { mode: "auto", sustainSec: 120, sustainPolls: 4 } as never })).toBe(0);
  });

  it("still counts for a down trigger whose reset is a condition reset (not auto)", () => {
    expect(engineSustainPolls({ trigger: downTrigger, reset: { mode: "condition", sustainPolls: 4 } as never })).toBe(4);
  });
});

describe("collectLeafRefs", () => {
  it("assigns tree-path ids to every leaf, depth first", () => {
    const a = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    const b = { type: "asset_metric", metric: "memPct", operator: ">", threshold: 90 };
    const c = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
    const tree = { op: "and", children: [a, { op: "or", children: [b, c] }] };
    const refs = collectLeafRefs(tree as never);
    expect(refs.map((r) => r.leafId)).toEqual(["0", "1.0", "1.1"]);
    expect(refs[1]!.leaf).toBe(b);
  });

  it("returns nothing for a tree with no leaves", () => {
    expect(collectLeafRefs({ children: [] })).toEqual([]);
    expect(collectLeafRefs({ children: [{ op: "and", children: [] }] } as never)).toEqual([]);
  });

  it("honours a prefix", () => {
    const leaf = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 1 };
    expect(collectLeafRefs({ children: [leaf] } as never, "2").map((r) => r.leafId)).toEqual(["2.0"]);
  });
});
