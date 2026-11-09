/**
 * src/services/discovery/dhcp/staleMacDeviceStamps.ts — syncDhcpSubnets
 * Phase 7b (CQ-B060: the 5,700-line function is being split phase by phase;
 * the body below moved verbatim, its free variables made parameters).
 *
 * Clear stale `device` stamps on MAC entries. For every FortiGate whose
 * inventory succeeded this run, any MAC stamped with that FortiGate but not
 * seen in the fresh inventory has a stale attribution — clear `device` on
 * that entry. FortiGates whose inventory failed are left alone (no fresh
 * answer to compare against).
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { MacJsonEntry } from "../../../utils/macAddresses.js";
import { reconcileMacAddresses } from "../../macAddressService.js";
import { inventorySightingIsLocal } from "../../../utils/inventoryLocality.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/** syncDhcpSubnets' bounded fan-out (its BATCH_SIZE). */
const BATCH_SIZE = 50;

export async function clearStaleMacDeviceStamps(input: {
  result: DiscoveryResult;
  assetIdx: AssetIndex;
  /** utils/inventoryLocality.buildArpMacDeviceIndex over this run's ARP rows. */
  arpMacDeviceIndex: Set<string>;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, assetIdx, arpMacDeviceIndex, syncLog } = input;
  if (result.inventoryDevices && result.inventoryDevices.length > 0) {
    const refreshedDevices = new Set(result.inventoryDevices);
    // LOCAL rows only: a ZTNA-relayed inventory entry doesn't keep a device
    // stamp alive, so stamps written before the locality gate existed (a dock
    // MAC "on" a gate three sites away) heal here on the next cycle instead
    // of surviving as long as the ZTNA session keeps recurring.
    const seenMacOnDevice = new Set<string>();
    for (const inv of result.deviceInventory || []) {
      if (!inv.macAddress || !inv.device) continue;
      if (!inventorySightingIsLocal(inv, arpMacDeviceIndex)) continue;
      const mac = inv.macAddress.toUpperCase().replace(/-/g, ":");
      seenMacOnDevice.add(`${mac}|${inv.device}`);
    }

    // Stale-device sweep: when a FortiGate previously held a MAC but the
    // refreshed scrape no longer sees it on that device, clear the per-row
    // device stamp so the asset detail panel doesn't keep surfacing a
    // misleading "last seen on FortiGate-X" link. Reconciles directly to
    // the side table — no asset.update needed (only the relation rows
    // change, no scalar columns on Asset).
    const staleSweepReconciles: Array<{ id: string; macs: MacJsonEntry[] }> = [];
    for (const asset of assetIdx.all()) {
      const macs = Array.isArray(asset.macAddresses) ? (asset.macAddresses as any[]) : [];
      if (macs.length === 0) continue;
      let mutated = false;
      for (const m of macs) {
        if (!m.device || !refreshedDevices.has(m.device)) continue;
        const key = `${m.mac}|${m.device}`;
        if (!seenMacOnDevice.has(key)) {
          delete m.device;
          mutated = true;
        }
      }
      if (mutated) {
        staleSweepReconciles.push({ id: asset.id, macs });
        asset.macAddresses = macs;
      }
    }

    if (staleSweepReconciles.length > 0) {
      await mapSettledWithConcurrency(staleSweepReconciles, BATCH_SIZE, (u) => reconcileMacAddresses(u.id, u.macs));
      syncLog("info", `Cleared stale MAC device stamps on ${staleSweepReconciles.length} asset(s) across ${refreshedDevices.size} refreshed FortiGate(s)`);
    }
  }
}
