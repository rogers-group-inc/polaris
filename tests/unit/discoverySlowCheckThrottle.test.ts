/**
 * tests/unit/discoverySlowCheckThrottle.test.ts — the slow-run check behind the
 * Integrations page's 4 s /discoveries poll runs at most once per 5 s per
 * process and never twice at once (efficiency audit group 2): N open tabs used
 * to run N checks, and two overlapping ones both logged the slow Event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";

type Engine = typeof import("../../src/services/discovery/discoveryEngine.js");
let engine: Engine;
const listRuns = () => vi.mocked(prisma.discoveryRun.findMany);

beforeEach(async () => {
  vi.useFakeTimers();
  resetDbStub();
  listRuns().mockResolvedValue([] as never);
  vi.resetModules();
  engine = await import("../../src/services/discovery/discoveryEngine.js");
  // A fresh import of discoveryEngine (the throttle's state is module-level)
  // pulls in most of the discovery tree: well past the 10 s default hook
  // timeout under a loaded full-suite run, though ~1 s alone.
}, 60_000);

afterEach(() => vi.useRealTimers());

describe("checkForSlowRunsThrottled", () => {
  it("overlapping callers share one check, and the next waits out the interval", async () => {
    await Promise.all([engine.checkForSlowRunsThrottled(), engine.checkForSlowRunsThrottled(), engine.checkForSlowRunsThrottled()]);
    expect(listRuns()).toHaveBeenCalledTimes(1);
    await engine.checkForSlowRunsThrottled();
    expect(listRuns()).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await engine.checkForSlowRunsThrottled();
    expect(listRuns()).toHaveBeenCalledTimes(2);
  });

  it("the job's call (interval 0) is never throttled, only single-flighted", async () => {
    await engine.checkForSlowRunsThrottled(0);
    await engine.checkForSlowRunsThrottled(0);
    expect(listRuns()).toHaveBeenCalledTimes(2);
    await Promise.all([engine.checkForSlowRunsThrottled(0), engine.checkForSlowRunsThrottled(0)]);
    expect(listRuns()).toHaveBeenCalledTimes(3);
  });
});
