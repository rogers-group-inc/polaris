/**
 * tests/unit/monitorStatus.test.ts
 *
 * The monitor state vocabulary and its pure predicates (business rule 30's
 * leaky bucket with the 2026-09-01 lock). Sibling files cover the heavy
 * cadence gate, last-known links (rule 144), probeStillDue and the status
 * Event decision; monitorStatusStateMachine.test.ts drives the service. This
 * pins the labels, the bucket cap, the bucket step and the state verdict
 * directly.
 */

import { describe, it, expect } from "vitest";
import {
  MONITOR_STATUS_LABELS,
  monitorStatusLabel,
  MAX_MISSED_POLL_BUCKET,
  bucketCapFor,
  nextFailureBucket,
  monitorStatusFor,
  isConfigStatusEdge,
  statusEventDecision,
  type MonitorStatus,
} from "../../src/utils/monitorStatus.js";

describe("monitorStatusLabel", () => {
  it("names warning 'Missed' and unknown 'Pending'", () => {
    expect(MONITOR_STATUS_LABELS).toEqual({ up: "Up", warning: "Missed", recovering: "Recovering", down: "Down", unknown: "Pending", passive: "Passive" });
    expect(monitorStatusLabel("warning")).toBe("Missed");
  });

  it("reads absent as Pending and passes an unrecognized value through", () => {
    expect(monitorStatusLabel(null)).toBe("Pending");
    expect(monitorStatusLabel(undefined)).toBe("Pending");
    expect(monitorStatusLabel("")).toBe("Pending");
    expect(monitorStatusLabel("maintenance")).toBe("maintenance");
  });

  // Was a bug until 2026-11-12 (CQ-T012): the plain-object lookup answered inherited members.
  it("passes an Object.prototype member name through as itself", () => {
    expect(monitorStatusLabel("toString")).toBe("toString");
  });
});

describe("bucketCapFor", () => {
  it("is the larger of the down threshold and the recovery count", () => {
    expect(bucketCapFor(3, 5)).toBe(5);
    expect(bucketCapFor(5, 2)).toBe(5);
    expect(bucketCapFor(3, 0)).toBe(3);
  });

  it("ignores a junk recovery count and floors a fractional one", () => {
    expect(bucketCapFor(3, NaN)).toBe(3);
    expect(bucketCapFor(3, -4)).toBe(3);
    expect(bucketCapFor(2, 4.9)).toBe(4);
  });

  it("is the absolute ceiling for a passive asset and never exceeds it", () => {
    expect(bucketCapFor(null, 5)).toBe(MAX_MISSED_POLL_BUCKET);
    expect(bucketCapFor(500, 1)).toBe(MAX_MISSED_POLL_BUCKET);
    expect(bucketCapFor(3, 1000)).toBe(MAX_MISSED_POLL_BUCKET);
    expect(MAX_MISSED_POLL_BUCKET).toBe(100);
  });
});

describe("nextFailureBucket", () => {
  it("a miss adds one below the threshold; an answer takes one back, floored at 0", () => {
    expect(nextFailureBucket(0, false, 3, 1)).toBe(1);
    expect(nextFailureBucket(1, false, 3, 1)).toBe(2);
    expect(nextFailureBucket(2, true, 3, 1)).toBe(1);
    expect(nextFailureBucket(0, true, 3, 1)).toBe(0);
  });

  it("jumps to the cap on the verdict miss and stays there (down after 3, up after 5)", () => {
    expect(nextFailureBucket(2, false, 3, 5)).toBe(5);
    expect(nextFailureBucket(5, false, 3, 5)).toBe(5);
  });

  it("recovery costs exactly the cap however long the outage ran", () => {
    let cf = 0;
    for (let i = 0; i < 500; i++) cf = nextFailureBucket(cf, false, 3, 5);
    expect(cf).toBe(5);
    let answers = 0;
    while (cf > 0) { cf = nextFailureBucket(cf, true, 3, 5); answers++; }
    expect(answers).toBe(5);
  });

  it("clamps a stored level above the cap on the next answer, and treats junk input as 0", () => {
    expect(nextFailureBucket(480, true, 3, 1)).toBe(2);
    expect(nextFailureBucket(-7, false, 3, 1)).toBe(1);
    expect(nextFailureBucket(NaN, false, 3, 1)).toBe(1);
  });

  it("a passive asset's bucket still moves, capped at the constant and never locked", () => {
    expect(nextFailureBucket(0, false, null, 1)).toBe(1);
    expect(nextFailureBucket(99, false, null, 1)).toBe(100);
    expect(nextFailureBucket(100, false, null, 1)).toBe(100);
  });
});

describe("monitorStatusFor", () => {
  it("passive without a threshold, whatever happened", () => {
    expect(monitorStatusFor(0, true, null)).toBe("passive");
    expect(monitorStatusFor(50, false, null)).toBe("passive");
  });

  it("up when the bucket is empty, recovering on any answer with misses outstanding", () => {
    expect(monitorStatusFor(0, false, 3)).toBe("up");
    expect(monitorStatusFor(0, true, 3)).toBe("up");
    expect(monitorStatusFor(5, true, 3)).toBe("recovering");
    expect(monitorStatusFor(1, true, 3)).toBe("recovering");
  });

  it("a miss reads down at or above the threshold, warning below it", () => {
    expect(monitorStatusFor(3, false, 3)).toBe("down");
    expect(monitorStatusFor(2, false, 3)).toBe("warning");
    expect(monitorStatusFor(-1, false, 3)).toBe("up");
  });

  it("walks a full outage: up → warning → down → recovering → up", () => {
    const thr = 2, rec = 3;
    let cf = 0;
    const seen: MonitorStatus[] = [];
    for (const ok of [false, false, false, true, true, true]) {
      cf = nextFailureBucket(cf, ok, thr, rec);
      seen.push(monitorStatusFor(cf, ok, thr));
    }
    expect(seen).toEqual(["warning", "down", "down", "recovering", "recovering", "up"]);
  });
});

describe("isConfigStatusEdge", () => {
  it("is true only when passive is entered or left", () => {
    expect(isConfigStatusEdge("passive", "up")).toBe(true);
    expect(isConfigStatusEdge("down", "passive")).toBe(true);
    expect(isConfigStatusEdge("down", "up")).toBe(false);
    expect(isConfigStatusEdge(null, "down")).toBe(false);
  });

  it("makes statusEventDecision skip the passive edge", () => {
    expect(statusEventDecision("passive", "down")).toBe("skip");
    expect(statusEventDecision("down", "passive")).toBe("skip");
  });
});
