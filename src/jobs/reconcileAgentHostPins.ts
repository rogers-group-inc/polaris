/**
 * src/jobs/reconcileAgentHostPins.ts
 *
 * Business rule 123: an agent host's pinned SSH host key / TLS certificate is
 * archived exactly while its asset is decommissioned. The asset PUT route does
 * that at the moment an operator changes the status; this job does it for every
 * other writer of `Asset.status` — the stale-asset job, the directory and
 * workload decommission sweeps, a scheduled status change, a discovery run that
 * brings an asset back — none of which call the hook.
 *
 * Every 10 minutes. Each pass is bounded (agentHostPinService.reconcileAgentHostPins)
 * and idempotent: an asset whose archive already matches its status stops
 * matching both queries. Scheduler role only — one pass for the fleet.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileAgentHostPins as reconcile } from "../services/agentHostPinService.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 10 * 60 * 1000;

async function reconcileAgentHostPins(): Promise<void> {
  try {
    await runInstrumentedJob("reconcileAgentHostPins", async () => {
      const result = await reconcile();
      if (result.archived > 0 || result.reinstated > 0) {
        logger.info(result, "Reconciled agent host pins with asset status");
      }
    });
  } catch (err) {
    logger.warn({ err }, "reconcileAgentHostPins tick failed (non-fatal)");
  }
}

setTimeout(reconcileAgentHostPins, 2 * 60 * 1000);
setInterval(reconcileAgentHostPins, INTERVAL_MS);
