/**
 * src/jobs/runAutomationScripts.ts
 *
 * Executes pending server-side AutomationScriptRun rows every ~5s (claim →
 * execFile with timeout/output caps → record + audit Event) and sweeps
 * stuck/aged rows. Web/all role only (imported under runsSchedulers) — the
 * same singleton posture as deliverNotifications, and the reason script
 * actions never execute inline in the engine or the delivery drain.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { runPendingServerScripts } from "../services/automationScriptRunner.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 5 * 1000;
// Boot delay so the engine has had a chance to enqueue runs. defineJob's
// overlap skip is what keeps a long script from stacking ticks.
defineJob({
  name: "runAutomationScripts",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 40_000,
  run: async () => {
    await runPendingServerScripts();
  },
});
