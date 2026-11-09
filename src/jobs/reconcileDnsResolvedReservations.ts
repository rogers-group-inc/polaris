/**
 * src/jobs/reconcileDnsResolvedReservations.ts
 *
 * Periodic sweep that reconciles dns_resolved reservations across every Asset
 * with an IP. The Prisma extension hook in src/db.ts handles real-time
 * reconcile on asset writes; this job is the backfill + safety-net for:
 *   - assets that haven't been re-written since the feature shipped
 *   - asset writes whose extension hook lost the fire-and-forget call (crash,
 *     transient DB error)
 *   - subnets that were just created and now contain previously-orphaned IPs
 *   - authoritative reservations released or deleted outside the discovery
 *     sync, which leaves the bare asset IP visible to dns_resolved again
 *
 * Runs 30s after boot and every 30 minutes thereafter.
 */

import { logger } from "../utils/logger.js";
import { reconcileDnsResolvedForAllAssets } from "../services/dnsResolvedReservationService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

defineJob({
  name: "reconcileDnsResolvedReservations",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 30_000,
  run: async () => {
    const counts = await reconcileDnsResolvedForAllAssets();
    if (counts.created > 0 || counts.updated > 0 || counts.released > 0) {
      logger.info(
        { event: "dns_resolved.reconciled", ...counts },
        `Reconciled dns_resolved reservations: created=${counts.created} updated=${counts.updated} released=${counts.released} scanned=${counts.scanned}`,
      );
    }
  },
});
