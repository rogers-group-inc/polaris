/**
 * src/services/monitoring/common.ts — the two helpers every monitoring stream reaches for (CQ-B061, moved verbatim
 * from monitoringService.ts): finish() builds a ProbeResult from a start time, and the
 * per-asset verbose phase spans (monitorPhaseStorage / startPhase) time each step when an
 * asset has verbose monitoring on.
 */

import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../../utils/logger.js";
import { ProbeResult } from "./types.js";

export function finish(startedAt: number, success: boolean, error?: string): ProbeResult {
  const ms = Math.max(0, Math.round(performance.now() - startedAt));
  return success ? { success, responseTimeMs: ms } : { success: false, responseTimeMs: ms, error };
}

// Per-handler verbose-phase tracing. AsyncLocalStorage stashes the asset /
// cadence / verbose flag once at the cadence handler entry; every
// `startPhase(...)` call inside the async chain reads it without needing
// the flag plumbed through every collector signature. Used to diagnose
// where time goes inside a systemInfo handler that gets killed at the
// 300s pg-boss expireInSeconds cap — flip `verboseLogging` on the asset's
// originating integration and the next burst leaves a paper trail of which
// phase took 300s.
//
// `verbose: false` (the default) makes `startPhase` a no-op closure — zero
// per-tick allocation when the flag is off.
interface MonitorPhaseContext {
  assetId: string;
  cadence: "probe" | "telemetry" | "systemInfo" | "fastFiltered";
  verbose: boolean;
}

export const monitorPhaseStorage = new AsyncLocalStorage<MonitorPhaseContext>();

/**
 * Open a phase span. Returns a closer that emits one `monitor.phase` log
 * with elapsed ms + any extras when called. No-op when verbose is off.
 *
 * Always pair `startPhase` with calling the returned closer in a finally
 * block so partial completion (throws mid-phase) still emits.
 */
export function startPhase(name: string): (extras?: Record<string, unknown>) => void {
  const ctx = monitorPhaseStorage.getStore();
  if (!ctx?.verbose) return () => {};
  const startedAt = Date.now();
  const { assetId, cadence } = ctx;
  return (extras?: Record<string, unknown>) => {
    logger.info(
      { verbose: true, phase: name, assetId, cadence, elapsedMs: Date.now() - startedAt, ...(extras ?? {}) },
      "monitor.phase",
    );
  };
}

export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}
