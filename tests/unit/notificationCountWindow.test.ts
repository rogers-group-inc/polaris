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
} from "../../src/services/notificationTypes.js";

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
