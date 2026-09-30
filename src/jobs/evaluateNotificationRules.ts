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

async function runEvaluateNotificationRules(): Promise<void> {
  try {
    await runInstrumentedJob("evaluateNotificationRules", async () => {
      // Before the rules run, not after: an asset that went dark behind a
      // down parent since the last tick must not carry a live alert through
      // the outage (business rule 16 — maintenance windows are exempt and
      // never retire an alert). Dependency suppression has no edge of its
      // own, so this tick is the only thing that catches it. Best-effort; a
      // failure here must not cost the fleet a tick of evaluation.
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
  }
}

// Boot delay so the DB + first host-metrics sample are ready.
setTimeout(runEvaluateNotificationRules, 30_000);
setInterval(runEvaluateNotificationRules, INTERVAL_MS);
