/**
 * tests/unit/monitorDueSingleSource.test.ts — the pg-boss publisher must not
 * grow its own candidate select or due-check again (CQ-B035).
 *
 * jobs/monitorAssets.ts publishDueWork and monitoringService.computeDueWork
 * used to be "documented-lockstep twins". They drifted three ways in four
 * months (REST FortiAP telemetry, the loss sweep's missing `monitored`, the
 * per-asset overrides), each silently, because a missed comment fails nothing.
 * Both now call loadMonitorPassCandidates + resolveDueCadences; this source
 * guard fails the moment the publisher reads assets or resolves settings on
 * its own.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../../src/jobs/monitorAssets.ts"), "utf8");
// Comments may name the old shape; only code counts.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("monitor due-set has one source", () => {
  it("the publisher loads candidates through the shared loader", () => {
    expect(code).toMatch(/loadMonitorPassCandidates\(\)/);
    expect(code).not.toMatch(/prisma\.asset\.find/);
    expect(code).not.toMatch(/MONITOR_CANDIDATE_WHERE/);
  });

  it("the publisher decides due-ness through resolveDueCadences only", () => {
    expect(code).toMatch(/resolveDueCadences\(/);
    for (const forked of [
      "resolveMonitorSettings", "resolveProbeIntervalSec", "runsHeavyCadences",
      "lossSweepIncludes", "lossSweepIsDue", "sdwanShouldQueue", "responseTimeProbeShouldQueue",
      "function isDue",
    ]) {
      expect(code, forked).not.toContain(forked);
    }
  });
});
