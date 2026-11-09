/**
 * src/services/discovery/dhcp/arpTables.ts — syncDhcpSubnets Phases 7.5b and
 * 7.6 (CQ-B060: the 5,700-line function is being split phase by phase; the
 * bodies below moved verbatim, their free variables made parameters).
 *
 * 7.5b persists each FortiGate's ARP table; 7.6 turns the same rows into
 * presence evidence for DHCP reservations.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { persistFortigateArpTables } from "../../arpTableService.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import { macHexKeyOrNull } from "../../../utils/mac.js";

/**
 * Phase 7.5b — Persist each FortiGate's ARP table.
 *
 * The same rows Phase 7.5 just mined for empty-`ipAddress` enrichment, kept
 * this time. Before this they were read on every cycle and discarded three
 * times over (enrichment there, presence evidence in 7.6, MAC adoption in
 * 7.7), which left the gate's own answer to "what is at this address"
 * visible nowhere in the UI.
 *
 * Delete-replace is scoped to `arpQueriedDevices` — the gates whose live read
 * ANSWERED — so a proxied read to an offline gate, a missing monitor scope or
 * an aborted run preserves what was stored rather than blanking the tab. In
 * per-device (incremental) mode the result carries one gate, so the scope is
 * naturally that gate alone. Best-effort: a failure here must not poison a
 * run whose real work (subnets, reservations, assets) already landed.
 *
 * No double-write on the finalize pass: the caller's `mode === "full" ||
 * mode === "skip-deprecation"` block already excludes it, so FMG writes each
 * gate's table once as that gate lands and standalone writes once per run.
 */
export async function persistRunArpTables(input: {
  result: DiscoveryResult;
  integrationId: string;
  integrationType: string;
  assetIdx: AssetIndex;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, integrationId, integrationType, assetIdx, syncLog } = input;
  if (isFortinetIntegrationType(integrationType) && (result.arpQueriedDevices?.length ?? 0) > 0) {
    try {
      // Device NAME → serial. The ARP row names its gate the way FortiManager
      // does, and the firewall asset is keyed by serial — resolving through the
      // hostname instead is the mismatch utils/fortinetParentKey.ts exists to
      // prevent.
      const deviceSerials = new Map<string, string>();
      for (const dev of result.devices || []) {
        if (dev?.name && dev?.serial) deviceSerials.set(dev.name, dev.serial);
      }
      const arpResult = await persistFortigateArpTables({
        integrationId,
        rows: result.arpTable || [],
        answeredDevices: result.arpQueriedDevices || [],
        deviceSerials,
        // MAC only — the run's own index, already built and warm.
        matchAssetByMac: (mac) => assetIdx.findByMac(mac)?.id ?? null,
        log: syncLog,
      });
      if (arpResult.unresolvedDevices.length > 0) {
        // Expected on the very first cycle for a gate whose firewall asset is
        // created later in the same run; persistent entries here mean the
        // fortigate-firewall AssetSource never landed.
        syncLog("info", `ARP tables: ${arpResult.unresolvedDevices.length} answering FortiGate(s) had no resolvable firewall asset — skipped`);
      }
    } catch (err: any) {
      syncLog("error", `ARP table persist failed: ${err?.message || "Unknown error"}`);
    }
  }
}

// discoveryEngine.normalizeMacKey's exact contract, without importing the
// engine (which imports this module): hex-only uppercase, "" for none / all-zero.
const normalizeMacKey = (mac: string | null | undefined): string => macHexKeyOrNull(mac) ?? "";

/**
 * Phase 7.6 — ARP presence evidence for DHCP reservations.
 *
 * A FortiGate ARP entry is minutes-fresh L2 proof the device holding a MAC
 * was alive at that IP (FortiOS GCs unreferenced neighbor-cache entries
 * within ~1–5 min). When the table shows a dhcp_reservation's IP bound to
 * its reserved MAC on the owning device, stamp Reservation.lastSeenArp and
 * clear stale-alert state exactly like a live lease does — this is what
 * keeps statically-configured / ICMP-silent devices (which never lease)
 * out of the stale list. MAC match is REQUIRED: the reserved IP answering
 * from a different MAC is not presence of the reserved device. Runs on
 * whatever ARP data this cycle carries — the opt-in arpPresenceSweep
 * toggle only controls the active pre-read cache priming, not whether
 * passively-observed bindings count as evidence. Scoped per (device, ip)
 * so overlapping RFC1918 subnets behind different FortiGates on one FMG
 * can't cross-match.
 */
export async function stampArpPresence(input: {
  result: DiscoveryResult;
  integrationId: string;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, integrationId, syncLog } = input;
  if (result.arpTable && result.arpTable.length > 0) {
    const arpMacByDevIp = new Map<string, string>();
    for (const row of result.arpTable) {
      if (!row.ip || !row.fortigateDevice) continue;
      const macKey = normalizeMacKey(row.mac);
      if (!macKey) continue;
      arpMacByDevIp.set(`${row.fortigateDevice.toLowerCase()}|${row.ip}`, macKey);
    }
    if (arpMacByDevIp.size > 0) {
      const arpDevices = [...new Set(result.arpTable.map((r) => r.fortigateDevice).filter(Boolean))];
      // One indexed query bounded by this device batch's dhcp_reservation
      // count; matching is O(1) map lookups. Safe at 2000+ reservations.
      const arpCandidateRows = await prisma.reservation.findMany({
        where: {
          status: "active",
          sourceType: "dhcp_reservation",
          ipAddress: { not: null },
          macAddress: { not: null },
          subnet: { discoveredBy: integrationId, fortigateDevice: { in: arpDevices } },
        },
        select: { id: true, ipAddress: true, macAddress: true, subnet: { select: { fortigateDevice: true } } },
      });
      const arpConfirmedIds: string[] = [];
      for (const r of arpCandidateRows) {
        const dev = r.subnet.fortigateDevice;
        if (!dev || !r.ipAddress) continue;
        const arpMac = arpMacByDevIp.get(`${dev.toLowerCase()}|${r.ipAddress}`);
        if (!arpMac) continue;
        const resMac = normalizeMacKey(r.macAddress);
        if (resMac && resMac === arpMac) arpConfirmedIds.push(r.id);
      }
      if (arpConfirmedIds.length > 0) {
        // Same re-arm semantics as a live lease: clearing staleNotifiedAt /
        // staleSnoozedUntil lets a row that later goes silent alert cleanly.
        await prisma.reservation.updateMany({
          where: { id: { in: arpConfirmedIds } },
          data: { lastSeenArp: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null },
        });
        syncLog("info", `ARP presence: ${arpConfirmedIds.length} DHCP reservation(s) confirmed live by FortiGate ARP (IP+MAC match)`);
      }
    }
  }
}
