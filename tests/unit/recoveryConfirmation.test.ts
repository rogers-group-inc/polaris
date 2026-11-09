/**
 * tests/unit/recoveryConfirmation.test.ts
 *
 * The RECOVERY CONFIRMATION RUN (business rule 36): a `monitor status is down`
 * automation already decides how many MISSED polls make a device down, and its
 * reset now decides how many RECEIVED polls make it up again.
 *
 * Three pure pieces carry it, and this file covers the two that translate an
 * automation's stored reset into a poll count plus the engine-side consequence.
 * The state machine itself is pinned in monitorStatusStateMachine.test.ts and
 * the strip's replay of it in assetIntermittencyBar.test.ts.
 *
 *   downRecoverySustainSec  — is this reset a recovery count at all?
 *   recoveryPollsFor        — seconds → polls at the asset's own cadence
 *   recoveredMeets          — when the ALERT ends, given the machine already
 *                             served the hold
 */

import { describe, it, expect } from "vitest";
import {
  downRecoverySustainSec,
  downRecoveryConsumesSustain,
  DOWN_ALERT_HOLDING_STATES,
  type Trigger,
  type ResetConfig,
} from "../../src/services/notificationTypes.js";
import { recoveryPollsFor, type DownDetectionVerdict } from "../../src/services/downDetectionService.js";
import { recoveredMeets } from "../../src/services/notificationEngine.js";

/** A verdict whose reset states seconds, not a poll count. */
const secVerdict = (threshold: number, recoverySustainSec: number | null): DownDetectionVerdict =>
  ({ threshold, recoverySustainSec, recoverySustainPolls: null, severity: "warning" });

const downTrigger = {
  type: "asset_state",
  field: "monitorStatus",
  operator: "==",
  value: "down",
  missedPolls: 3,
} as unknown as Trigger;

const cpuTrigger = {
  type: "asset_metric",
  metric: "cpuPct",
  operator: ">=",
  threshold: 90,
} as unknown as Trigger;

const auto = (sustainSec?: number | null): ResetConfig =>
  ({ mode: "auto", sustainSec: sustainSec ?? null }) as ResetConfig;

describe("downRecoverySustainSec — which resets carry a recovery count", () => {
  it("takes an auto reset's hold", () => {
    expect(downRecoverySustainSec({ mode: "auto", sustainSec: 300 })).toBe(300);
  });

  it("is null when the reset clears immediately", () => {
    expect(downRecoverySustainSec({ mode: "auto", sustainSec: 0 })).toBeNull();
    expect(downRecoverySustainSec({ mode: "auto", sustainSec: null })).toBeNull();
    expect(downRecoverySustainSec({ mode: "auto" })).toBeNull();
  });

  it("ignores every other reset mode", () => {
    // manual / timed say nothing about how many probes must answer, and a
    // condition tree is its own recovery authority (business rule 32a) — a
    // poll count layered under it would be a second clock that disagrees.
    for (const mode of ["manual", "timed", "condition", "event"]) {
      expect(downRecoverySustainSec({ mode, sustainSec: 300 })).toBeNull();
    }
  });

  it("survives junk rather than throwing on the index build path", () => {
    for (const junk of [null, undefined, 0, "auto", [], { sustainSec: 300 }]) {
      expect(downRecoverySustainSec(junk)).toBeNull();
    }
  });
});

describe("downRecoveryConsumesSustain — whose sustain the machine served", () => {
  it("is true only for a down trigger with a held auto reset", () => {
    expect(downRecoveryConsumesSustain(downTrigger, auto(300))).toBe(true);
    expect(downRecoveryConsumesSustain(downTrigger, auto(0))).toBe(false);
    expect(downRecoveryConsumesSustain(cpuTrigger, auto(300))).toBe(false);
  });
});

describe("recoveryPollsFor — the stored seconds, at this asset's cadence", () => {
  it("converts back to the polls the wizard collected", () => {
    // The wizard multiplied 5 polls by a 60s cadence to store 300.
    expect(recoveryPollsFor(secVerdict(3, 300), 60)).toBe(5);
  });

  it("re-reads the count at the cadence the asset is ACTUALLY polled at", () => {
    // The stored seconds are frozen at authoring time; the count is not. A rule
    // written against a 60s fleet still means five polls on a device polled
    // every five minutes — it does not silently become one.
    expect(recoveryPollsFor(secVerdict(3, 300), 300)).toBe(3);
    expect(recoveryPollsFor(secVerdict(3, 1500), 300)).toBe(5);
  });

  it("floors at the missed-poll count — the bucket still has to drain", () => {
    // Asking for fewer answers than it took misses cannot make recovery faster:
    // the leaky bucket owes one answer per miss regardless (business rule 30).
    expect(recoveryPollsFor(secVerdict(3, 60), 60)).toBe(3);
    expect(recoveryPollsFor(secVerdict(5, 120), 60)).toBe(5);
  });

  it("is the plain threshold when the automation asks for no hold", () => {
    expect(recoveryPollsFor(secVerdict(3, null), 60)).toBe(3);
  });

  it("rounds rather than ceils, so a ragged cadence returns the operator's number", () => {
    // 5 polls × 45s = 225. At 45s that must read back as 5, and ceil() on a
    // cadence that does not divide evenly would quietly make it 6.
    expect(recoveryPollsFor(secVerdict(3, 225), 45)).toBe(5);
    expect(recoveryPollsFor(secVerdict(3, 220), 45)).toBe(5);
  });

  it("caps at 100, the same ceiling missedPolls carries", () => {
    // A 24h sustain against a 30s cadence would otherwise park an asset in
    // Recovering for 2880 probes.
    expect(recoveryPollsFor(secVerdict(3, 86400), 30)).toBe(100);
  });

  it("falls back to the threshold on a nonsense cadence rather than dividing by zero", () => {
    for (const bad of [0, -60, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recoveryPollsFor(secVerdict(3, 300), bad)).toBe(3);
    }
  });
});

describe("recoveredMeets — when the ALERT ends", () => {
  it("holds the alert through the whole corridor, not just through down", () => {
    // `recovering` is not `down`, so plain !meets would clear the alert on the
    // FIRST answered packet — earlier than it cleared before the count existed,
    // which is the opposite of asking for a longer confirmation run.
    for (const state of DOWN_ALERT_HOLDING_STATES) {
      expect(recoveredMeets(downTrigger, auto(300), state)).toBe(false);
    }
  });

  it("clears when the asset actually reads up", () => {
    expect(recoveredMeets(downTrigger, auto(300), "up")).toBe(true);
  });

  it("clears on a state the automation no longer governs", () => {
    // Passive means no automation covers the device any more; unknown means
    // nothing has been measured. Neither is an outage this alert still owns.
    expect(recoveredMeets(downTrigger, auto(300), "passive")).toBe(true);
    expect(recoveredMeets(downTrigger, auto(300), "unknown")).toBe(true);
    expect(recoveredMeets(downTrigger, auto(300), null)).toBe(true);
  });

  it("leaves a down automation with no hold on the legacy behavior", () => {
    // Nothing consumed a sustain, so recovery is plain !meets and the alert
    // ends the moment the status stops reading down.
    expect(recoveredMeets(downTrigger, auto(0), "recovering")).toBe(true);
    expect(recoveredMeets(downTrigger, auto(0), "down")).toBe(false);
  });

  it("does not touch any other trigger's recovery", () => {
    expect(recoveredMeets(cpuTrigger, auto(300), 95)).toBe(false);
    expect(recoveredMeets(cpuTrigger, auto(300), 10)).toBe(true);
  });
});
