/**
 * src/services/discovery/dhcp/staleAuthoritativeRows.ts — syncDhcpSubnets
 * Phase 5b: release the rows a FortiGate is the authority for once the gate
 * stops reporting them — a VIP reservation whose VIP is gone, a stale VIP
 * stamp on a row that owns its address on its own account (rule 77), and a
 * dhcp_reservation the gate's CMDB no longer has. Each sweep is scoped to the
 * gates whose table read this cycle (rules 17, 53). CQ-B060; the body moved
 * verbatim, its free variables made parameters. The engine-defined helpers
 * (findSubnetForIp, reservationKey) are passed in, so this module imports
 * nothing from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { SyncLog } from "../syncLog.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../../db.js";
import { logEvent } from "../../eventLogService.js";

export async function releaseStaleAuthoritativeRows(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index; released rows are deleted from it. */
  activeResMap: Map<string, any>;
  allSubnets: Array<{ id: string; discoveredBy: string | null; fortigateDevice: string | null }>;
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  /** Phase 3c's VIP key sets and the gates whose VIP table read this cycle. */
  currentVipKeys: Set<string>;
  currentVipStampKeys: Set<string>;
  vipQueriedDevices: Set<string>;
  integrationId: string;
  integrationName: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, activeResMap, allSubnets, findSubnetForIp, reservationKey,
    currentVipKeys, currentVipStampKeys, vipQueriedDevices,
    integrationId, integrationName, actor, syncLog,
  } = input;
  const dhcpReservationDevices = new Set<string>(result.dhcpReservationsInventoriedDevices ?? []);
  const stillOnGateKeys = new Set<string>();
  if (Array.isArray(result.dhcpEntries)) {
    for (const e of result.dhcpEntries) {
      if (!e.ipAddress || !dhcpReservationDevices.has(e.device)) continue;
      const s = findSubnetForIp(e.ipAddress);
      if (s) stillOnGateKeys.add(reservationKey(s.id, e.ipAddress));
    }
  }
  // Subnet index by id — used to scope dhcp_reservation cleanup to subnets
  // this integration discovered (and to read fortigateDevice in O(1)).
  const subnetById = new Map<string, any>();
  for (const s of allSubnets) subnetById.set(s.id, s);

  let releasedStaleVips = 0;
  let clearedStaleVipStamps = 0;
  let releasedStaleDhcpReservations = 0;
  for (const [key, row] of activeResMap.entries()) {
    if (!row || row.status !== "active") continue;
    // Stale VIP stamp on a row that owns its address on its own account — a
    // DHCP lease / reservation the VIP arrived on second, or an operator's
    // claim that inherited the snapshot (business rule 77). Only the VIP fact
    // goes; the row keeps its status and every operator field, the same
    // three-way retirement the per-subnet discover applies. Without this
    // branch nothing ever cleared such a stamp: the `vip` sweep below skips
    // these rows, and the per-subnet discover refuses a network no
    // integration discovered — so a claimed address in a hand-built WAN
    // network reported its deleted VIP forever. Scoped to stamps naming a gate
    // whose VIP table read this cycle (rule 17's per-device scoping; an
    // unread table is never "no VIPs", rule 53). Falls through so the
    // dhcp_reservation sweep still judges the row itself.
    if (row.sourceType !== "vip" && row.vipInfo) {
      const stamp = row.vipInfo as any;
      const dev = (typeof stamp?.device === "string" && stamp.device) || "";
      const name = (typeof stamp?.name === "string" && stamp.name) || "";
      if (vipQueriedDevices.has(dev) && !currentVipStampKeys.has(`${dev}|${name}|${key}`)) {
        try {
          await prisma.reservation.update({
            where: { id: row.id },
            data: { vipInfo: Prisma.DbNull },
          });
          row.vipInfo = null;
          clearedStaleVipStamps++;
          logEvent({
            action: "reservation.vip.cleared",
            resourceType: "reservation",
            resourceId: row.id,
            resourceName: row.ipAddress || "",
            actor,
            message: `VIP "${name || "(unknown)"}" no longer on ${dev} — cleared from ${row.sourceType.replace("_", " ")} reservation at ${row.ipAddress || "(subnet)"}`,
            details: {
              integrationId,
              integrationName,
              reservationId: row.id,
              ipAddress: row.ipAddress,
              sourceType: row.sourceType,
              priorVipInfo: stamp,
              fortigateDevice: dev,
            },
          });
        } catch (err: any) {
          syncLog("error", `Failed to clear stale VIP stamp on ${row.ipAddress}: ${err.message || "Unknown error"}`);
        }
      }
    }
    if (row.sourceType === "vip") {
      const dev = ((row.vipInfo as any)?.device) || "";
      if (!vipQueriedDevices.has(dev)) continue;
      if (currentVipKeys.has(key)) continue;
      const priorVipInfo = row.vipInfo as any;
      try {
        // `vipInfo: null` clears the JSON column. Routed through a
        // Record<string, unknown> bag so Prisma's narrow nullable-Json
        // input type doesn't reject — matches the in-place convert path
        // above.
        const vipReleaseData: Record<string, unknown> = { status: "released", vipInfo: null };
        await prisma.reservation.update({
          where: { id: row.id },
          data: vipReleaseData,
        });
        await prisma.conflict.updateMany({
          where: { reservationId: row.id, status: "pending" },
          data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
        });
        activeResMap.delete(key);
        releasedStaleVips++;
        logEvent({
          action: "reservation.vip.released",
          resourceType: "reservation",
          resourceId: row.id,
          resourceName: row.ipAddress || "",
          actor,
          message: `VIP "${priorVipInfo?.name || "(unknown)"}" no longer on ${priorVipInfo?.device || "(unknown)"} — reservation released`,
          details: {
            integrationId,
            integrationName,
            reservationId: row.id,
            ipAddress: row.ipAddress,
            priorVipInfo,
            fortigateDevice: dev,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to release stale VIP reservation ${row.ipAddress}: ${err.message || "Unknown error"}`);
      }
      continue;
    }
    if (row.sourceType === "dhcp_reservation") {
      // Scope: only this integration's own discovered rows. A subnet
      // discovered by a different integration is out of scope even if
      // the FortiGate name happens to coincide.
      if (!row.subnetId) continue;
      const subnet = subnetById.get(row.subnetId);
      if (!subnet || subnet.discoveredBy !== integrationId) continue;
      if (!subnet.fortigateDevice || !dhcpReservationDevices.has(subnet.fortigateDevice)) continue;
      if (stillOnGateKeys.has(key)) continue;
      try {
        await prisma.reservation.update({
          where: { id: row.id },
          data: {
            status: "released",
            // Clear push pointers — the device-side entry is gone (operator
            // deleted on the gate), and any future re-reservation at this
            // IP should make its own push from scratch.
            pushedToId: null,
            pushedScopeId: null,
            pushedEntryId: null,
            pushStatus: null,
          },
        });
        await prisma.conflict.updateMany({
          where: { reservationId: row.id, status: "pending" },
          data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
        });
        activeResMap.delete(key);
        releasedStaleDhcpReservations++;
        logEvent({
          action: "reservation.dhcp_reservation.released",
          resourceType: "reservation",
          resourceId: row.id,
          resourceName: row.ipAddress || "",
          actor,
          message: `DHCP reservation for ${row.ipAddress} no longer on ${subnet.fortigateDevice} — reservation released`,
          details: {
            integrationId,
            integrationName,
            reservationId: row.id,
            ipAddress: row.ipAddress,
            fortigateDevice: subnet.fortigateDevice,
            wasPushedByPolaris: !!row.pushedToId,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to release stale DHCP reservation ${row.ipAddress}: ${err.message || "Unknown error"}`);
      }
    }
  }
  if (releasedStaleVips > 0 || clearedStaleVipStamps > 0 || releasedStaleDhcpReservations > 0) {
    syncLog("info", `Stale-row sweep: released ${releasedStaleVips} VIP reservation(s), cleared ${clearedStaleVipStamps} stale VIP stamp(s), released ${releasedStaleDhcpReservations} DHCP reservation(s)`);
  }
}
