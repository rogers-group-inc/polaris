/**
 * src/jobs/discoveryScheduler.ts
 *
 * Scheduled job: runs DHCP discovery for integrations that have autoDiscover
 * enabled, respecting each integration's configured pollInterval (hours).
 * Checks every 15 minutes, starting 5 minutes after the process starts (see
 * STARTUP_GRACE_MS). Import from app.ts to activate.
 *
 * Gate state is persisted on Integration.lastDiscoveryAt so the interval is
 * honoured across application restarts.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { triggerDiscovery, isDiscoveryRunning } from "../services/discovery/discoveryEngine.js";
import { defineJob } from "./_defineJob.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Startup grace: the first check waits this long after the process starts, so
// a service reload or in-app update never lands a discovery on top of boot work
// (migrations, cache warm-up, the first monitor passes, pg-boss start). A
// discovery that is due at startup, or comes due inside the window, simply runs
// at the end of it; lastDiscoveryAt is untouched, so the interval is not reset.
export const STARTUP_GRACE_MS = 5 * 60 * 1000;

async function runScheduledDiscoveries(): Promise<void> {
  let integrations: { id: string; name: string; pollInterval: number; lastDiscoveryAt: Date | null }[];
  try {
    integrations = await prisma.integration.findMany({
      // `type: not llm` — the AI assistant's LLM server has nothing to
      // discover (rule 95); its create path forces autoDiscover off too,
      // this keeps a hand-edited row from reaching triggerDiscovery.
      where: { enabled: true, autoDiscover: true, lastTestOk: true, type: { not: "llm" } },
      select: { id: true, name: true, pollInterval: true, lastDiscoveryAt: true },
    });
  } catch (err) {
    logger.error(err, "Discovery scheduler: failed to query integrations");
    return;
  }

  const now = Date.now();

  for (const intg of integrations) {
    // Due-check FIRST: it is free (two fields already in hand), while
    // isDiscoveryRunning is a query. Asking the DB whether a run is in
    // flight before asking whether one is even wanted meant one round trip
    // per integration per tick, almost always to discard the answer.
    const intervalMs = (intg.pollInterval ?? 12) * 60 * 60 * 1000;
    const lastRun = intg.lastDiscoveryAt?.getTime();
    if (lastRun !== undefined && now - lastRun < intervalMs) continue;

    // .catch(() => false): one integration's failed lookup must not end the
    // pass for every integration after it (defineJob would log the throw, but
    // the rest of the loop would be lost for this tick).
    if (await isDiscoveryRunning(intg.id).catch(() => false)) continue;

    triggerDiscovery(intg.id, "auto-discovery").catch((err) => {
      logger.error({ err, integrationId: intg.id, integrationName: intg.name }, "Discovery scheduler: failed to start discovery");
    });
  }
}

/**
 * Start the discovery scheduler (singleton — runs only in roles with
 * runsSchedulers, i.e. web/all). Fires once STARTUP_GRACE_MS after startup,
 * then every 15 min from there.
 */
export function startDiscoveryScheduler(): void {
  defineJob({
    name: "discoveryScheduler",
    intervalMs: CHECK_INTERVAL_MS,
    firstRunDelayMs: STARTUP_GRACE_MS,
    intervalAfterFirstRun: true,
    run: runScheduledDiscoveries,
  });
}
