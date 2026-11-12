/**
 * src/jobs/expireReservations.ts
 *
 * Scheduled job: marks reservations past their `expiresAt` timestamp as expired.
 * Runs every 15 minutes. Import this module from src/index.ts to activate it.
 *
 * Usage in index.ts:
 *   import "./jobs/expireReservations.js";
 */

import { expireStaleReservations, unpushExpiredReservations } from "../services/reservationService.js";
import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Run once immediately on startup, then on a fixed interval
defineJob({
  name: "expireReservations",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 0,
  run: async () => {
    const count = await expireStaleReservations();
    if (count > 0) {
      logger.info({ count }, "Expired stale reservations");
    }
    // Rule 173: the device entries those rows pushed, and any an earlier
    // tick could not reach.
    const unpushed = await unpushExpiredReservations();
    if (unpushed.removed > 0 || unpushed.failed > 0) {
      logger.info(unpushed, "Expired reservations: device entries removed");
    }
  },
});
