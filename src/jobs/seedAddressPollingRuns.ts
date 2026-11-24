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
 * statement. Runs ONCE per install (marker `seedAddressPollingRunsAt`). It
 * used to run at every boot on the reasoning that, after the first, it only
 * reached assets that have never answered — but finding those still means a
 * 30-day probe-history scan per never-answering monitored asset, which took
 * 13 minutes on prod (2026-11-24) and held `asset_monitor_samples` while the
 * boot-time compression ALTER queued every sample write behind it. After the
 * first run the probe path starts each run on its first success, so a re-run
 * has nothing to add. Deleting the marker row re-runs it.
 *
 * Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { seedPollingRuns } from "../services/addressConfidenceService.js";

/** Marker key — once shipped this must never change. */
const SEED_POLLING_RUNS_MARKER = "seedAddressPollingRunsAt";

async function seedAddressPollingRuns(): Promise<void> {
  try {
    if (await hasRunMarker(SEED_POLLING_RUNS_MARKER)) return;
    // An install that already has polling runs ran this seed on the boots
    // before the marker existed: stamp it without the scan.
    const existing = await prisma.asset.findFirst({ where: { ipConfirmedSince: { not: null } }, select: { id: true } });
    if (existing) {
      await stampRunMarker(SEED_POLLING_RUNS_MARKER, { seeded: 0, skipped: "polling runs already present" });
      return;
    }
    await runInstrumentedJob("seedAddressPollingRuns", async () => {
      const seeded = await seedPollingRuns();
      if (seeded > 0) logger.info({ seeded }, "seeded address-confidence polling runs from probe history");
      await stampRunMarker(SEED_POLLING_RUNS_MARKER, { seeded });
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "seedAddressPollingRuns failed");
  }
}

void seedAddressPollingRuns();
