/**
 * src/jobs/dependencyReconciler.ts
 *
 * 60-second reconciler — source of truth for `Asset.dependencySuppressed`.
 *
 * Loads every monitored asset, evaluates desired suppression state under
 * the all-down multi-parent semantics, writes only diffs, emits
 * `monitor.dependency_suppressed` / `monitor.dependency_resumed` Events
 * for transitions. The event-driven hook
 * `propagateAfterStatusChange` (called from recordProbeResult) is a
 * latency optimization on top of this — the periodic tick catches anything
 * the hook missed (server restart mid-transition, race with concurrent
 * probes, etc.).
 *
 * defineJob (src/jobs/_defineJob.ts) skips a tick while the previous one is
 * still running, and logs a failed tick at error as { err, job }; it never throws.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileDependencySuppression } from "../services/dependencyTreeService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 60 * 1000;

// Skip the very first 60s after boot so monitorAssets.ts has had a chance
// to record at least one probe per asset and get monitorStatus out of the
// "unknown" floor. Without that, every fleet-wide reconciler tick on a
// fresh boot would see "no monitored ancestor is up" and incorrectly
// suppress everything.
defineJob({
  name: "dependencyReconciler",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 60_000,
  run: async () => {
    await reconcileDependencySuppression();
  },
});
