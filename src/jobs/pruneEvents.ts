/**
 * src/jobs/pruneEvents.ts
 *
 * Scheduled job: archives then deletes event log entries older than 7 days.
 * Archives are only generated when SFTP/SCP export is configured and enabled.
 * Runs every hour. Import this module from src/index.ts to activate it.
 *
 * Usage in index.ts:
 *   import "./jobs/pruneEvents.js";
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { archiveAndExport, getRetentionSettings } from "../services/eventArchiveService.js";
import { runInstrumentedJob } from "./_metrics.js";
import { pruneAssistantConversations } from "../services/assistantConversationService.js";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function pruneOldEvents(): Promise<void> {
  try {
    await runInstrumentedJob("pruneEvents", async () => {
      const { retentionDays } = await getRetentionSettings();
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // Archive events before pruning (only if export is configured)
      try {
        const archived = await archiveAndExport(cutoff);
        if (archived > 0) {
          logger.info({ archived }, "Archived events before pruning");
        }
      } catch (err) {
        logger.error(err, "Event archive export failed — pruning will still proceed");
      }

      const { count } = await prisma.event.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (count > 0) {
        logger.info({ count, retentionDays }, `Pruned old events (>${retentionDays} days)`);
      }

      // AI assistant conversations idle past their own retention window
      // (business rule 95(e)). Separate try: a failure here must not look
      // like the event prune failed.
      try {
        await pruneAssistantConversations();
      } catch (err) {
        logger.error(err, "Assistant conversation prune failed");
      }
    });
  } catch (err) {
    logger.error(err, "Error running event prune job");
  }
}

// Run once on startup, then every hour
pruneOldEvents();
setInterval(pruneOldEvents, INTERVAL_MS);
