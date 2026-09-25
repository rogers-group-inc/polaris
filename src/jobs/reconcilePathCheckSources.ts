/**
 * src/jobs/reconcilePathCheckSources.ts
 *
 * Every 5 minutes (first tick 45 s after boot) re-resolve every pathCheck
 * check's Sources filter into `path_check_sources`. The write paths
 * (create / edit / enable) reconcile their own check inline; this tick catches
 * everything that changes membership WITHOUT touching a check — an agent
 * enrolled or uninstalled, a host re-tagged, moved subnet, or retyped so a
 * condition tree now matches it (or no longer does).
 *
 * Scheduler role only: one fleet pass, not one per monitor replica. Batched
 * inside reconcilePathCheckSources (one agent query + one source query
 * + a handful of set-based writes), so at 2000 hosts × 50 checks it is ~50
 * scope resolutions per 5 minutes, never a query per host.
 *
 * Import this module from src/app.ts to activate.
 */

import { logger } from "../utils/logger.js";
import { reconcilePathCheckSources } from "../services/pathCheckService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 5 * 60 * 1000;
const BOOT_DELAY_MS = 45 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("pathCheckSources.reconcile", async () => {
      const r = await reconcilePathCheckSources();
      if (r.added || r.removed) {
        logger.info(r, "Path check membership reconciled");
      }
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "pathCheckSources.reconcile tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

setTimeout(tick, BOOT_DELAY_MS);
setInterval(tick, INTERVAL_MS);
