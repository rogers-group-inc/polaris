/**
 * src/services/discovery/dhcp/switchArpEnrichment.ts — syncDhcpSubnets Phase
 * 7.5: enrich existing assets from the FortiSwitch MAC table and FortiGate ARP
 * (switch-port attribution, an empty or ladder-beaten `ipAddress`), then
 * reconcile the per-MAC address list (business rule 102). CQ-B060; the body
 * moved verbatim, its free variables made parameters. Imports nothing from the
 * engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { ChangeBaselineFields } from "./changeEvents.js";
import type { MacJsonEntry } from "../../../utils/macAddresses.js";
import { prisma } from "../../../db.js";
import { scoreAddressClaim, claimBeats, claimMedium, type DhcpClaimState } from "../../../utils/dhcpClaimFreshness.js";
import { reconcileDiscoveredAddresses, type AddressSighting } from "../../assetAddressService.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/**
 * Phase 7.5 — non-asset-creating. Stamps `lastSeenSwitch` from the
 * lowest-rank (fewest-MAC) port per asset, fills or ladder-moves `ipAddress`
 * from ARP (business rule 101), records every ARP binding as an address
 * sighting, and replaces each read gate's discovered address-list rows. Mutates
 * the indexed assets, `claims`, `addressSightings` and
 * `fortigateEndpointAssetIds`, as before.
 */
export async function enrichFromSwitchMacAndArp(input: {
  result: DiscoveryResult;
  now: string;
  assetIdx: AssetIndex;
  claims: DhcpClaimState;
  addressSightings: AddressSighting[];
  fortigateEndpointAssetIds: Set<string>;
  noteChangeBaseline: (asset: any, fields: ChangeBaselineFields[]) => void;
  noteEndpointGate: (assetId: string, device: unknown) => void;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, now, assetIdx, claims, addressSightings, fortigateEndpointAssetIds,
    noteChangeBaseline, noteEndpointGate, syncLog,
  } = input;
  if ((result.switchMacTable && result.switchMacTable.length > 0) ||
      (result.arpTable && result.arpTable.length > 0)) {
    const enrichmentUpdates = new Map<string, Record<string, unknown>>();

    const queueUpdate = (assetId: string, data: Record<string, unknown>) => {
      const existing = enrichmentUpdates.get(assetId);
      enrichmentUpdates.set(assetId, existing ? { ...existing, ...data } : data);
    };

    // Switch-port enrichment with port-rank attribution.
    //
    // The same MAC commonly appears on multiple switch ports because
    // FortiSwitches learn it on every port that observed traffic from the
    // device — typically the access port the device is plugged into AND
    // every upstream trunk between that switch and the FortiGate. Stamping
    // the LAST row seen would put endpoints on whichever upstream port
    // happened to come last in the iteration, which is wrong. Instead we
    // rank ports by their MAC count (cardinality of unique MACs learned
    // on the port across the whole site) and pick the LOWEST-rank port
    // for each asset — fewer MACs = closer to the leaf = real attachment
    // point. An access port with one device sees 1 MAC; an uplink trunk
    // with 50 devices behind it sees 50. `isFortilinkPeer` rows are
    // filtered out earlier as a separate "this is a FortiLink uplink"
    // signal, but the rank logic catches every other trunk-vs-access
    // ambiguity uniformly.
    const portMacCounts = new Map<string /* switchId/port */, Set<string /* mac */>>();
    for (const row of result.switchMacTable || []) {
      if (row.isFortilinkPeer) continue;
      if (!row.mac || !row.switchId || !row.portName) continue;
      const portKey = `${row.switchId}/${row.portName}`;
      let bucket = portMacCounts.get(portKey);
      if (!bucket) { bucket = new Set(); portMacCounts.set(portKey, bucket); }
      bucket.add(row.mac.toUpperCase());
    }
    // Walk again, picking the lowest-rank port per asset. lastSeen-style
    // tiebreaker isn't applied — when two ports tie, the first to win
    // sticks (deterministic from row order).
    const assetBestPort = new Map<string /* assetId */, { portLabel: string; rank: number; fortigateDevice: string }>();
    for (const row of result.switchMacTable || []) {
      if (row.isFortilinkPeer) continue;
      if (!row.mac || !row.switchId || !row.portName) continue;
      const asset = assetIdx.findByMac(row.mac);
      if (!asset) continue;
      // Skip Fortinet infrastructure assets — their topology already lives
      // on `fortinetTopology` (parentSwitch/parentPort for APs, FortiLink
      // uplinkInterface for switches). Stamping lastSeenSwitch on a
      // managed switch or FortiGate would conflate roles.
      if (asset.assetType === "switch" || asset.assetType === "firewall") continue;
      const portLabel = `${row.switchId}/${row.portName}`;
      const rank = portMacCounts.get(portLabel)?.size ?? 1;
      const best = assetBestPort.get(asset.id);
      if (!best || rank < best.rank) {
        assetBestPort.set(asset.id, { portLabel, rank, fortigateDevice: row.fortigateDevice || "" });
      }
    }
    for (const [assetId, pick] of assetBestPort) {
      const asset = assetIdx.findById(assetId);
      if (!asset) continue;
      if (asset.lastSeenSwitch !== pick.portLabel) {
        noteChangeBaseline(asset, ["lastSeenSwitch"]);
        queueUpdate(assetId, { lastSeenSwitch: pick.portLabel });
        asset.lastSeenSwitch = pick.portLabel;
      }
      // Switch-port attribution counts as a fortigate-endpoint touch
      // even when no DHCP sighting fired — the asset was seen on a
      // managed switch's port.
      if (asset.assetType !== "firewall" && asset.assetType !== "switch" && asset.assetType !== "access_point") {
        fortigateEndpointAssetIds.add(asset.id);
        // The switch's own controller gate — the MAC-table row carries it, so
        // a switch-port-only touch still names a real FortiGate rather than
        // leaving the flush to guess.
        noteEndpointGate(asset.id, pick.fortigateDevice);
      }
    }

    // ARP — fills an empty ipAddress, and stakes a CLAIM on the shared address
    // ladder (business rule 101): the gate currently resolves this address to
    // the MAC. A card with secondary addresses has several ARP rows, and they
    // tie — so:
    //   • the row for the asset's CURRENT address stakes its claim first, and
    //     a sibling must strictly beat it. Equal ARP claims therefore leave the
    //     asset where it is; the one thing that lifts a sibling is a DHCP
    //     reservation configured for that MAC at that address (`reserved`) —
    //     the address somebody chose for the card;
    //   • ARP only overrules an address THIS RUN's DHCP / detected-device
    //     claims decided (an incumbent on the ladder before this pass). An
    //     address that came from elsewhere — vCenter, Arc, an operator — has
    //     no ladder claim and is not ARP's to take.
    const reservedIpsByMac = new Map<string, Set<string>>();
    for (const e of result.dhcpEntries || []) {
      if (e.type !== "dhcp-reservation" || !e.macAddress || !e.ipAddress) continue;
      const m = e.macAddress.toUpperCase().replace(/-/g, ":");
      const set = reservedIpsByMac.get(m) ?? new Set<string>();
      set.add(e.ipAddress);
      reservedIpsByMac.set(m, set);
    }
    const arpRowsByAsset = new Map<string, Array<{ mac: string; ip: string; device: string }>>();
    for (const row of result.arpTable || []) {
      if (!row.mac || !row.ip || !row.fortigateDevice) continue;
      const a = assetIdx.findByMac(row.mac);
      if (!a || a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point") continue;
      const list = arpRowsByAsset.get(a.id) ?? [];
      list.push({ mac: String(row.mac).toUpperCase().replace(/-/g, ":"), ip: row.ip, device: row.fortigateDevice });
      arpRowsByAsset.set(a.id, list);
    }
    const arpNowMs = Date.parse(now);
    for (const [arpAssetId, arpRows] of arpRowsByAsset) {
      const asset = assetIdx.findById(arpAssetId);
      if (!asset || !asset.ipAddress) continue;
      const hadLadderClaim = claims.bestAddressClaimByAsset.has(arpAssetId);
      const standing = asset.ipAddress;
      const ordered = [...arpRows].sort((x, y) => Number(y.ip === standing) - Number(x.ip === standing));
      for (const row of ordered) {
        const arpMacEntry = Array.isArray(asset.macAddresses)
          ? (asset.macAddresses as MacJsonEntry[]).find((m) => m.mac === row.mac)
          : undefined;
        const arpScore = scoreAddressClaim({
          kind: "arp", current: true, seenMs: arpNowMs,
          medium: claimMedium({ macSource: arpMacEntry?.source }),
          reserved: !!reservedIpsByMac.get(row.mac)?.has(row.ip),
        }, arpNowMs);
        const incumbent = claims.bestAddressClaimByAsset.get(arpAssetId);
        if (row.ip === asset.ipAddress) {
          // ARP confirms the standing address — recorded so a weaker claim
          // iterated later can't take it.
          if (!incumbent || claimBeats(arpScore, incumbent)) claims.bestAddressClaimByAsset.set(arpAssetId, arpScore);
        } else if (hadLadderClaim && incumbent && claimBeats(arpScore, incumbent)) {
          claims.bestAddressClaimByAsset.set(arpAssetId, arpScore);
          queueUpdate(arpAssetId, { ipAddress: row.ip, ipSource: `${row.device}:arp`, learnedLocation: row.device });
          asset.ipAddress = row.ip;
          asset.learnedLocation = row.device;
          assetIdx.reindex(asset);
          fortigateEndpointAssetIds.add(arpAssetId);
          noteEndpointGate(arpAssetId, row.device);
        }
      }
    }
    for (const row of result.arpTable || []) {
      if (!row.mac || !row.ip) continue;
      const asset = assetIdx.findByMac(row.mac);
      if (!asset) continue;
      // Every ARP binding is a current address for that MAC — one row each,
      // which is how a card's SECONDARY addresses reach the asset's address
      // list (business rule 102). Infra keeps its own interface table.
      if (row.fortigateDevice && asset.assetType !== "firewall" && asset.assetType !== "switch" && asset.assetType !== "access_point") {
        addressSightings.push({
          assetId: asset.id, mac: String(row.mac).toUpperCase().replace(/-/g, ":"), ip: row.ip, source: "arp",
          device: row.fortigateDevice, seenAt: new Date(now),
        });
      }
      if (asset.ipAddress) continue; // conservative: don't overwrite
      queueUpdate(asset.id, { ipAddress: row.ip, ipSource: `${row.fortigateDevice}:arp` });
      asset.ipAddress = row.ip;
      assetIdx.reindex(asset);
      if (asset.assetType !== "firewall" && asset.assetType !== "switch" && asset.assetType !== "access_point") {
        fortigateEndpointAssetIds.add(asset.id);
        noteEndpointGate(asset.id, row.fortigateDevice);
      }
    }

    if (enrichmentUpdates.size > 0) {
      const updates = Array.from(enrichmentUpdates, ([id, data]) => ({ id, data }));
      const results = await mapSettledWithConcurrency(updates, 50, (u) =>
        prisma.asset.update({ where: { id: u.id }, data: u.data })
      );
      let okCount = 0;
      for (const r of results) if (r.status === "fulfilled") okCount++;
      syncLog("info", `Enriched ${okCount} asset(s) from FortiSwitch macmap + FortiGate ARP (switch-port + IP)`);
    }
  }

  // ── Per-MAC address list (business rule 102) ─────────────────────────────
  // Current-state per gate: each gate whose read of a kind succeeded has its
  // discovered rows of that kind replaced by this run's sightings. Runs even
  // with zero sightings, so a gate that stopped reporting a binding drops it.
  // Best-effort, like 7.5b below: the run's real work has already landed.
  {
    const scope = {
      dhcpDevices: result.dhcpLeasesInventoriedDevices ?? [],
      inventoryDevices: result.inventoryDevices ?? [],
      arpDevices: result.arpQueriedDevices ?? [],
    };
    if (addressSightings.length > 0 || scope.dhcpDevices.length || scope.inventoryDevices.length || scope.arpDevices.length) {
      try {
        const { upserted, pruned } = await reconcileDiscoveredAddresses(addressSightings, scope, new Date(now));
        if (upserted || pruned) syncLog("info", `Address list: ${upserted} binding(s) recorded, ${pruned} no longer reported removed`);
      } catch (err: any) {
        syncLog("error", `Failed to record per-MAC addresses: ${err.message || "Unknown error"}`);
      }
    }
  }
}
