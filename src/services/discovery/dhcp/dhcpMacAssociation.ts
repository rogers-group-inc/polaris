/**
 * src/services/discovery/dhcp/dhcpMacAssociation.ts — syncDhcpSubnets Phase 6:
 * associate each DHCP binding's MAC with its asset and cross-update the
 * reservations (in-memory lookups, batched writes). A held lease or
 * reservation stakes the asset's address claim on the shared ladder (rule
 * 101), names its fortigate-endpoint gate by the freshest local sighting,
 * records the binding for the per-MAC address list (rule 102) and a sighting
 * for quarantine fan-out, and defers Last Seen to Phase 7 when the detected-
 * device table also covers the MAC. A quarantined asset seen on a new gate
 * has its quarantine extended there. CQ-B060; the body moved verbatim, its
 * free variables made parameters. The engine-defined helpers
 * (findSubnetForIp, reservationKey) and Phase 6's rule-91(b) guard closures
 * — which stay in the engine because Phase 7 uses them too — are passed in,
 * so this module imports nothing from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex, AssetIndexRung } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { AddressSighting } from "../../assetAddressService.js";
import { scoreAddressClaim, claimBeats, claimMedium, type DhcpClaimState } from "../../../utils/dhcpClaimFreshness.js";
import { inventorySightingIsLocal, type buildArpMacDeviceIndex } from "../../../utils/inventoryLocality.js";
import {
  selectPrimaryMac,
  isHardwareMacSource,
  UNVERIFIED_HOSTNAME_MAC_SOURCE,
  type MacJsonEntry,
} from "../../../utils/macAddresses.js";
import { prisma } from "../../../db.js";
import { isIpv6Address } from "../../../utils/cidr.js";
import { isAllZeroMac } from "../../../utils/mac.js";
import { bumpLastSeen } from "../../../utils/assetInvariants.js";
import { sortNewestFirst } from "../../../utils/sortByTime.js";
import * as sightings from "../../assetSightingService.js";
import { quarantineAsset, verifyAssetQuarantine } from "../../assetQuarantineService.js";
import { reconcileMacAddresses } from "../../macAddressService.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";
import { pruneUnchangedAssetFields } from "../../../utils/assetWritePrune.js";
import { refreshIpHistoryLastSeen } from "../../assetIpHistoryService.js";

export async function associateDhcpMacs(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey. */
  activeResMap: Map<string, any>;
  assetIdx: AssetIndex;
  claims: DhcpClaimState;
  arpMacDeviceIndex: ReturnType<typeof buildArpMacDeviceIndex>;
  bestGateClaimMsByAsset: DhcpClaimState["bestGateClaimMsByAsset"];
  addressSightings: AddressSighting[];
  fortigateEndpointAssetIds: Set<string>;
  now: string;
  findSubnetForIp: (ip: string) => { id: string; cidr: string; name: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  noteEndpointGate: (assetId: string, device: unknown) => void;
  /** Phase 6's rule-91(b) guard and its once-per-(asset, MAC) warning. */
  hostnameAdoptRefused: (asset: any, rung: AssetIndexRung | undefined) => boolean;
  noteHostnameAdoptRefused: (
    asset: any, mac: string, ip: string | null | undefined, hostname: string | null | undefined,
    source: "dhcp-lease" | "device-inventory", device: string | null | undefined,
  ) => void;
  integrationId: string;
  integrationType: string;
  integrationLabel: string;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, activeResMap, assetIdx, claims, arpMacDeviceIndex, bestGateClaimMsByAsset, addressSightings,
    fortigateEndpointAssetIds, now, findSubnetForIp, reservationKey,
    noteEndpointGate, hostnameAdoptRefused, noteHostnameAdoptRefused,
    integrationId, integrationType, integrationLabel, syncLog,
  } = input;

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    // Collect all updates, then batch-execute
    // `macs` (when present) is reconciled to asset_mac_addresses after the
    // asset.update lands, so the in-memory MAC merge logic can stay
    // unchanged while the persist path uses the new side table.
    const assetUpdates: Array<{ id: string; data: any; macs?: MacJsonEntry[] }> = [];
    // Each asset's row as it stood BEFORE this phase touched it, captured at
    // its first queued update. The merged update is pruned against this at
    // flush (utils/assetWritePrune.ts): this phase mirrors only some staged
    // keys into memory, so comparing at queue time could let an earlier
    // entry's value outlive a later one that equals the stored value.
    const phaseBaseline = new Map<string, Record<string, unknown>>();
    const resUpdates: Array<{ id: string; data: Record<string, string> }> = [];
    // Quarantine fan-out hook: every (asset, FortiGate) DHCP attribution
    // becomes a sighting. The flush at the end of the phase is fire-and-
    // forget — sighting recording must not fail the discovery sync.
    const sightingRows: sightings.SightingInput[] = [];

    // MACs the device-inventory pass (Phase 7) will stamp with the FortiGate's
    // real per-client last_seen / is_online. DHCP-lease presence defers to
    // these: a lease only proves an unexpired binding, so a device that leased
    // an IP and went home still shows a bound lease all week — stamping `now`
    // from it overstates Last Seen. When the MAC is covered by inventory this
    // cycle, Phase 7 supplies the authoritative timestamp instead. Lease-only
    // assets (inventory disabled / device not in the table) keep the lease bump.
    const inventoryMacSet = new Set<string>(
      (result.deviceInventory || [])
        .map((d) => (d.macAddress ? d.macAddress.toUpperCase().replace(/-/g, ":") : ""))
        .filter(Boolean),
    );

    // Per-(mac, gate) client freshness from device inventory — the FortiGate's
    // OWN per-client last_seen (an is_online client counts as now). Feeds the
    // multi-gate DHCP claim ranking below: two unexpired leases are both
    // "live" to the DHCP monitor, but only the gate the client is actually
    // behind keeps seeing it. LOCAL rows only: a ZTNA-relayed inventory entry
    // must not vouch for a stale lease on its own gate — and the corroborating
    // evidence here is deliberately switch/AP/ARP, never the lease itself,
    // because this map's whole job is to corroborate leases.
    const invSeenByMacDevice = new Map<string, number>();
    // The same rows' FortiSwitch / FortiAP attribution — which medium a DHCP
    // entry for (mac, gate) rode in on when the lease row itself doesn't say.
    const invMediumByMacDevice = new Map<string, { wired: boolean; wireless: boolean }>();
    for (const d of result.deviceInventory || []) {
      if (!d.macAddress || !d.device) continue;
      if (!inventorySightingIsLocal(d, arpMacDeviceIndex)) continue;
      const mac = d.macAddress.toUpperCase().replace(/-/g, ":");
      const at = d.isOnline ? Date.parse(now) : Date.parse(d.lastSeen);
      if (Number.isNaN(at)) continue;
      const key = `${mac}|${d.device}`;
      const prev = invSeenByMacDevice.get(key);
      if (prev === undefined || at > prev) invSeenByMacDevice.set(key, at);
      const medium = invMediumByMacDevice.get(key) ?? { wired: false, wireless: false };
      if (d.switchName) medium.wired = true;
      if (d.apName) medium.wireless = true;
      invMediumByMacDevice.set(key, medium);
    }

    // Best standing address claim per asset. An asset claimed several times
    // this run (unexpired lease on the site it left + fresh lease where it
    // moved, a static reservation beside a leftover lease, one claim per
    // network card) must take ipAddress / ipSource / learnedLocation — and the
    // fortigate-endpoint source blob's gate — from the BEST claim, not from
    // whichever entry iterates last. Business rule 101; the ranking is in
    // utils/dhcpClaimFreshness.ts. Run-scoped, so the gates of an FMG run —
    // which each get their own call to this function — compete in one set
    // rather than one set apiece, and shared with Phase 7 so an online
    // detected-device row outranks every DHCP binding.
    const bestAddressClaimByAsset = claims.bestAddressClaimByAsset;
    const nowMs = Date.parse(now);

    for (const entry of result.dhcpEntries) {
      if (!entry.macAddress || !entry.ipAddress) continue;
      // A zero-MAC row (a reserved-address entry with no MAC set) names no
      // device. The MAC index already can't match it, but a hostname match
      // would otherwise stamp 00:00:00:00:00:00 onto that asset as its MAC.
      if (isAllZeroMac(entry.macAddress)) continue;
      // Business rule 125: a DHCPv6 binding is recorded in IPAM (Phase 5) and
      // stops there. It never competes for Asset.ipAddress — the address
      // monitoring polls, and every probe transport assumes IPv4 — nor moves
      // the MAC list, learned location, presence or gateway attribution: the
      // same client's IPv4 binding, inventory row and ARP entry already say
      // all of that, and say it about an address Polaris can poll.
      if (isIpv6Address(entry.ipAddress)) continue;
      const normalized = entry.macAddress.toUpperCase().replace(/-/g, ":");

      // DHCP IPs recycle across devices, so IP-only matches would staple
      // a new device's MAC onto the previous lease-holder's asset.
      const match = assetIdx.findByEntryWithRung(entry.macAddress, entry.hostname, entry.ipAddress, { allowIpFallback: false, serialHostname: true, allowHostname: false });
      if (!match) continue;
      const asset = match.asset;
      // Business rule 91(b) (re-scan F2): the lease's hostname is the client's
      // own choice. On a protected asset a hostname-only match keeps the MAC
      // as an unverified sighting (presence as before) but never moves
      // ipAddress / ipSource / learnedLocation, never makes this MAC the
      // primary, stakes no address claim, names no endpoint gate, and adds no
      // fortigate-endpoint source — any of those would let the claimant's
      // address inherit the asset's monitor and its stored credentials.
      const adoptRefused = hostnameAdoptRefused(asset, match.rung);
      if (adoptRefused) noteHostnameAdoptRefused(asset, normalized, entry.ipAddress, entry.hostname, "dhcp-lease", entry.device);

      // Infrastructure assets (firewall/switch/AP) get their ipAddress,
      // ipSource, and learnedLocation from the dedicated FortiGate /
      // FortiSwitch / FortiAP pathways earlier in this sync. A DHCP lease
      // for one of these devices typically points at a non-management
      // interface (FortiLink, mirror VLAN, stack mgmt port) and would
      // clobber the authoritative connecting_from / mgmtIp value.
      const isInfraAsset = asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point";
      // Fortinet-discovery-owned infra (carries the fortinetTopology stamp
      // from its own discovery loop). Presence for these is owned by that
      // loop — the firewall/switch/AP blocks bump lastSeen only when the
      // device answered live / reported connected — plus the monitor probe.
      // A client-side sighting (this box holding a DHCP lease on some gate,
      // or lingering in device inventory) must NOT freshen it: leases stay
      // bound past shutdown and FortiOS's cached is_online lags reality, so
      // an offline-in-FMG gate would otherwise show lastSeen advancing every
      // discovery run. Operator-typed non-Fortinet "firewall"/"switch" assets
      // (no topology stamp) keep the endpoint-style presence bumps — the
      // client sighting is their only evidence.
      const isFortinetOwnedInfra = isInfraAsset && asset.fortinetTopology != null;

      // Rank this entry's claim on the asset's address against the best claim
      // seen so far this run. Only the winner stages ipAddress / ipSource /
      // learnedLocation and names the fortigate-endpoint blob's gate — a
      // losing entry still contributes its sighting, MAC row, and presence.
      const macDeviceKey = entry.device ? `${normalized}|${entry.device}` : null;
      const invMedium = macDeviceKey ? invMediumByMacDevice.get(macDeviceKey) : undefined;
      const priorMacEntry = Array.isArray(asset.macAddresses)
        ? (asset.macAddresses as MacJsonEntry[]).find((m) => m.mac === normalized)
        : undefined;
      const entryMedium = claimMedium({
        wirelessEvidence: !!(entry.accessPoint || entry.ssid) || !!invMedium?.wireless,
        wiredEvidence: !!invMedium?.wired,
        macSource: priorMacEntry?.source,
      });
      const claimScore = scoreAddressClaim({
        kind: entry.type,
        current: !!entry.seenLeased,
        expireTime: entry.expireTime,
        seenMs: macDeviceKey ? invSeenByMacDevice.get(macDeviceKey) : undefined,
        medium: entryMedium,
      }, nowMs);
      // A binding the gate confirms is held right now goes on the asset's
      // address list under this MAC (business rule 102). Configuration nobody
      // holds is not an address the device has.
      if (entry.seenLeased && entry.device && !isInfraAsset && !adoptRefused) {
        addressSightings.push({
          assetId: asset.id, mac: normalized, ip: entry.ipAddress, source: entry.type,
          device: entry.device, medium: entryMedium, seenAt: new Date(now),
        });
      }
      const incumbentScore = bestAddressClaimByAsset.get(asset.id);
      const winsIpClaim = !adoptRefused && (!incumbentScore || claimBeats(claimScore, incumbentScore));
      if (winsIpClaim) bestAddressClaimByAsset.set(asset.id, claimScore);

      // A refused hostname-only match does not place the asset behind this
      // gate either (the sighting row feeds the gateway-firewall attribution).
      if (entry.device && !adoptRefused) {
        sightingRows.push({
          assetId: asset.id,
          fortigateDevice: entry.device,
          source: entry.type === "dhcp-reservation" ? "dhcp_reservation" : "dhcp_lease",
          integrationId,
          ipAddress: entry.ipAddress,
          // Names the gateway-change audit row without a lookup — the asset is
          // already in hand here.
          assetHostname: asset.hostname || asset.ipAddress || null,
        });
        // Stamp this asset as a fortigate-endpoint source target — every
        // DHCP sighting counts even if the asset wasn't created via
        // device-inventory. End-of-sync flush below upserts the row.
        if (!isInfraAsset && !adoptRefused) {
          fortigateEndpointAssetIds.add(asset.id);
          if (winsIpClaim && entry.device) {
            noteEndpointGate(asset.id, entry.device);
            // Record how fresh this naming is so Phase 7's inventory pass only
            // takes the gate over with strictly newer local evidence: a
            // currently-held lease counts as now, otherwise the gate's own
            // per-client inventory last_seen when it corroborated the claim.
            const dhcpGateMs = entry.seenLeased
              ? Date.parse(now)
              : invSeenByMacDevice.get(`${normalized}|${entry.device}`) ?? 0;
            bestGateClaimMsByAsset.set(asset.id, dhcpGateMs);
          }
        }
      }

      // Resolve subnet up-front so we can stamp it on the MAC entry
      const matchingSubnet = findSubnetForIp(entry.ipAddress);

      // Update MAC list in-memory
      const macList: Array<{mac: string; lastSeen: string; source: string; subnetCidr?: string; subnetName?: string}> = Array.isArray(asset.macAddresses) ? [...(asset.macAddresses as any)] : [];
      const existingMac = macList.find((m: any) => m.mac === normalized);
      if (existingMac) {
        existingMac.lastSeen = now;
        // A sighting must not relabel a hardware-truth entry (intune-*/agent/
        // vcenter-vnic): the source is what keeps the entry eligible as the
        // PRIMARY MAC (selectPrimaryMac), and the device's real NIC showing up
        // in a lease table doesn't stop it being the real NIC. Nor may a
        // refused hostname-only sighting launder an unverified entry into an
        // ordinary one (business rule 91(b)).
        // (Under a refusal the entry can only be that unverified one — any
        // other MAC on the list is in the index and would have matched.)
        if (!adoptRefused && !isHardwareMacSource((existingMac as any).source)) existingMac.source = entry.type;
        if (matchingSubnet) {
          existingMac.subnetCidr = matchingSubnet.cidr;
          existingMac.subnetName = matchingSubnet.name;
        }
      } else {
        macList.push({
          mac: normalized,
          lastSeen: now,
          source: adoptRefused ? UNVERIFIED_HOSTNAME_MAC_SOURCE : entry.type,
          ...(matchingSubnet ? { subnetCidr: matchingSubnet.cidr, subnetName: matchingSubnet.name } : {}),
        });
      }
      sortNewestFirst(macList, (e) => e.lastSeen);

      // Presence gate: dhcp-lease rows are currently-held leases and
      // seenLeased marks static reservations confirmed actively held. A
      // reservation whose target is offline is config, not presence. And
      // when device inventory covers this MAC, defer presence (lastSeen +
      // status) to Phase 7's authoritative real-last_seen / is_online signal
      // rather than stamping `now` off a possibly-idle lease binding.
      const leasePresence = entry.seenLeased && !inventoryMacSet.has(normalized);

      // Queue asset update. macAddresses go to the side table via the
      // reconcile call inside mapSettledWithConcurrency, not as a JSON column write.
      // Primary MAC: hardware-truth entries (Intune/agent/vCenter NICs) win
      // over sightings — see selectPrimaryMac.
      // A refused hostname-only sighting keeps the asset's current primary;
      // selectPrimaryMac passes over unverified entries, so the claimant's MAC
      // is primary only on an asset that had no MAC at all (rule 91(b)).
      const dhcpPrimaryMac = (adoptRefused && asset.macAddress)
        ? asset.macAddress
        : selectPrimaryMac(macList) ?? macList[0].mac;
      const updateData: Record<string, unknown> = {
        macAddress: dhcpPrimaryMac,
        // A live lease must not pull a maintenance-window asset back to
        // "active" — that status is scheduler-owned until the window ends.
        ...(leasePresence && asset.status !== "maintenance"
          ? {
              status: "active",
              ...(asset.status !== "active" ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
            }
          : {}),
      };
      if (leasePresence && !isFortinetOwnedInfra) bumpLastSeen(updateData, asset, new Date(now), "dhcp-lease");
      if (!isInfraAsset && winsIpClaim) {
        updateData.ipAddress = entry.ipAddress;
        updateData.ipSource = entry.device || integrationType;
        if (entry.device) updateData.learnedLocation = entry.device;
      }
      if (!phaseBaseline.has(asset.id)) phaseBaseline.set(asset.id, { ...(asset as Record<string, unknown>) });
      assetUpdates.push({
        id: asset.id,
        data: updateData,
        macs: macList,
      });

      // Update in-memory so device inventory phase sees current state
      asset.macAddress = dhcpPrimaryMac;
      asset.macAddresses = macList;
      if (!isInfraAsset && winsIpClaim) {
        asset.ipAddress = entry.ipAddress;
        if (entry.device) asset.learnedLocation = entry.device;
      }
      // Same guard as the write above (rule 16): a maintenance asset stays in
      // maintenance in memory too, or its NEXT lease this run stages "active".
      if (leasePresence && asset.status !== "maintenance") asset.status = "active";
      if (updateData.lastSeen) asset.lastSeen = updateData.lastSeen;
      assetIdx.reindex(asset);

      // Queue reservation cross-update (in-memory lookup, no DB query).
      // **Owner preservation rule:** owner is overwritten with asset.assignedTo
      // ONLY when the discovered MAC differs from the reservation's stored
      // MAC (or when the row had no stored MAC, e.g. legacy rows from before
      // the MAC ingest fix). This keeps a Polaris-set owner (stamped when an
      // operator edits the reservation) from being clobbered on every
      // discovery cycle for stable reservations; if the MAC genuinely changes
      // (a different physical device now uses this IP) the discovered owner
      // takes precedence again. Hostname follows the existing behaviour —
      // discovery is authoritative there.
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, entry.ipAddress);
        const res = activeResMap.get(key);
        if (res) {
          const resMacNorm = res.macAddress
            ? res.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const macChanged = resMacNorm !== normalized;
          const resUpdate: Record<string, string> = {};
          if (asset.hostname && res.hostname !== asset.hostname) {
            resUpdate.hostname = asset.hostname;
          }
          // Not on a refused hostname-only sighting (rule 91(b)): the lease's
          // holder is not shown to be the asset's device, so it must not be
          // stamped with the asset's owner.
          if (asset.assignedTo && res.owner !== asset.assignedTo && macChanged && !adoptRefused) {
            resUpdate.owner = asset.assignedTo;
          }
          // A row Polaris pushed to a gate is NOT ours to rewrite here: this is
          // a bare prisma.update with no device write behind it, so changing the
          // MAC would leave Polaris pointing at a MAC the FortiGate's
          // reserved-address entry doesn't have — a divergence nothing later
          // reconciles. Phase 7.7 owns the pushed case; it goes through
          // updatePushedReservation, which writes the device first and verifies
          // by read-back. Unpushed rows keep the historical behaviour.
          const isPushedRow = !!res.pushedToId || !!res.pushStatus;
          if (macChanged && !isPushedRow) {
            resUpdate.macAddress = normalized;
          }
          if (Object.keys(resUpdate).length > 0) {
            resUpdates.push({ id: res.id, data: resUpdate });
            // Update in-memory
            if (resUpdate.hostname) res.hostname = resUpdate.hostname;
            if (resUpdate.owner) res.owner = resUpdate.owner;
            if (resUpdate.macAddress) res.macAddress = resUpdate.macAddress;
          }
        }
      }
    }

    // Coalesce per asset before executing. Several DHCP entries for one asset
    // (multi-gate claims, multi-NIC) previously pushed one update row EACH,
    // and those raced inside mapSettledWithConcurrency's concurrency window — the asset's
    // final ipAddress was whichever write landed last, defeating the claim
    // ranking above. Shallow-merge in iteration order (the ranked ip fields
    // are only staged by the winning entry, and a later winner overrides an
    // earlier best-so-far); the MAC list is cumulative in-memory, so the last
    // one is the most complete.
    const mergedAssetUpdates: Array<{ id: string; data: any; macs?: MacJsonEntry[] }> = [];
    {
      const byId = new Map<string, { id: string; data: any; macs?: MacJsonEntry[] }>();
      for (const u of assetUpdates) {
        const prev = byId.get(u.id);
        if (!prev) {
          const merged = { ...u };
          byId.set(u.id, merged);
          mergedAssetUpdates.push(merged);
          continue;
        }
        prev.data = { ...prev.data, ...u.data };
        if (u.macs) prev.macs = u.macs;
      }
    }

    // Batch-execute asset updates. After each successful update, reconcile
    // the MAC side table from the in-memory list the discovery sync built.
    // Keeping the reconcile inline (per-asset) instead of as a second
    // global pass means a failure on one asset's reconcile only affects
    // that asset's MAC table — the others stay consistent.
    // Drop what the row already held before this phase (an unchanged
    // primary MAC alone fired a dns_resolved reconcile per asset); a dropped
    // IP refreshes its history in one batch. A merge left empty skips the
    // UPDATE but still reconciles the MAC side table.
    const macIpHistoryRefresh: Array<{ assetId: string; ip: string; source: string }> = [];
    for (const u of mergedAssetUpdates) {
      const baseline = phaseBaseline.get(u.id);
      if (!baseline) continue;
      const { ipHistoryRefresh } = pruneUnchangedAssetFields(baseline, u.data);
      if (ipHistoryRefresh) macIpHistoryRefresh.push({ assetId: u.id, ...ipHistoryRefresh });
    }
    if (mergedAssetUpdates.length > 0) {
      const results = await mapSettledWithConcurrency(mergedAssetUpdates, 50, async (u) => {
        const updated = Object.keys(u.data).length > 0
          ? await prisma.asset.update({ where: { id: u.id }, data: u.data })
          : null;
        if (u.macs) await reconcileMacAddresses(u.id, u.macs);
        return updated;
      });
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          const u = mergedAssetUpdates[i];
          syncLog("error", `Failed to update asset MAC/IP for asset ${u?.id} (${(u?.data as any)?.ipAddress ?? "no ip staged"}): ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
        }
      }
    }

    if (macIpHistoryRefresh.length > 0) await refreshIpHistoryLastSeen(macIpHistoryRefresh);

    // Batch-execute reservation cross-updates
    if (resUpdates.length > 0) {
      await mapSettledWithConcurrency(resUpdates, 50, (u) =>
        prisma.reservation.update({ where: { id: u.id }, data: u.data })
      );
    }

    // Flush quarantine-sighting rows. Failures are swallowed inside
    // recordSightings (Promise.allSettled) — a misbehaving row should not
    // fail the discovery sync.
    if (sightingRows.length > 0) {
      try {
        await sightings.recordSightings(sightingRows);
      } catch (err: any) {
        syncLog("error", `Failed to flush ${sightingRows.length} asset sighting(s): ${err.message || "Unknown error"}`);
      }

      // Auto-quarantine pass: for each unique (asset, FortiGate) sighting,
      // if the asset is currently quarantined:
      //   - Not yet a synced target on this FortiGate → extend quarantine.
      //   - Already a synced target → verify and flip drift if missing.
      // Best-effort: failures are logged but never block the discovery sync.
      const seenPairs = new Map<string, string>(); // assetId → Set of fortigateDevices (JSON-encoded unique pairs)
      const uniquePairs: Array<{ assetId: string; fortigateDevice: string }> = [];
      for (const row of sightingRows) {
        const key = `${row.assetId}|${row.fortigateDevice}`;
        if (!seenPairs.has(key)) {
          seenPairs.set(key, key);
          uniquePairs.push({ assetId: row.assetId, fortigateDevice: row.fortigateDevice });
        }
      }

      // One read screens the whole pass: almost every pair resolves to "not
      // quarantined", so the per-pair findUnique was ~one round trip per
      // sighting pair to learn nothing. Pairs that survive the screen still
      // re-read fresh per pair — a second gate's pair for the SAME asset must
      // see the targets the first pair's extend just wrote.
      const quarantinedIds = new Set<string>();
      try {
        const quarantined = await prisma.asset.findMany({
          where: { id: { in: [...new Set(uniquePairs.map((p) => p.assetId))] }, status: "quarantined" },
          select: { id: true },
        });
        for (const a of quarantined) quarantinedIds.add(a.id);
      } catch (err: any) {
        syncLog("error", `Auto-quarantine pre-read failed, skipping the pass: ${err.message || "Unknown error"}`);
      }

      for (const pair of uniquePairs) {
        if (!quarantinedIds.has(pair.assetId)) continue;
        try {
          const asset = await prisma.asset.findUnique({
            where: { id: pair.assetId },
            select: { id: true, status: true, quarantineTargets: true },
          });
          if (!asset || asset.status !== "quarantined") continue;

          const targets: Array<{ fortigateDevice: string; status: string }> =
            Array.isArray(asset.quarantineTargets) ? (asset.quarantineTargets as any[]) : [];
          const existingTarget = targets.find((t) => t.fortigateDevice === pair.fortigateDevice);

          if (!existingTarget || existingTarget.status !== "synced") {
            // Not covered — extend quarantine to this FortiGate.
            await quarantineAsset({ assetId: pair.assetId, actor: "system:auto-quarantine" });
          } else {
            // Already covered — verify and persist drift if detected.
            const verifyResult = await verifyAssetQuarantine(pair.assetId);
            if (verifyResult.driftDetected) {
              await prisma.asset.update({
                where: { id: pair.assetId },
                data: { quarantineTargets: verifyResult.targets as any },
              });
            }
          }
        } catch (err: any) {
          syncLog("error", `Auto-quarantine check failed for asset ${pair.assetId} on ${pair.fortigateDevice}: ${err.message || "Unknown error"}`);
        }
      }
    }
  }
}
