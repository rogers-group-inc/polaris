/**
 * src/jobs/reconcilePrimaryIpv6.ts
 *
 * Business rule 127: re-choose every unpinned asset's primary IPv6 from its
 * IPv6 address-list rows (services/primaryIpv6Service.ts →
 * reconcilePrimaryIpv6), and clear the automatic values while IPv6 is off for
 * the install.
 *
 * Why a sweep: the rows come from every interface collector on its own
 * cadence, so no single write is the moment the choice changes. One read of
 * the fleet's IPv6 rows plus a confidence score per 200 assets that have any;
 * a fleet with no IPv6 issues one cheap query. Writes only what changed.
 *
 * Cadence: 10 minutes — the system-info cadence the interface rows ride.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { reconcilePrimaryIpv6 } from "../services/primaryIpv6Service.js";

const INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 120_000;

async function reconcilePrimaryIpv6Job(): Promise<void> {
  try {
    await runInstrumentedJob("reconcilePrimaryIpv6", async () => {
      const result = await reconcilePrimaryIpv6();
      if (result.changed || result.cleared) logger.info(result, "primary IPv6 addresses re-chosen");
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "reconcilePrimaryIpv6 failed");
  }
}

// Delayed first run: let the first interface scrapes land.
setTimeout(reconcilePrimaryIpv6Job, FIRST_RUN_DELAY_MS);
setInterval(reconcilePrimaryIpv6Job, INTERVAL_MS);
