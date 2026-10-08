/**
 * tests/unit/probeCadence.test.ts
 *
 * `resolveProbeIntervalSec` — the shared probe-spacing decision used by BOTH
 * monitor paths (the cursor pass's computeDueWork and the pg-boss publisher's
 * mirrored due-calc). The two due-sets are contractually identical, so this is
 * the one place the arithmetic is pinned.
 *
 * The response-time poll runs at exactly the configured cadence in every
 * state. There is deliberately NO acceleration while a failure or recovery run
 * is being confirmed — the fast-confirm re-probe was removed 2026-08-19, and
 * extra resolution is the ICMP loss sweep's job (lossSweep.test.ts), which
 * feeds packet-loss statistics only and never the state machine. So
 * time-to-down is `failureThreshold × intervalSeconds`, which is what the
 * monitor-settings card reports.
 *
 * And deliberately NO slow-down under dependency suppression (business rule
 * 38(c), 2026-10-08). A suppressed asset used to be probed at 2× the interval;
 * its own bucket is the count it leaves Dep. Down with, so the half rate made
 * every layer down a chain drain half as fast as the parent above it.
 *
 * Coverage:
 *   - the cadence is returned as configured, so nothing can quietly
 *     re-introduce a mid-run acceleration.
 *   - the function takes no asset state at all, so nothing — suppression
 *     included — can re-introduce a per-asset clamp without changing the
 *     signature this test calls.
 */

import { describe, it, expect } from "vitest";
import { resolveProbeIntervalSec } from "../../src/services/monitoringService.js";

describe("resolveProbeIntervalSec", () => {
  it("returns the configured cadence", () => {
    expect(resolveProbeIntervalSec({ intervalSeconds: 300 })).toBe(300);
    expect(resolveProbeIntervalSec({ intervalSeconds: 60 })).toBe(60);
  });

  it("does not accelerate mid-run — down takes failureThreshold × interval", () => {
    // The counters are not an input at all; every state gets base cadence.
    // Pinned explicitly because re-introducing acceleration here would silently
    // change what `down` means and double-count a miss inside a probe timeout.
    for (const interval of [5, 60, 300]) {
      expect(resolveProbeIntervalSec({ intervalSeconds: interval })).toBe(interval);
    }
  });

  it("does not slow a dependency-suppressed asset (rule 38(c))", () => {
    // The function cannot see suppression any more. Pinned as an arity check so
    // that re-adding an asset parameter — the shape the 2× clamp had — fails here
    // and sends whoever does it to the rule first.
    expect(resolveProbeIntervalSec.length).toBe(1);
  });
});
