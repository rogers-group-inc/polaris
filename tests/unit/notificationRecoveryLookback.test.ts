/**
 * tests/unit/notificationRecoveryLookback.test.ts
 *
 * A reset that clears after N consecutive recovered readings (`sustainPolls`)
 * counts them off the same fetched series the trigger reads, so the fetch has
 * to be wide enough to hold N of them. Sized from the trigger alone it was not:
 * a 15-poll clear on a 900s window at a one-minute cadence fetched ~15 samples,
 * and whether all 15 landed inside the window depended on the phase between
 * the collector and the engine tick — an SD-WAN packet-loss alert sat for hours
 * at 0% loss (2026-10-08).
 *
 * The DB-bound half is the last cases of tests/integration/pollCountedHolds.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  withRecoveryLookback,
  lookbackMsFor,
  fireLookbackMsFor,
} from "../../src/services/notificationEngine.js";
import type { Trigger, ResetConfig } from "../../src/services/notificationTypes.js";

const MIN = 60_000;
const lossTrigger = {
  type: "asset_metric", metric: "sdwanPacketLoss", operator: ">=", threshold: 20,
  windowSec: 900, aggregation: "avg", forDurationSec: 0,
} as unknown as Trigger;

describe("withRecoveryLookback", () => {
  it("returns the trigger untouched when the reset counts nothing", () => {
    const reset = { mode: "auto", sustainSec: 900 } as ResetConfig;
    expect(withRecoveryLookback(lossTrigger, reset)).toBe(lossTrigger);
  });

  it("widens the fetch to twice the clear's wall-clock mirror", () => {
    const reset = { mode: "auto", sustainSec: 900, sustainPolls: 15 } as ResetConfig;
    expect(lookbackMsFor(withRecoveryLookback(lossTrigger, reset))).toBe(30 * MIN);
  });

  it("never changes the window the aggregate is taken over", () => {
    const reset = { mode: "auto", sustainSec: 900, sustainPolls: 15 } as ResetConfig;
    const t = withRecoveryLookback(lossTrigger, reset);
    expect(fireLookbackMsFor(t)).toBe(fireLookbackMsFor(lossTrigger));
    expect(fireLookbackMsFor(t)).toBe(15 * MIN);
  });

  it("caps the widened fetch at six hours", () => {
    const reset = { mode: "auto", sustainSec: 86_400, sustainPolls: 100 } as ResetConfig;
    expect(lookbackMsFor(withRecoveryLookback(lossTrigger, reset))).toBe(6 * 60 * MIN);
  });

  it("gives a count with no wall-clock mirror the cap rather than a guess", () => {
    const reset = { mode: "auto", sustainPolls: 5 } as ResetConfig;
    expect(lookbackMsFor(withRecoveryLookback(lossTrigger, reset))).toBe(6 * 60 * MIN);
  });

  it("never narrows a fetch that was already wider", () => {
    const wide = { ...lossTrigger, windowSec: 3600 } as unknown as Trigger;
    const reset = { mode: "auto", sustainSec: 120, sustainPolls: 2 } as ResetConfig;
    expect(lookbackMsFor(withRecoveryLookback(wide, reset))).toBe(60 * MIN);
  });

  it("leaves a manual reset alone", () => {
    const reset = { mode: "manual" } as ResetConfig;
    expect(withRecoveryLookback(lossTrigger, reset)).toBe(lossTrigger);
  });
});
