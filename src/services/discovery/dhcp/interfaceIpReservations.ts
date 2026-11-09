/**
 * src/services/discovery/dhcp/interfaceIpReservations.ts — syncDhcpSubnets
 * Phase 4 (CQ-B060; the body moved verbatim, its free variables made
 * parameters).
 *
 * Create reservations for interface IPs (in-memory reservation check). The
 * engine-defined helpers it calls — findSubnetForIp, reservationKey and
 * upsertConflict — are passed in, so this module imports nothing from the
 * engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { upsertConflict as UpsertConflict } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { releaseDnsResolvedAt } from "../../dnsResolvedReservationService.js";

const interfaceRoleLabel = (role: string): string => {
  if (role === "management") return "Management interface";
  if (role === "secondary")  return "Secondary IP";
  return "Interface";
};

export async function reserveInterfaceIps(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey; updated in place. */
  activeResMap: Map<string, any>;
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  upsertConflict: typeof UpsertConflict;
  projectRefLabel: string;
  /** Appended to for the run's summary, as before. */
  reservationNames: string[];
  integrationId: string;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, activeResMap, findSubnetForIp, reservationKey, upsertConflict, projectRefLabel, reservationNames, integrationId, syncLog } = input;

  for (const ifaceIp of result.interfaceIps) {
    if (!ifaceIp.ipAddress) continue;

    const matchingSubnet = findSubnetForIp(ifaceIp.ipAddress);
    if (!matchingSubnet) continue;

    const key = reservationKey(matchingSubnet.id, ifaceIp.ipAddress);
    const noteText = `${interfaceRoleLabel(ifaceIp.role)} (${ifaceIp.interfaceName}) on ${ifaceIp.device}`;
    const existingRes = activeResMap.get(key);
    if (existingRes) {
      if (existingRes.sourceType === "manual") {
        const proposed = { hostname: ifaceIp.device, owner: "network-team", projectRef: projectRefLabel, notes: noteText, sourceType: "interface_ip" };
        await upsertConflict(existingRes.id, integrationId, proposed, existingRes);
      } else if (existingRes.sourceType === "observed") {
        // An observed IPv6 sighting is evidence, never a claim (business rule
        // 125): the gate configuring the address on an interface is the
        // stronger fact, so the row becomes that, in place.
        try {
          const updatedRes = await prisma.reservation.update({
            where: { id: existingRes.id },
            data: { sourceType: "interface_ip", hostname: ifaceIp.device, owner: "network-team", projectRef: projectRefLabel, notes: noteText, expiresAt: null },
          });
          activeResMap.set(key, updatedRes);
        } catch (err: any) {
          syncLog("error", `Failed to convert observed address ${ifaceIp.ipAddress} to an interface IP on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
        }
      }
      continue;
    }

    try {
      await releaseDnsResolvedAt(matchingSubnet.id, ifaceIp.ipAddress);
      const newRes = await prisma.reservation.create({
        data: {
          subnetId: matchingSubnet.id,
          ipAddress: ifaceIp.ipAddress,
          hostname: ifaceIp.device,
          owner: "network-team",
          projectRef: projectRefLabel,
          notes: noteText,
          status: "active",
          sourceType: "interface_ip",
        },
      });
      activeResMap.set(key, newRes);
      reservationNames.push(`${ifaceIp.ipAddress} (${ifaceIp.device}/${ifaceIp.interfaceName})`);
    } catch (err: any) {
      syncLog("error", `Failed to create reservation for interface IP ${ifaceIp.ipAddress} on ${ifaceIp.device}/${ifaceIp.interfaceName}: ${err.message || "Unknown error"}`);
    }
  }
}
