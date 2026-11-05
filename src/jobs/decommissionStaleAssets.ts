/**
 * src/jobs/decommissionStaleAssets.ts
 *
 * Scheduled job: marks assets whose lastSeen is older than the configured
 * inactivity threshold (in months) as decommissioned. Threshold is configured
 * on the Events page → Settings → Assets tab. A value of 0 disables the job.
 *
 * Asset.lastSeen means verified network presence (see bumpLastSeen in
 * src/utils/assetInvariants.ts), so eligibility also consults directory /
 * agent activity on the AssetSource rows: a device that syncs to Intune or
 * logs onto AD (e.g. a remote laptop that never touches the LAN) or whose
 * Polaris Agent is still reporting is alive, not gone — it must not be
 * auto-decommissioned no matter how stale its on-network lastSeen is.
 * Assets with lastSeen = null are never eligible (Prisma `lt` excludes null).
 *
 * Runs every 24 hours. Import from src/app.ts to activate.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getAssetDecommissionSettings } from "../services/eventArchiveService.js";
import { logEventsBatch } from "../services/eventLogService.js";
import { releaseInfraReservationsForAssets } from "../services/reservationService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

defineJob({
  name: "decommissionStaleAssets",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 0,
  run: async () => {
  const { inactivityMonths } = await getAssetDecommissionSettings();
  if (inactivityMonths <= 0) return;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - inactivityMonths);

  const stale = await prisma.asset.findMany({
    where: {
      // maintenance: the window pauses all polling so lastSeen freezes by
      // design — never age a maintenance-window asset into decommission
      // (which would also clamp monitored=false and break the
      // maintenanceScheduler's status restore).
      status: { notIn: ["decommissioned", "disabled", "maintenance"] },
      lastSeen: { lt: cutoff },
      // Recent directory / agent activity vetoes decommission even when
      // on-network presence is stale (cloud-only laptops, agent-reporting
      // hosts the network integrations can't see).
      sources: {
        none: {
          sourceKind: { in: ["entra", "intune", "ad", "polaris-agent"] },
          lastSeen: { gte: cutoff },
        },
      },
    },
    select: { id: true, hostname: true, ipAddress: true, assetType: true },
  });

  if (stale.length === 0) return;

  const ids = stale.map((a) => a.id);
  const result = await prisma.asset.updateMany({
    where: { id: { in: ids } },
    data: { status: "decommissioned", statusChangedAt: new Date(), statusChangedBy: "system" },
  });

  // A managed FortiSwitch/FortiAP aged out of the fleet gives its address
  // back, matching the discovery-side sweeps. Scoped to the two infra types:
  // this job is time-based rather than evidence-based, so it is the least
  // certain of the release triggers and gets the narrowest reach. Bounded and
  // never-throwing inside; a leftover is picked up on the next daily tick.
  const infraIds = stale
    .filter((a) => a.assetType === "switch" || a.assetType === "access_point")
    .map((a) => a.id);
  if (infraIds.length > 0) {
    await releaseInfraReservationsForAssets(infraIds, {
      reason: `auto-decommissioned after ${inactivityMonths} month(s) of inactivity`,
      actor: "system",
    });
  }

  logger.info(
    { count: result.count, inactivityMonths },
    `Auto-decommissioned ${result.count} stale asset(s) (not seen in >${inactivityMonths} month(s))`,
  );

  // One batched insert, awaited. These were fired un-awaited in a loop, so
  // a first run against a neglected install fanned out an unbounded number
  // of concurrent Event creates at once — the bulk updateMany above already
  // rejects that shape for the status write. Awaiting also means the audit
  // rows are durable before the job reports success.
  await logEventsBatch(stale.map((a) => ({
    action: "asset.auto_decommissioned",
    resourceType: "asset",
    resourceId: a.id,
    resourceName: a.hostname || a.ipAddress || undefined,
    actor: "system",
    level: "info" as const,
    message: `Asset "${a.hostname || a.ipAddress || "unknown"}" auto-decommissioned after ${inactivityMonths} month(s) of inactivity`,
  })));
  },
});
