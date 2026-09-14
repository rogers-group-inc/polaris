/**
 * src/jobs/reconcileMapRegions.ts
 *
 * Periodic re-evaluation of map-region tags.
 *
 * The CRUD endpoints reconcile inline on every region edit, and end-of-FMG/
 * FortiGate discovery calls the reconciler too — this 6-hour tick is the
 * out-of-band catch for anything those paths missed (server restart mid-edit,
 * a firewall whose coords were updated outside discovery, etc.).
 *
 * **Devices move**, which is the other half of what this tick is for: a gate
 * re-pinned onto the map, a switch repointed to a controller in another region,
 * a subnet re-served by a different gate. `reconcileMapRegions` therefore adds
 * AND removes, bounded by the `RegionTagAssignment` provenance rows — it strips
 * only pairs the service itself tagged, so a hand-applied `region:` tag (and
 * any tag predating provenance) is never destroyed. Renames and deletes still
 * rotate tags wholesale through their own service paths.
 *
 * Independent `running` guard. Failures are logged at debug and never thrown.
 *
 * Import this module from src/app.ts to activate it.
 */

import { logger } from "../utils/logger.js";
import { reconcileMapRegions } from "../services/mapRegionService.js";
import { logEvent } from "../services/eventLogService.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runInstrumentedJob("reconcileMapRegions", async () => {
      const summary = await reconcileMapRegions();
      const sweep = summary.retiredTagSweep;
      // A pass that ONLY swept a retired name touches no membership at all, and
      // is the most interesting pass there is — it means a rename or delete had
      // half-applied and this tick finished it. Gating the Event on
      // assetsTouched alone would have made that invisible.
      const sweptAnything = !!sweep && (sweep.namesSwept.length > 0 || sweep.namesReclaimed.length > 0);
      if (summary.assetsTouched > 0 || summary.subnetsTouched > 0 || sweptAnything) {
        // Report adds and removes separately: a run that only strips tags is a
        // fleet where devices MOVED, which reads very differently from a run
        // that only adds, and one net-zero number would hide both.
        logEvent({
          action: "region.tags_reconciled",
          resourceType: "map-region",
          message:
            `Periodic region reconcile: +${summary.added}/-${summary.removed} on ${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"}, ` +
            `+${summary.subnetsAdded}/-${summary.subnetsRemoved} on ${summary.subnetsTouched} network${summary.subnetsTouched === 1 ? "" : "s"}` +
            // Named, not counted: "1 retired name swept" tells an operator
            // nothing, and this half of the message is the audit trail for a
            // rename or delete that did not finish when it was made.
            (sweep && sweep.namesSwept.length > 0
              ? `; cleaned up tags left by retired region${sweep.namesSwept.length === 1 ? "" : "s"} ` +
                sweep.namesSwept.map((n) => `"${n}"`).join(", ") +
                ` (${sweep.assetTagsStripped} asset${sweep.assetTagsStripped === 1 ? "" : "s"}, ` +
                `${sweep.subnetTagsStripped} network${sweep.subnetTagsStripped === 1 ? "" : "s"})`
              : "") +
            (sweep && sweep.namesReclaimed.length > 0
              ? `; ${sweep.namesReclaimed.map((n) => `"${n}"`).join(", ")} redrawn under the same name, tags left alone`
              : ""),
          details: summary,
        });
      }
    });
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, "reconcileMapRegions tick failed (non-fatal)");
  } finally {
    running = false;
  }
}

setTimeout(tick, STARTUP_DELAY_MS);
setInterval(tick, INTERVAL_MS);
