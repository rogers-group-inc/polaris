/**
 * src/jobs/flagStaleReservations.ts
 *
 * Scheduled job: scans active dhcp_reservation rows for ones whose target
 * client hasn't been seen actively holding the IP within the configured
 * threshold and emits one `reservation.stale` Event per fresh transition.
 * `staleNotifiedAt` is stamped on the row so the alert doesn't refire on
 * subsequent runs; the discovery sync clears `staleNotifiedAt` when it sees
 * the IP active again, so re-arming is automatic.
 *
 * Runs every 6 hours (and once on startup) so the operator's threshold
 * adjustment takes effect within a quarter-day even on infrequently
 * restarted systems. Set `reservation.staleAfterDays` to 0 to disable.
 *
 * Import this module from src/index.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { flagStaleReservations } from "../services/reservationStaleService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Run once on startup (after a short delay so the DB connection is ready),
// then every 6 hours. The startup delay matches the pruneEvents pattern's
// implicit ordering — both jobs import-and-run at module load time.
defineJob({
  name: "flagStaleReservations",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 30_000,
  run: async () => {
    const emitted = await flagStaleReservations();
    if (emitted > 0) {
      logger.info({ emitted }, "Flagged stale DHCP reservations");
    }
  },
});
