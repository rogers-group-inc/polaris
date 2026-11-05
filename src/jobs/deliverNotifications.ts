/**
 * src/jobs/deliverNotifications.ts
 *
 * Drains pending NotificationDelivery rows every ~15s and dispatches them to
 * email / webhook / web-push. Web/all role only (imported under
 * runsSchedulers). Best-effort — a failed tick logs and retries next interval;
 * per-delivery failures are retried (≤3 attempts) by the drain itself.
 *
 * Import this module from src/app.ts (startBackgroundJobs) to activate it.
 */

import { drainPendingDeliveries } from "../services/notificationDeliveryService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 15 * 1000;

// Boot delay so the engine has produced deliveries to drain.
defineJob({
  name: "deliverNotifications",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 35_000,
  run: async () => {
    await drainPendingDeliveries();
  },
});
