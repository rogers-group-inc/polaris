/**
 * tests/unit/notificationCountWindow.test.ts
 *
 * The pure half of COUNT-WINDOWED aggregation (business rule 66): a measurement
 * window stated as "the last N readings that produced a value" rather than as a
 * span of time, recomputed at every such reading — which is what lets a
 * `forPolls` hold count RECALCULATIONS of the window instead of raw samples.
 *
 * The poll-counted hold these compose with is tests/unit/notificationPollHolds
 * .test.ts; the DB-bound half (does the engine fire on the Nth recalculation?)
 * is tests/integration/pollCountedHolds.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  rollingAggregate,
  triggerWindowPolls,
  leadingRun,
  prepareResponseTimeWindow,
} from "../../src/services/notificationTypes.js";

/** Newest-first probe entries, written the way the cases read: a number is a
 *  successful RTT, `["miss", t]` a failure that waited t ms, `"down"` a failure
 *  that declared the outage. */
type Spec = number | ["miss", number | null] | "down";
const entries = (xs: Spec[]) => xs.map((x) => {
  if (x === "down") return { responseTimeMs: null, timeoutMs: 5000, assetDown: true };
  if (Array.isArray(x)) return { responseTimeMs: null, timeoutMs: x[1], assetDown: false };
  return { responseTimeMs: x, timeoutMs: null, assetDown: false };
});

describe("rollingAggregate", () => {
  it("returns the aggregate at every offset, newest first", () => {
    // [10,20,30,40] with a window of 2 -> avg(10,20), avg(20,30), avg(30,40).
    expect(rollingAggregate([10, 20, 30, 40], 2, "avg")).toEqual([15, 25, 35]);
  });

  it("DROPS misses rather than filling them — the window counts measurements", () => {
    // A failed probe writes a NULL, and for responseTimeMs that is the only
    // thing a NULL can mean. The window is still the last 3 REAL responses, so
    // it reaches further back in wall-clock time instead of averaging fewer
    // samples or inventing a value for the ones that never arrived.
    expect(rollingAggregate([100, null, 200, null, null, 300], 3, "avg")).toEqual([200]);
    // The same three values with no holes give the identical answer. That
    // equality IS the rule: loss changes how long the window spans, never what
    // it measures.
    expect(rollingAggregate([100, 200, 300], 3, "avg")).toEqual([200]);
  });

  it("is EMPTY below a full window — a partial window is a different statistic", () => {
    expect(rollingAggregate([10, 20], 3, "avg")).toEqual([]);
    expect(rollingAggregate([], 3, "avg")).toEqual([]);
    // Holes count against it: two real readings cannot fill a window of three.
    expect(rollingAggregate([10, null, null, 20], 3, "avg")).toEqual([]);
  });

  it("carries every aggregation, and a window of 1 is the raw reading", () => {
    expect(rollingAggregate([10, 20, 30], 3, "min")).toEqual([10]);
    expect(rollingAggregate([10, 20, 30], 3, "max")).toEqual([30]);
    expect(rollingAggregate([10, 20, 90], 3, "median")).toEqual([20]);
    // Even window: the mean of the middle pair, matching utils/stats median.
    expect(rollingAggregate([10, 20, 30, 40], 4, "median")).toEqual([25]);
    expect(rollingAggregate([7, 8, 9], 1, "avg")).toEqual([7, 8, 9]);
    expect(rollingAggregate([7, 8, 9], 1, "latest")).toEqual([7, 8, 9]);
  });

  it("ignores NaN and Infinity the way it ignores a miss", () => {
    expect(rollingAggregate([10, NaN, 20, Infinity, 30], 3, "avg")).toEqual([20]);
  });

  it("smooths a spike a raw-reading hold would have fired on", () => {
    // THE POINT of composing the two. One 1500 ms spike among healthy
    // responses: the raw series HAS a reading over 500, but no 5-sample average
    // clears it, so a hold counted on the rolling series never starts. A time
    // window cannot express this — there the window IS the period and no hold
    // rides on top of it.
    const raw = [120, 130, 1500, 110, 125, 115, 118];
    expect(raw.some((v) => v > 500)).toBe(true);
    const rolled = rollingAggregate(raw, 5, "avg");
    expect(rolled.every((v) => v < 500)).toBe(true);
    expect(leadingRun(rolled, (v) => v > 500)).toBe(0);
    // The window has to be wide enough to absorb it: at 3 samples the same
    // spike clears the line, which is the trade-off the operator is choosing.
    expect(rollingAggregate(raw, 3, "avg")[0]).toBeGreaterThan(500);
  });

  it("counts a SUSTAINED climb, which is what the breach counter is for", () => {
    // Genuinely slow: every 3-sample average is over the line, so the run is
    // the number of recalculations rather than the number of samples.
    const rolled = rollingAggregate([900, 880, 920, 890, 910], 3, "avg");
    expect(rolled).toHaveLength(3);
    expect(leadingRun(rolled, (v) => v > 500)).toBe(3);
  });

  it("is unmoved by loss, which is the whole reason it exists", () => {
    // The Roanoke case that prompted this: ~507 ms responses on a device
    // dropping most of its probes. The time window averaged whatever survived
    // and its denominator shrank with availability; the count window averages
    // the last 3 responses and reads the same number the device would read if
    // it were losing nothing at all.
    const lossy = [520, null, null, null, 500, null, null, 501, null, null, null];
    const clean = [520, 500, 501];
    expect(rollingAggregate(lossy, 3, "avg")[0]).toBeCloseTo(507, 0);
    expect(rollingAggregate(lossy, 3, "avg")[0]).toBe(rollingAggregate(clean, 3, "avg")[0]);
  });
});

describe("prepareResponseTimeWindow", () => {
  it("fills a miss with the timeout it waited — a miss is slow, not absent", () => {
    // The reading a failed probe earns is "at least this long", because that is
    // what the probe actually spent. Dropping it would let a device answering
    // once in ten polls read exactly as fast as one answering every poll.
    expect(prepareResponseTimeWindow(entries([120, ["miss", 5000], 130])))
      .toEqual([120, 5000, 130]);
  });

  it("uses each probe's OWN recorded timeout, not one number for the fleet", () => {
    // Recorded per row at probe time, so a window spanning a settings change
    // reads what each probe actually waited.
    expect(prepareResponseTimeWindow(entries([["miss", 2000], ["miss", 9000]])))
      .toEqual([2000, 9000]);
  });

  it("EXCLUDES a miss with no recorded timeout — a pre-feature row", () => {
    // Rows written before the column existed carry NULL. "Not known" must not
    // become a number, so they read as they always did: not in the window.
    // rollingAggregate drops the nulls.
    expect(prepareResponseTimeWindow(entries([120, ["miss", null], 130])))
      .toEqual([120, null, 130]);
  });

  it("RESETS at the outage — everything at and before a down probe is gone", () => {
    // The timeouts of an outage must not sit in the window for ten polls after
    // the device came back, or a recovered device keeps alerting about the
    // outage the down automation already owns (the rule 29h failure, next door).
    expect(prepareResponseTimeWindow(entries([120, 130, "down", 900, 900, 900])))
      .toEqual([120, 130]);
  });

  it("is EMPTY while the device is still down", () => {
    // The newest probe declared the outage, so there is no post-outage window
    // yet. Downstream that is no reading at all — which is right, because
    // `down` is a different automation's subject for as long as it lasts.
    expect(prepareResponseTimeWindow(entries(["down", "down", 120, 130]))).toEqual([]);
  });

  it("keeps amber misses: only a probe that DECLARED down resets", () => {
    // assetDown is stamped from the status the probe RESULTS in, so a miss
    // below the threshold — amber, not an outage yet — still counts, filled
    // with its timeout. That is the operator's own missedPolls drawing the line
    // between "degraded" and "out", and this follows it.
    expect(prepareResponseTimeWindow(entries([["miss", 5000], ["miss", 5000], 120])))
      .toEqual([5000, 5000, 120]);
  });

  it("composes with the rolling window: an outage leaves too little to read", () => {
    // Two survivors after the reset cannot fill a window of three, so the
    // metric abstains until the device has answered enough times again.
    const prepared = prepareResponseTimeWindow(entries([120, 130, "down", 900, 900, 900, 900]));
    expect(rollingAggregate(prepared, 3, "avg")).toEqual([]);
  });

  it("composes with the rolling window: sustained timeouts DO read slow", () => {
    // The other half of the same rule. A device that is up but timing out on
    // most polls reads near its timeout, which is the truth about it — and is
    // exactly the reading that dropping misses would have hidden.
    const prepared = prepareResponseTimeWindow(entries([["miss", 5000], 500, ["miss", 5000]]));
    expect(rollingAggregate(prepared, 3, "avg")[0]).toBeCloseTo(3500, 0);
  });
});

describe("triggerWindowPolls", () => {
  it("reads a positive count only alongside a real aggregation", () => {
    expect(triggerWindowPolls({ windowPolls: 10, aggregation: "avg" })).toBe(10);
    expect(triggerWindowPolls({ windowPolls: 10, aggregation: "median" })).toBe(10);
    // `latest` has nothing to measure over, so a count on it is not a window.
    expect(triggerWindowPolls({ windowPolls: 10, aggregation: "latest" })).toBe(0);
    expect(triggerWindowPolls({ windowPolls: 10 })).toBe(0);
    expect(triggerWindowPolls({ windowPolls: 0, aggregation: "avg" })).toBe(0);
    expect(triggerWindowPolls({ aggregation: "avg" })).toBe(0);
    expect(triggerWindowPolls(null)).toBe(0);
  });

  it("rounds rather than truncating — half a reading is not a thing", () => {
    expect(triggerWindowPolls({ windowPolls: 2.6, aggregation: "avg" })).toBe(3);
  });
});
