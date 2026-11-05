/**
 * src/jobs/ouiRefresh.ts
 *
 * Scheduled job: refreshes the IEEE OUI (MAC vendor) database weekly.
 * On first startup, downloads the database if it hasn't been fetched yet.
 * Import this module from src/app.ts to activate it.
 *
 * Usage in app.ts:
 *   import "./jobs/ouiRefresh.js";
 */

import { refreshOuiDatabase, getOuiStatus } from "../services/ouiService.js";
import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

// Run once on startup (downloads if missing or stale), then weekly
defineJob({
  name: "ouiRefresh",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 0,
  run: async () => {
    const status = await getOuiStatus();

    // Skip if refreshed within the last 6 days (avoids duplicate refreshes on restart)
    if (status.refreshedAt) {
      const age = Date.now() - new Date(status.refreshedAt).getTime();
      if (age < INTERVAL_MS - 24 * 60 * 60 * 1000) {
        logger.info({ refreshedAt: status.refreshedAt, entries: status.entries }, "OUI database is current — skipping refresh");
        return;
      }
    }

    const result = await refreshOuiDatabase();
    logger.info({ entries: result.entries, sizeKb: result.sizeKb }, "OUI database refreshed");
  },
});
