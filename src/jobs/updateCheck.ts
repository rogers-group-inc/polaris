/**
 * src/jobs/updateCheck.ts
 *
 * Scheduled job: checks for application updates — weekly via git fetch, or
 * daily against the container registry on a Docker install (no .git tree;
 * see updateService.ts → checkImageForUpdates).
 * The result is stored in the update status so the Database tab can
 * show a notification without the admin clicking "Check for Updates".
 *
 * Usage in app.ts:
 *   import "./jobs/updateCheck.js";
 */

import { checkForUpdates, getUpdateStatus, isImageUpdateMode, updateCheckIntervalMs } from "../services/updateService.js";
import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";

const INTERVAL_MS = updateCheckIntervalMs(); // weekly; daily on a container install

async function runCheck(): Promise<void> {
  try {
    await runInstrumentedJob("updateCheck", async () => {
      const current = getUpdateStatus();

      // Don't overwrite an in-progress update or a completed notification
      if (
        current.state === "applying" ||
        current.state === "restarting" ||
        current.state === "complete" ||
        // A git "available" waits for Apply; an image one is re-checked so a
        // newer push after the first one still moves the version it names.
        (current.state === "available" && !isImageUpdateMode())
      ) {
        return;
      }

      const result = await checkForUpdates();

      if (result.state === "available") {
        logger.info(
          { current: result.currentVersion, latest: result.latestVersion, behind: result.commitsBehind },
          "Application update available"
        );
      } else {
        logger.debug("Update check: up to date");
      }
    });
  } catch (err) {
    logger.error(err, "Failed to check for updates");
  }
}

// First check 60 seconds after startup, then every INTERVAL_MS
setTimeout(runCheck, 60 * 1000);
setInterval(runCheck, INTERVAL_MS);
