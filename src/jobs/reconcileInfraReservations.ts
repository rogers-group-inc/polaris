/**
 * src/jobs/reconcileInfraReservations.ts
 *
 * Scheduled safety net: releases reservations held by managed FortiSwitches /
 * FortiAPs whose device is decommissioned or no longer present.
 *
 * The lifecycle hooks (Phase 2a controller cascade, Phase 2b stale-infra sweep,
 * the asset DELETE routes, the operator status change, and the auto-decommission
 * job) all release at the moment the device goes away. This job exists for the
 * cases those can't cover: a decommission that happened while the FortiGate was
 * unreachable, rows created before the release path existed, and any future code
 * path that decommissions a device without calling the hook. Without it, those
 * leak a claimed address — and, once auto-push lands, a real orphaned MAC→IP
 * binding on the gate.
 *
 * Every ~6 hours. Deliberately slow: nothing here is urgent, the hooks handle the
 * common cases immediately, and each pass is bounded so a large backlog drains
 * over several ticks rather than fanning out at the gates. Idempotent — a
 * released row stops matching.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileOrphanedInfraReservations } from "../services/reservationService.js";
import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Delayed first run: at boot the discovery integrations haven't necessarily
// synced yet, and "no managed device holds this address" is exactly the state a
// half-populated database is in. Waiting a few minutes keeps the weaker of the
// two release signals from firing on a cold start.
defineJob({
  name: "reconcileInfraReservations",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 5 * 60 * 1000,
  run: async () => {
    const result = await reconcileOrphanedInfraReservations();
    if (result.released > 0 || result.failed > 0) {
      logger.info(result, "Reconciled orphaned managed-device reservations");
    }
  },
});
