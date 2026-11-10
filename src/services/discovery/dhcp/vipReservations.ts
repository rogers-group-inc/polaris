/**
 * src/services/discovery/dhcp/vipReservations.ts — syncDhcpSubnets Phase 3c:
 * reserve each FortiGate VIP / Virtual Server address (external, mapped,
 * realserver) in its network, refresh `vipInfo` on rows that already carry
 * the VIP, and stamp rather than conflict a manual row an operator claimed for
 * this same VIP (business rule 77). CQ-B060; the loop moved verbatim, its free
 * variables made parameters. The VIP key sets Phases 5 and 5b read stay in the
 * engine. The engine-defined helpers (findSubnetForIp, reservationKey,
 * upsertConflict) are passed in, so this module imports nothing from the
 * engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { upsertConflict as UpsertConflict } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { releaseDnsResolvedAt } from "../../dnsResolvedReservationService.js";

export async function syncVipReservations(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey; updated in place. */
  activeResMap: Map<string, any>;
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  upsertConflict: typeof UpsertConflict;
  projectRefLabel: string;
  /** Appended to for the run's summary (`vips` count), as before. */
  vipNames: string[];
  integrationId: string;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, activeResMap, findSubnetForIp, reservationKey, upsertConflict, projectRefLabel, vipNames, integrationId, syncLog } = input;

  if (result.vips && result.vips.length > 0) {
    for (const vip of result.vips) {
      const ipsToReserve: Array<{ ip: string; role: "external" | "mapped" | "realserver" }> = [
        { ip: vip.extip, role: "external" },
        ...vip.mappedips.map((ip) => ({ ip, role: "mapped" as const })),
        ...vip.realservers.map((ip) => ({ ip, role: "realserver" as const })),
      ];
      // Load-balance Virtual Servers get their own canonical owner / notes /
      // projectRef so operators can tell a VS (and its realserver pool
      // members) apart from a plain DNAT VIP at a glance. Phase 5's
      // VIP-succession path treats both spellings as canonical placeholders.
      const kindLabel = vip.isVirtualServer ? "Virtual server" : "Firewall VIP";

      for (const { ip, role } of ipsToReserve) {
        const matchingSubnet = findSubnetForIp(ip);
        if (!matchingSubnet) continue;

        const key = reservationKey(matchingSubnet.id, ip);
        const proposedHostname = vip.name;
        // The owner is the VIP / Virtual Server's own name, as the FortiGate
        // config spells it.
        const proposedOwner = vip.name;
        const proposedProjectRef = `${vip.isVirtualServer ? "VS" : "VIP"}: ${vip.device}`;
        const proposedNotes = `${kindLabel} "${vip.name}" (${role}) on ${vip.device} — ext: ${vip.extip}`;

        const existingRes = activeResMap.get(key);
        if (existingRes) {
          if (existingRes.sourceType === "manual") {
            // An operator who reserved a VIP address gets the row STAMPED, not
            // a conflict card. Business rule 77 makes a VIP address claimable
            // and carries its snapshot onto the claim, so a manual row already
            // naming this same VIP is this feature working — raising a card
            // would mean one per claimed VIP per cycle, which is exactly what
            // `reservationBelongsToInfraDevice` exists to prevent on the
            // managed-switch/AP side of the same problem. A manual row naming
            // a DIFFERENT VIP, or none, is an unrelated collision and still
            // raises its card.
            const carried = existingRes.vipInfo as any;
            const claimsThisVip =
              !!carried && carried.name === vip.name && carried.device === vip.device;
            if (claimsThisVip) {
              const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer };
              if (carried.role !== role || carried.extip !== vip.extip || !!carried.isVirtualServer !== vip.isVirtualServer) {
                await prisma.reservation.update({
                  where: { id: existingRes.id },
                  data: { vipInfo: newVipInfo },
                });
                existingRes.vipInfo = newVipInfo;
              }
            } else {
              await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: proposedProjectRef, notes: proposedNotes, sourceType: "vip" }, existingRes);
            }
          } else if (existingRes.sourceType === "vip") {
            // VIP rename (or first vipInfo snapshot) — refresh canonical VIP
            // metadata only. hostname / owner / notes / projectRef are
            // operator-editable via the Reserve modal, so discovery must not
            // overwrite them; the VIP's current name stays visible via the
            // vip badge tooltip rendered from vipInfo.
            const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer };
            const cur = existingRes.vipInfo as any;
            if (!cur || cur.name !== newVipInfo.name || cur.device !== newVipInfo.device || cur.role !== newVipInfo.role || !!cur.isVirtualServer !== newVipInfo.isVirtualServer) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: { vipInfo: newVipInfo },
              });
              existingRes.vipInfo = newVipInfo;
            }
          } else if (existingRes.sourceType === "dhcp_reservation" || existingRes.sourceType === "dhcp_lease") {
            // VIP + DHCP collision (VIP arriving second): same IP is both a
            // DHCP lease/reservation AND a VIP external on the FortiGate.
            // Update vipInfo so the operator sees the VIP badge immediately.
            //
            // VIP metadata takes precedence over the DHCP side's owner /
            // projectRef, so the canonical DHCP-discovery placeholders are
            // overwritten in place rather than offered as a conflict — the
            // mirror of the Phase 5 VIP-succession path, which overwrites
            // canonical VIP placeholders when the VIP goes away. Anything
            // outside that allowlist is operator-owned (or an asset's
            // assignedTo) and survives untouched. The remaining conflict is
            // fill-only: it raises a card solely for fields this row left
            // blank.
            const newVipInfo = { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer };
            const cur = existingRes.vipInfo as any;
            const vipUpdate: Record<string, unknown> = {};
            if (!cur || cur.name !== newVipInfo.name || cur.device !== newVipInfo.device || cur.role !== newVipInfo.role || !!cur.isVirtualServer !== newVipInfo.isVirtualServer) {
              vipUpdate.vipInfo = newVipInfo;
            }
            const isCanonicalDhcpOwner =
              existingRes.owner === "dhcp-lease" || existingRes.owner === "dhcp-reservation";
            if (isCanonicalDhcpOwner && existingRes.owner !== proposedOwner) vipUpdate.owner = proposedOwner;
            if (existingRes.projectRef === projectRefLabel && existingRes.projectRef !== proposedProjectRef) {
              vipUpdate.projectRef = proposedProjectRef;
            }
            if (Object.keys(vipUpdate).length > 0) {
              await prisma.reservation.update({
                where: { id: existingRes.id },
                data: vipUpdate,
              });
              if (vipUpdate.vipInfo) existingRes.vipInfo = newVipInfo;
              if (vipUpdate.owner) existingRes.owner = proposedOwner;
              if (vipUpdate.projectRef) existingRes.projectRef = proposedProjectRef;
            }
            await upsertConflict(
              existingRes.id,
              integrationId,
              { hostname: proposedHostname, owner: proposedOwner, projectRef: proposedProjectRef, notes: proposedNotes, sourceType: "vip" },
              existingRes,
              "fill-only",
            );
          }
          continue;
        }

        try {
          await releaseDnsResolvedAt(matchingSubnet.id, ip);
          // vipInfo stamped at create (not just on the next cycle's refresh
          // branch) so the VIP/VS badge renders and the Phase 5b stale sweep
          // is armed from the row's first cycle.
          const newRes = await prisma.reservation.create({
            data: {
              subnetId: matchingSubnet.id,
              ipAddress: ip,
              hostname: proposedHostname,
              owner: proposedOwner,
              projectRef: proposedProjectRef,
              notes: proposedNotes,
              status: "active",
              sourceType: "vip",
              vipInfo: { name: vip.name, device: vip.device, extip: vip.extip, role, isVirtualServer: vip.isVirtualServer },
            },
          });
          activeResMap.set(key, newRes);
          vipNames.push(`${ip} (${vip.name}/${role})`);
        } catch (err: any) {
          syncLog("error", `Failed to create VIP reservation for ${ip} (${vip.name}): ${err.message || "Unknown error"}`);
        }
      }
    }
    if (vipNames.length > 0) {
      syncLog("info", `VIP sync: created ${vipNames.length} VIP reservation(s)`);
    }
  }
}
