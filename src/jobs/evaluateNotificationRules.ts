/**
 * src/jobs/evaluateNotificationRules.ts
 *
 * Drives the notification rule engine every 60s: threshold/state rules +
 * event-tail. Web/all role only (imported under runsSchedulers). Best-effort —
 * a failed tick logs and retries next interval. Modeled on capacityWatch.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { logger } from "../utils/logger.js";
import { evaluateAllNotificationRules } from "../services/notificationEngine.js";
import { clearSuppressedAlerts, clearExpiredTestAlerts } from "../services/notificationService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Independent re-entrancy guard so a slow tick cannot double-fire.
 *
 * `setInterval` does not wait for the previous run, and a tick that overruns 60
 * seconds — a fleet-wide sweep, a slow database, a storm — would otherwise start
 * a second evaluation in the same process while the first is still writing. Two
 * evaluations racing the same `(rule, asset, dimension)` key can both see it
 * `clear` and both fire it. That has always been possible; grouped alerts
 * (business rule 75) make it VISIBLE, because the artifact is two alerts for one
 * device rather than a duplicate that looks like a retry. The partial unique
 * index `notifications_group_key_live` is the backstop either way — this is the
 * cheap half of the fix, and the same pattern jobs/dependencyReconciler.ts and
 * six others already carry.
 */
let running = false;

async function runEvaluateNotificationRules(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("evaluateNotificationRules", async () => {
      // Before the rules run, not after: an asset that entered suppression
      // since the last tick must not carry a live alert through its
      // maintenance window (business rule 16). The scheduler clears the
      // assets it puts into a window itself, so this is the safety net —
      // and the only thing that catches dependency suppression, which has
      // no edge of its own. Best-effort; a failure here must not cost the
      // fleet a tick of evaluation.
      await clearSuppressedAlerts().catch((err: any) => {
        logger.warn({ err: err?.message }, "clearSuppressedAlerts sweep failed (non-fatal)");
      });
      await evaluateAllNotificationRules();
      // A wizard test alert has no rule and no state row, so no recovery path
      // can ever close it — without this it stays on the device's Alerts tab
      // forever. Sweeps after the rules for the same reason the suppression
      // sweep runs before them: it can never affect what the engine decides.
      await clearExpiredTestAlerts().catch((err: any) => {
        logger.warn({ err: err?.message }, "clearExpiredTestAlerts sweep failed (non-fatal)");
      });
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "evaluateNotificationRules job failed (non-fatal)");
  } finally {
    // In `finally`, not after the try: a throw that escaped the catch above
    // would otherwise leave the flag set and stop evaluation for good.
    running = false;
  }
}

// Boot delay so the DB + first host-metrics sample are ready.
setTimeout(runEvaluateNotificationRules, 30_000);
setInterval(runEvaluateNotificationRules, INTERVAL_MS);
