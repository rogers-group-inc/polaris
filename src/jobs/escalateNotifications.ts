/**
 * src/jobs/escalateNotifications.ts
 *
 * Drives the notification escalation sweep every 60s: unhandled notifications
 * of rules with escalation tiers get their due tier emails queued as
 * NotificationDelivery rows (drained by deliverNotifications). Web/all role
 * only (imported under runsSchedulers). Best-effort — a failed tick logs and
 * retries next interval. Modeled on evaluateNotificationRules.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { runEscalationSweep } from "../services/notificationEscalationService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 60 * 1000; // 1 minute

// Boot delay so the DB is ready; offset from the evaluate tick.
defineJob({
  name: "escalateNotifications",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 45_000,
  run: async () => {
    await runEscalationSweep();
  },
});
