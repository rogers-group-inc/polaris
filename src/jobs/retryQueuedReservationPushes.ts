/**
 * src/jobs/retryQueuedReservationPushes.ts
 *
 * 60-second reconciler — retries DHCP reservation pushes that landed in the
 * "pending" state because the FortiGate (or FortiManager) was unreachable at
 * create time. The event-driven hook `triggerRetryAfterStatusChange`, fired
 * from monitoringService when a firewall asset transitions to up, is a
 * latency optimization on top of this — the periodic tick catches anything
 * the hook missed (server restart while queued, unmonitored gates, race with
 * concurrent discovery).
 *
 * defineJob (src/jobs/_defineJob.ts) skips a tick while the previous one is
 * still running, and logs a failed tick at error as { err, job }; it never throws.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { retryPendingReservations } from "../services/reservationService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 60 * 1000;

// Delay the first tick 60s after boot so the rest of the app is up and
// monitoring has had a chance to populate Asset.monitorStatus for the
// readiness gate.
defineJob({
  name: "retryQueuedReservationPushes",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 60_000,
  run: async () => {
    const counts = await retryPendingReservations();
    if (counts.attempted > 0) {
      logger.debug(
        counts,
        "retryQueuedReservationPushes tick completed",
      );
    }
  },
});
