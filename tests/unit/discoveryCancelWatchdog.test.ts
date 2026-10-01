/**
 * tests/unit/discoveryCancelWatchdog.test.ts
 *
 * Coverage for the discovery cancel force-exit backstop:
 *
 *   - never fires when the abort signal never fires
 *   - never fires when the run unwinds (disarm) within the grace window
 *   - fires after grace: Event written, run finalized `aborted`, the run's
 *     pg-boss job released (after the finalize), exit(1)
 *   - arms immediately when the signal is already aborted
 *   - still exits when the pre-exit bookkeeping writes hang (the DB may be
 *     the very thing that's wedged)
 *   - formatStuckDevices renders the diagnostics line
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// discoveryRunState/eventLogService import the Prisma client at module load;
// the watchdog only touches them through its injectable seams in these tests.
vi.mock("../../src/services/discoveryRunState.js", () => ({ finishRun: vi.fn() }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));

import {
  armDiscoveryCancelWatchdog,
  formatStuckDevices,
  CANCEL_FORCE_EXIT_GRACE_MS,
  FORCE_EXIT_CLEANUP_TIMEOUT_MS,
  type CancelWatchdogOptions,
} from "../../src/services/discoveryCancelWatchdog.js";

function makeOpts(overrides: Partial<CancelWatchdogOptions> = {}) {
  const ac = new AbortController();
  const exit = vi.fn();
  const finalizeRun = vi.fn(async () => {});
  const writeEvent = vi.fn(async () => {});
  const calls: string[] = [];
  finalizeRun.mockImplementation(async () => { calls.push("finalize"); });
  const releaseQueueJob = vi.fn(async () => { calls.push("release"); return 1; });
  const opts: CancelWatchdogOptions = {
    integrationId: "int-1",
    integrationName: "Prod FMG",
    actor: "operator",
    signal: ac.signal,
    getActiveDevices: () => [{ name: "COLUMBIA-61F-1", startedAtMs: Date.now() - 5 * 60_000 }],
    finalizeRun: finalizeRun as never,
    writeEvent: writeEvent as never,
    releaseQueueJob: releaseQueueJob as never,
    exit,
    ...overrides,
  };
  return { ac, opts, exit, finalizeRun, writeEvent, releaseQueueJob, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("armDiscoveryCancelWatchdog", () => {
  it("does nothing when the signal never fires", async () => {
    const { opts, exit } = makeOpts();
    const disarm = armDiscoveryCancelWatchdog(opts);
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS * 3);
    expect(exit).not.toHaveBeenCalled();
    disarm();
  });

  it("does not escalate when disarmed within the grace window (clean abort)", async () => {
    const { ac, opts, exit, finalizeRun } = makeOpts();
    const disarm = armDiscoveryCancelWatchdog(opts);
    ac.abort();
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS - 1_000);
    disarm(); // run reached its finally
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS * 2);
    expect(exit).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
  });

  it("escalates after the grace window: event + finalize aborted + exit(1)", async () => {
    const { ac, opts, exit, finalizeRun, writeEvent } = makeOpts();
    armDiscoveryCancelWatchdog(opts);
    ac.abort();
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS);

    expect(writeEvent).toHaveBeenCalledTimes(1);
    const event = writeEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(event.action).toBe("integration.discover.force_exit");
    expect(event.level).toBe("error");
    expect(String(event.message)).toContain("COLUMBIA-61F-1");
    expect(finalizeRun).toHaveBeenCalledWith("int-1", "aborted");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("releases the run's pg-boss job after finalizing the row, before exiting", async () => {
    const { ac, opts, exit, releaseQueueJob, calls } = makeOpts();
    armDiscoveryCancelWatchdog(opts);
    ac.abort();
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS);
    expect(releaseQueueJob).toHaveBeenCalledWith("int-1", expect.stringContaining("force-exited"));
    expect(calls).toEqual(["finalize", "release"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not release the job on a clean abort", async () => {
    const { ac, opts, releaseQueueJob } = makeOpts();
    const disarm = armDiscoveryCancelWatchdog(opts);
    ac.abort();
    disarm();
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS * 2);
    expect(releaseQueueJob).not.toHaveBeenCalled();
  });

  it("starts the grace timer immediately when armed with an already-aborted signal", async () => {
    const { ac, opts, exit } = makeOpts();
    ac.abort();
    armDiscoveryCancelWatchdog(opts);
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("honors a custom graceMs", async () => {
    const { ac, opts, exit } = makeOpts({ graceMs: 10_000 });
    armDiscoveryCancelWatchdog(opts);
    ac.abort();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits when the bookkeeping writes hang (DB is the wedge)", async () => {
    const never = () => new Promise<void>(() => {});
    const { ac, opts, exit } = makeOpts({
      finalizeRun: never as never,
      writeEvent: never as never,
      releaseQueueJob: never as never,
    });
    armDiscoveryCancelWatchdog(opts);
    ac.abort();
    // grace + one cleanup-timeout per hung write (event, finalize, job release)
    await vi.advanceTimersByTimeAsync(
      CANCEL_FORCE_EXIT_GRACE_MS + FORCE_EXIT_CLEANUP_TIMEOUT_MS * 3 - 1,
    );
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still exits when a bookkeeping write rejects", async () => {
    const { ac, opts, exit } = makeOpts({
      finalizeRun: vi.fn(async () => { throw new Error("db down"); }) as never,
      writeEvent: vi.fn(async () => { throw new Error("db down"); }) as never,
      releaseQueueJob: vi.fn(async () => { throw new Error("db down"); }) as never,
    });
    armDiscoveryCancelWatchdog(opts);
    ac.abort();
    await vi.advanceTimersByTimeAsync(CANCEL_FORCE_EXIT_GRACE_MS);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("formatStuckDevices", () => {
  it("renders name + minutes in flight", () => {
    const now = 10 * 60_000;
    const s = formatStuckDevices(
      [
        { name: "GATE-A", startedAtMs: 0 },
        { name: "GATE-B", startedAtMs: 7 * 60_000 },
      ],
      now,
    );
    expect(s).toBe("GATE-A (in flight 10.0 min), GATE-B (in flight 3.0 min)");
  });

  it("explains an empty in-flight list instead of rendering nothing", () => {
    expect(formatStuckDevices([], 0)).toContain("wedged outside the per-device loop");
  });
});
