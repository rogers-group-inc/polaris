/**
 * src/services/discovery/dhcp/observedIpv6.ts — syncDhcpSubnets Phase 7c
 * (CQ-B060; the body moved verbatim, its free variables made parameters).
 *
 * Observed IPv6 addresses (business rule 125). An IPv6 client usually assigns
 * itself its address (SLAAC / privacy / static), so no DHCP table lists it —
 * but the gate sees it in use and says so on its device inventory and
 * FortiSwitch detected-device rows. Each such address lands in its IPAM
 * network as an `observed` row: evidence, never a claim. A row of any other
 * source at the address wins untouched (Phases 4 and 5 convert an observed
 * row the gate itself now configures or leases), and expireReservations ages
 * a row out a day after its last sighting. Runs after Phase 7 so the assets
 * it created name the rows they own.
 *
 * Scale: one sighting per client address. Creates are per row (the unique
 * index has to judge each); every refresh shares one expiresAt, so the whole
 * steady state is ONE updateMany per run.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { collectObservedIpv6Sightings, planObservedIpv6 } from "../../../utils/observedIpv6.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/** syncDhcpSubnets' bounded fan-out (its BATCH_SIZE). */
const BATCH_SIZE = 50;

export async function recordObservedIpv6(input: {
  result: DiscoveryResult;
  /** The run's ISO start time. */
  now: string;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey; updated in place. */
  activeResMap: Map<string, any>;
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  assetIdx: AssetIndex;
  projectRefLabel: string;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, now, activeResMap, findSubnetForIp, reservationKey, assetIdx, projectRefLabel, syncLog } = input;
  const nowMs = Date.parse(now);
  const plan = planObservedIpv6({
    sightings: collectObservedIpv6Sightings(result.deviceInventory, result.switchMacTable, nowMs),
    findSubnetId: (ip) => findSubnetForIp(ip)?.id,
    activeRow: (subnetId, ip) => activeResMap.get(reservationKey(subnetId, ip)),
    hostnameForMac: (mac) => assetIdx.findByMac(mac)?.hostname || null,
    nowMs,
  });
  let observedCreated = 0;
  for (const c of plan.creates) {
    try {
      const row = await prisma.reservation.create({
        data: {
          subnetId: c.subnetId,
          ipAddress: c.ip,
          hostname: c.hostname,
          macAddress: c.mac,
          projectRef: projectRefLabel,
          notes: [
            `IPv6 address seen in use on ${c.device} (${c.source === "device-inventory" ? "device inventory" : "FortiSwitch detected device"})`,
            c.mac ? `MAC: ${c.mac}` : null,
          ].filter(Boolean).join(" — "),
          status: "active",
          sourceType: "observed",
          expiresAt: c.expiresAt,
        },
      });
      activeResMap.set(reservationKey(c.subnetId, c.ip), row);
      observedCreated++;
    } catch (err: any) {
      // P2002: something claimed the address mid-run — that row wins.
      if (err?.code !== "P2002") syncLog("error", `Failed to record observed IPv6 address ${c.ip}: ${err.message || "Unknown error"}`);
    }
  }
  if (plan.refresh.ids.length > 0) {
    await prisma.reservation.updateMany({
      where: { id: { in: plan.refresh.ids }, sourceType: "observed", status: "active" },
      data: { expiresAt: plan.refresh.expiresAt },
    });
  }
  if (plan.patches.length > 0) {
    await mapSettledWithConcurrency(plan.patches, BATCH_SIZE, (p) => prisma.reservation.update({ where: { id: p.id }, data: p.data }));
  }
  if (observedCreated > 0 || plan.refresh.ids.length > 0) {
    syncLog(
      "info",
      `Observed IPv6 addresses: ${observedCreated} recorded, ${plan.refresh.ids.length} still in use` +
        (plan.heldByOtherSource > 0 ? `, ${plan.heldByOtherSource} already held by another source` : "") +
        (plan.skippedNoSubnet > 0 ? `, ${plan.skippedNoSubnet} outside every known network` : ""),
    );
  }
}
