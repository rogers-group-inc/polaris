/**
 * tests/unit/probeStillDue.test.ts
 *
 * The pickup re-check that stops a probe job from re-taking a reading an
 * earlier job already took. Two jobs for the same asset (or the same batched
 * ICMP chunk) reach a worker a few seconds apart when the second is published
 * while the first is still ACTIVE, which the stately queue policy allows.
 * Without this check the asset was polled twice per cycle: doubled dots on the
 * response-time chart and two misses per cycle toward `missedPolls`.
 */

import { describe, it, expect } from "vitest";
import { probeStillDue } from "../../src/utils/monitorStatus.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);

describe("probeStillDue", () => {
  it("drops a job whose asset was polled a few seconds ago", () => {
    expect(probeStillDue(secondsAgo(5), 60, NOW)).toBe(false);
  });

  it("runs a job whose asset has not been polled within the interval", () => {
    expect(probeStillDue(secondsAgo(61), 60, NOW)).toBe(true);
  });

  it("uses the publisher's >= boundary: exactly one interval old is due", () => {
    expect(probeStillDue(secondsAgo(60), 60, NOW)).toBe(true);
  });

  it("runs a never-polled asset", () => {
    expect(probeStillDue(null, 60, NOW)).toBe(true);
    expect(probeStillDue(undefined, 60, NOW)).toBe(true);
  });

  it("does not second-guess a job that carries no interval (older payload, Probe Now)", () => {
    expect(probeStillDue(secondsAgo(1), undefined, NOW)).toBe(true);
    expect(probeStillDue(secondsAgo(1), null, NOW)).toBe(true);
    expect(probeStillDue(secondsAgo(1), 0, NOW)).toBe(true);
    expect(probeStillDue(secondsAgo(1), Number.NaN, NOW)).toBe(true);
  });

  it("lets an unflushed probe-patch stamp win over a stale row", () => {
    // The row still says 70s ago (due), but the buffer holds the reading the
    // earlier job just took: the duplicate must be dropped before the flush.
    expect(probeStillDue(secondsAgo(70), 60, NOW, secondsAgo(2))).toBe(false);
  });

  it("uses the row when the pending stamp is older or absent", () => {
    expect(probeStillDue(secondsAgo(3), 60, NOW, secondsAgo(90))).toBe(false);
    expect(probeStillDue(secondsAgo(90), 60, NOW, null)).toBe(true);
  });

  it("honours a dependency-suppressed (doubled) interval", () => {
    expect(probeStillDue(secondsAgo(90), 120, NOW)).toBe(false);
    expect(probeStillDue(secondsAgo(120), 120, NOW)).toBe(true);
  });
});
