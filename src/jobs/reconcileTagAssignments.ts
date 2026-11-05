/**
 * src/jobs/reconcileTagAssignments.ts
 *
 * Periodic safety net for criteria-based tag auto-assignment.
 *
 * Tag CRUD reconciles inline on every create/edit, end-of-discovery calls
 * reconcileAllTags(), and asset writes reconcile the touched asset — this
 * 6-hour tick is the out-of-band catch for anything those paths missed (a
 * server restart mid-edit, an asset field changed by a path that didn't fire
 * the hook, etc.). Diff-based managed sync: adds the tag to newly matching
 * assets and removes it from drifted ones, but only ever touches engine-owned
 * (provenance-tracked) copies — hand-applied tags are never disturbed.
 *
 * The same tick re-syncs the Arc-owned `azure:` registry rows
 * (syncAzureTagRegistry): a row no asset carries any more is removed. Arc runs
 * and asset deletes already do this inline; the tick catches the rest — an
 * asset merged away, or an Arc integration disabled or deleted, whose runs
 * would otherwise never prune again.
 *
 * defineJob (src/jobs/_defineJob.ts) skips a tick while the previous one is
 * still running, and logs a failed tick at error as { err, job }; it never throws.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileAllTags, syncAzureTagRegistry } from "../services/tagAssignmentService.js";
import { logEvent } from "../services/eventLogService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

defineJob({
  name: "reconcileTagAssignments",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: STARTUP_DELAY_MS,
  run: async () => {
    const summary = await reconcileAllTags();
    const inherited = (summary.networkAdded ?? 0) + (summary.networkRemoved ?? 0) +
      (summary.networkPortsAdded ?? 0) + (summary.networkPortsRemoved ?? 0);
    if (summary.added > 0 || summary.removed > 0 || inherited > 0) {
      logEvent({
        action: "tag.assignments_reconciled",
        resourceType: "tag",
        message: `Periodic tag reconcile: +${summary.added} / -${summary.removed}` +
          (inherited > 0 ? `; network tags on switches +${summary.networkAdded ?? 0} / -${summary.networkRemoved ?? 0}, ports +${summary.networkPortsAdded ?? 0} / -${summary.networkPortsRemoved ?? 0}` : ""),
        details: summary,
      });
    }
    const azure = await syncAzureTagRegistry();
    if (azure.removed > 0) {
      logEvent({
        action: "tag.azure_pruned",
        resourceType: "tag",
        message: `Removed ${azure.removed} Azure tag(s) no asset carries any more`,
        details: azure,
      });
    }
  },
});
