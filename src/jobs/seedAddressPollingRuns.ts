/**
 * src/jobs/seedAddressPollingRuns.ts
 *
 * One-shot startup job (business rule 103): seeds the address-confidence
 * polling run — Asset.ipConfirmedFor / ipConfirmedSince — from the probe
 * history already on disk, for monitored assets that have none. Without it a
 * device that had answered for months started at zero polling credit, and a
 * FortiAP (no interface table, kept off the address list) read 0 confidence
 * on an address it had been polled on all along.
 *
 * Thin wrapper over `addressConfidenceService.seedPollingRuns()`, one SQL
 * statement. Idempotent and not marker-guarded: it only touches rows whose run
 * is still empty, so after the first boot it reaches only assets that have
 * never answered — and the probe path starts their run on the first success.
 *
 * Import from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { seedPollingRuns } from "../services/addressConfidenceService.js";

async function seedAddressPollingRuns(): Promise<void> {
  try {
    await runInstrumentedJob("seedAddressPollingRuns", async () => {
      const seeded = await seedPollingRuns();
      if (seeded > 0) logger.info({ seeded }, "seeded address-confidence polling runs from probe history");
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "seedAddressPollingRuns failed");
  }
}

void seedAddressPollingRuns();
