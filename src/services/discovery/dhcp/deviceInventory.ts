/**
 * src/services/discovery/dhcp/deviceInventory.ts — syncDhcpSubnets Phase 7:
 * the FortiGate detected-device inventory, which fills what DHCP did not —
 * an asset for a device seen on the wire with no lease, and the os / model /
 * location an existing one lacks. An entry is trusted only on positive local
 * evidence (inventorySightingIsLocal), competes on the same address ladder as
 * Phase 6's DHCP claims (rule 101), and a created asset whose name another
 * live asset carries is suffixed by MAC (rule 91(i)). Asset writes are
 * deferred to one concurrent flush at the end of the phase while every
 * in-memory effect stays inline. CQ-B060; the body moved verbatim, its free
 * variables made parameters. Phase 6's hostname-adopt guard closures and the
 * engine's inferInventoryAssetType are passed in, so this module imports nothing
 * from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex, AssetIndexRung } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { ChangeBaselineFields } from "./changeEvents.js";
import type { AssetTypeFacts } from "../../../utils/assetTypeMatch.js";
import type { AddressSighting } from "../../assetAddressService.js";
import { scoreAddressClaim, claimBeats, claimMedium, type DhcpClaimState } from "../../../utils/dhcpClaimFreshness.js";
import {
  arpContradicts,
  arpMultiHomed,
  inventorySightingIsLocal,
  type buildArpMacDeviceIndex,
  type buildArpIpsByMacDevice,
} from "../../../utils/inventoryLocality.js";
import {
  buildMacRowsForCreate,
  selectPrimaryMac,
  isHardwareMacSource,
  UNVERIFIED_HOSTNAME_MAC_SOURCE,
  type MacJsonEntry,
} from "../../../utils/macAddresses.js";
import { prisma } from "../../../db.js";
import { isIpv6Address } from "../../../utils/cidr.js";
import { normalizeMacOrNull } from "../../../utils/mac.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../../utils/assetInvariants.js";
import { sortNewestFirst } from "../../../utils/sortByTime.js";
import { logDiscoveryAssetCreated, logDiscoveryAssetUpdated } from "../../eventLogService.js";
import { reconcileMacAddresses } from "../../macAddressService.js";
import { planHostnameMacSuffixes } from "../../hostnameMacSuffixService.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";
import { pruneUnchangedAssetFields } from "../../../utils/assetWritePrune.js";
import { refreshIpHistoryLastSeen } from "../../assetIpHistoryService.js";

export async function syncDeviceInventory(input: {
  result: DiscoveryResult;
  assetIdx: AssetIndex;
  /** The run's reservation snapshot — hostname → IP fallback for an inventory row with no address. */
  allReservationsRaw: Array<{ hostname: string | null; ipAddress: string | null }>;
  claims: DhcpClaimState;
  arpMacDeviceIndex: ReturnType<typeof buildArpMacDeviceIndex>;
  arpIpsByMacDevice: ReturnType<typeof buildArpIpsByMacDevice>;
  bestGateClaimMsByAsset: DhcpClaimState["bestGateClaimMsByAsset"];
  addressSightings: AddressSighting[];
  fortigateEndpointAssetIds: Set<string>;
  /** Appended to for the run's summary, as before. */
  inventoryAssets: string[];
  now: string;
  noteChangeBaseline: (asset: any, fields: ChangeBaselineFields[]) => void;
  noteEndpointGate: (assetId: string, device: unknown) => void;
  /** Phase 6's rule-91(b) guard and its once-per-(asset, MAC) warning. */
  hostnameAdoptRefused: (asset: any, rung: AssetIndexRung | undefined) => boolean;
  noteHostnameAdoptRefused: (
    asset: any, mac: string, ip: string | null | undefined, hostname: string | null | undefined,
    source: "dhcp-lease" | "device-inventory", device: string | null | undefined,
  ) => void;
  /**
   * The device-type rules in the `inventory` context (business rule 164),
   * over everything known about the client: the gate's fingerprint and what
   * the asset already carries. "other" when nothing claims it.
   */
  inferInventoryAssetType: (facts: AssetTypeFacts) => string;
  integrationId: string;
  integrationName: string;
  integrationType: string;
  integrationLabel: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, assetIdx, allReservationsRaw, claims, arpMacDeviceIndex, arpIpsByMacDevice, bestGateClaimMsByAsset,
    addressSightings, fortigateEndpointAssetIds, inventoryAssets, now,
    noteChangeBaseline, noteEndpointGate, hostnameAdoptRefused, noteHostnameAdoptRefused, inferInventoryAssetType,
    integrationId, integrationName, integrationType, integrationLabel, actor, syncLog,
  } = input;

  if (result.deviceInventory && result.deviceInventory.length > 0) {
    const dhcpMacs = new Set<string>();
    const dhcpMacToIp = new Map<string, string>();
    for (const e of result.dhcpEntries || []) {
      if (e.macAddress) {
        const m = e.macAddress.toUpperCase().replace(/-/g, ":");
        dhcpMacs.add(m);
        // IPv4 only: this map addresses a NEW asset, and a DHCPv6 lease never
        // becomes an asset's address (business rule 125).
        if (e.ipAddress && !isIpv6Address(e.ipAddress) && !dhcpMacToIp.has(m)) dhcpMacToIp.set(m, e.ipAddress);
      }
    }

    // Hostname → IP from existing reservations (fallback for inventory entries missing an IP)
    const resHostnameToIp = new Map<string, string>();
    for (const r of allReservationsRaw) {
      // IPv4 only — this addresses a new asset, which an IPv6 row never does
      // (business rule 125).
      if (r.hostname && r.ipAddress && !isIpv6Address(r.ipAddress)) resHostnameToIp.set(r.hostname.toLowerCase(), r.ipAddress);
    }

    // The address ladder Phase 6 already ranked its DHCP claims on (business
    // rule 101). A detected-device row competes on the SAME ladder, so an
    // online row — FortiOS built it from traffic it is seeing from that MAC
    // right now — outranks a leftover lease or a reservation for another card,
    // while a remembered-but-offline row still loses to a binding the device
    // is holding. Several gates can report one client (the site it left keeps
    // a remembered row), and the ladder's freshness keys settle those too.
    const bestAddressClaimByAsset = claims.bestAddressClaimByAsset;
    const invNowMs = Date.parse(now);

    // Deferred I/O for the update path (see the note at the write site).
    // deviceInventory is every DHCP client across every gate — routinely the
    // largest row set in a run — and this loop paid an asset.update plus a
    // two-query MAC reconcile per sighting, serially. CREATES stay inline:
    // assetIdx.add needs the row's real id so a later sighting of the same
    // device updates it instead of minting a duplicate.
    // Keyed by asset, NOT a list: several gates routinely sight one client, and
    // the flush runs through mapSettledWithConcurrency, which is CONCURRENT — two updates
    // for the same row would race and the older sighting could land last.
    // Merging in accumulation order is also exactly right, because each row's
    // updateData was computed from the in-memory object the previous row had
    // already assigned onto: later keys win, and the result is one write per
    // asset instead of one per sighting.
    const pendingInvUpdates = new Map<string, { data: Record<string, unknown>; label: string }>();
    const pendingInvMacs = new Map<string, MacJsonEntry[]>();
    // Addresses a write no longer stages because they equal the row's: their
    // IP history is refreshed in one batch after the flush (assetWritePrune).
    const invIpHistoryRefresh: Array<{ assetId: string; ip: string; source: string }> = [];
    // Hostnames of the assets this pass creates — rule 91(i) names their families apart by MAC after the flush.
    const invCreated: Array<{ id: string; hostname: string }> = [];

    for (const inv of result.deviceInventory) {
      if (!inv.macAddress && !inv.ipAddress) continue;
      const normalizedMac = normalizeMacOrNull(inv.macAddress) ?? "";

      const handledByDhcp = normalizedMac && dhcpMacs.has(normalizedMac);

      // In-memory asset lookup. Inventory IPs are the device's last-seen DHCP
      // IP, so they recycle just like lease IPs — skip the IP fallback.
      const invMatch = normalizedMac
        ? assetIdx.findByEntryWithRung(inv.macAddress, inv.hostname, inv.ipAddress, { allowIpFallback: false, serialHostname: true, allowHostname: false })
        : assetIdx.findByEntryWithRung(undefined, inv.hostname, inv.ipAddress, { allowIpFallback: false, serialHostname: true, allowHostname: false });
      const existingAsset = invMatch?.asset;
      // Business rule 91(b) (re-scan F2) — the same guard as the Phase 6 lease
      // path: the row's hostname is the client's own claim, so on a protected
      // asset a hostname-only match records the MAC as an unverified sighting
      // and keeps presence, but writes nothing location- or identity-shaped:
      // no ipAddress / ipSource / learnedLocation, no address claim or address
      // list row, no primary MAC, no switch/AP attribution or endpoint gate,
      // no fortigate-endpoint source, and no OS / vendor / type / user
      // fingerprint taken from the claimant.
      const invAdoptRefused = !!existingAsset && hostnameAdoptRefused(existingAsset, invMatch?.rung);
      if (invAdoptRefused) {
        noteHostnameAdoptRefused(existingAsset, normalizedMac, inv.ipAddress, inv.hostname, "device-inventory", inv.device);
      }

      const switchConn = inv.switchName
        ? (inv.switchPort ? `${inv.switchName}/port${inv.switchPort}` : inv.switchName)
        : null;
      const apConn = inv.apName || null;

      // Presence evidence is the FortiGate's own per-client last_seen — NOT
      // the discovery-run time. FortiOS keeps remembered-but-offline clients
      // in this inventory (bounded by inventoryMaxAgeHours), so stamping
      // `now` would freshen devices that left the network days ago. An
      // is_online client is on the wire right now → evidence is `now`.
      const invSeenAt = inv.isOnline ? new Date(now) : new Date(inv.lastSeen);
      const invSeenValid = !Number.isNaN(invSeenAt.getTime());

      // May this row LOCATE the device? A ZTNA access-proxy session creates an
      // inventory entry (MAC, hostname, fresh last_seen and all) on a gate the
      // user merely connects THROUGH — so location-shaped writes below
      // (learnedLocation, the IP claim, the MAC entry's device stamp, the
      // endpoint-gate name) require positive local evidence: FortiSwitch/AP
      // attribution on the row, or an ARP binding on the same gate this run.
      // Non-local rows still contribute what they truly know: presence,
      // OS/vendor fingerprints, the user sighting.
      // A refused hostname-only match (rule 91(b), above) locates nothing.
      const invIsLocal = inventorySightingIsLocal(inv, arpMacDeviceIndex) && !invAdoptRefused;

      if (existingAsset) {
        const invIsFortinetInfra = existingAsset.assetType === "firewall"
          || existingAsset.assetType === "switch"
          || existingAsset.assetType === "access_point";
        // Discovery-owned infra: presence comes from the device's own
        // discovery loop (bumps only when it answered live / reported
        // connected) + the monitor probe — never from this client-side
        // inventory sighting. FortiOS's cached is_online lags reality, so
        // without this an offline-in-FMG gate sighted as a DHCP client of
        // another gate keeps its lastSeen advancing every discovery run.
        // Mirrors the Phase 6 lease-path guard; operator-typed non-Fortinet
        // infra (no fortinetTopology stamp) keeps the bump.
        const invIsFortinetOwnedInfra = invIsFortinetInfra && existingAsset.fortinetTopology != null;
        const updateData: Record<string, unknown> = {};
        if (invSeenValid && !invIsFortinetOwnedInfra) bumpLastSeen(updateData, existingAsset, invSeenAt, "device-inventory");
        // Resurrection requires the device to be online right now — a
        // remembered-but-offline inventory row must not undo an operator's
        // (or the stale-sweep's) decommission.
        if (existingAsset.status === "decommissioned" && inv.isOnline) {
        updateData.status = "active";
        updateData.statusChangedAt = new Date(now);
        updateData.statusChangedBy = integrationLabel;
      }
        // Fortinet infrastructure takes its address from its own discovery
        // loop (the mgmt IP), never from a client-side sighting — the Phase 6
        // DHCP path skips it for the same reason.
        if (inv.ipAddress && invIsLocal && !invIsFortinetInfra) {
          // Record the claim even when the value already matches — otherwise a
          // fresh row that agrees with the asset stakes no claim and a stale
          // claim iterated later would still take the address. Local rows
          // only: a ZTNA entry relays the client's IP from wherever it really
          // is, and must not write it as this gate's sighting.
          const priorMacEntry = normalizedMac && Array.isArray(existingAsset.macAddresses)
            ? (existingAsset.macAddresses as MacJsonEntry[]).find((m) => m.mac === normalizedMac)
            : undefined;
          const invMedium = claimMedium({
            wirelessEvidence: !!inv.apName,
            wiredEvidence: !!inv.switchName,
            macSource: priorMacEntry?.source,
          });
          const invUntrusted =
            arpContradicts(arpIpsByMacDevice, normalizedMac, inv.device, inv.ipAddress) ||
            arpMultiHomed(arpIpsByMacDevice, normalizedMac, inv.device);
          const claimScore = scoreAddressClaim({
            kind: "device-inventory",
            current: !!inv.isOnline,
            // The same gate's ARP table has this MAC on another address and
            // not on this one — or on SEVERAL addresses, in which case the row
            // only says which one the gate last saw traffic from. Either way
            // the row drops below any current binding, and Phase 7.5's ARP
            // claims decide.
            contradicted: invUntrusted,
            seenMs: invSeenValid ? invSeenAt.getTime() : 0,
            medium: invMedium,
          }, invNowMs);
          // An online row is a binding the gate is seeing right now — it goes
          // on the address list under its MAC (business rule 102). A
          // remembered-but-offline row's address is history, not an address.
          if (inv.isOnline && normalizedMac && inv.device) {
            addressSightings.push({
              assetId: existingAsset.id, mac: normalizedMac, ip: inv.ipAddress, source: "device-inventory",
              device: inv.device, medium: invMedium, seenAt: invSeenAt,
            });
          }
          const incumbentScore = bestAddressClaimByAsset.get(existingAsset.id);
          if (!incumbentScore || claimBeats(claimScore, incumbentScore)) {
            bestAddressClaimByAsset.set(existingAsset.id, claimScore);
            // A pinned asset's ipAddress already equals its ipOverride, so an
            // agreeing sighting must still be staged — the db.ts guard only
            // releases the pin when a write carries the matching IP.
            //
            // An UNTRUSTED row may fill a blank address but never moves an
            // asset off the one it has: it stakes its (low) claim, and Phase
            // 7.5's ARP claims decide from the standing address.
            const mayMove = !invUntrusted || !existingAsset.ipAddress;
            if (
              mayMove && (
                inv.ipAddress !== existingAsset.ipAddress ||
                ((existingAsset as any).ipOverride && (existingAsset as any).ipOverride === inv.ipAddress)
              )
            ) {
              updateData.ipAddress = inv.ipAddress;
              updateData.ipSource = inv.device || integrationType;
            }
            if (mayMove && inv.device) updateData.learnedLocation = inv.device;
          }
        }
        // Fortinet infrastructure (firewall/switch/AP) gets os/osVersion from
        // its own discovery loop via projection — canonical FortiOS strings
        // read live from the device. The device-inventory os_version for these
        // same boxes (they show up as DHCP clients of their gate) is FortiOS's
        // CACHED client fingerprint in display format ("7.4.5 Build 0734")
        // and lags upgrades. It must never overwrite the projection-owned
        // value: Phase 7 runs after the infra loops, so the set-always write
        // below re-staled AP firmware minutes after the AP loop healed it,
        // every cycle — and Phase 11's corrective projection pass excludes
        // infra assets, so nothing ever fixed it (prod 2026-07).
        // (`invIsFortinetInfra` is defined above the lastSeen bump — this
        // os-write skip deliberately keys on assetType alone, unlike the
        // topology-qualified presence guard.)
        // A refused hostname-only match (rule 91(b)) fingerprints nothing: the
        // OS / vendor / type / switch-port / AP describe the claimant.
        if (!invAdoptRefused) {
          if (inv.os && !existingAsset.os && !invIsFortinetInfra) updateData.os = inv.os;
          // Business rule 164: every fact, not the OS string alone — a rule
          // on Manufacturer ("APC" → Power) could never claim a device the
          // gate fingerprinted as "APC AOS". Still `other`-only, so a type an
          // authoritative source or an operator set is never overwritten.
          if ((existingAsset as any).assetType === "other") {
            const a = existingAsset as any;
            const inferred = inferInventoryAssetType({
              os:           a.os || inv.os || null,
              osVersion:    a.osVersion || inv.osVersion || null,
              hostname:     a.hostname || inv.hostname || null,
              manufacturer: a.manufacturer || inv.hardwareVendor || null,
              model:        a.model ?? null,
              productType:  a.productType ?? null,
            });
            if (inferred !== "other") updateData.assetType = inferred;
          }
          if (inv.osVersion && !invIsFortinetInfra) updateData.osVersion = inv.osVersion;
          if (inv.hardwareVendor && !existingAsset.manufacturer) updateData.manufacturer = inv.hardwareVendor;
          if (inv.device && !existingAsset.learnedLocation && invIsLocal) updateData.learnedLocation = inv.device;
          if (switchConn) updateData.lastSeenSwitch = switchConn;
          if (apConn) updateData.lastSeenAp = apConn;
        }
        // Baseline BEFORE the Object.assign below mutates existingAsset. The
        // os/osVersion half is skipped for Fortinet infra — those never reach
        // this branch's staged writes (guarded above) and their firmware event
        // comes from the projection path's logDiscoveryAssetUpdated.
        {
          const touched: ChangeBaselineFields[] = [];
          if ("os" in updateData) touched.push("os");
          if ("osVersion" in updateData) touched.push("osVersion");
          if ("lastSeenSwitch" in updateData) touched.push("lastSeenSwitch");
          if ("lastSeenAp" in updateData) touched.push("lastSeenAp");
          if (touched.length) noteChangeBaseline(existingAsset, touched);
        }

        if (inv.user && !invAdoptRefused) {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = Array.isArray(existingAsset.associatedUsers) ? [...(existingAsset.associatedUsers as any)] : [];
          const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
          const domain = parts[0] || undefined;
          const username = parts[1] || inv.user;
          const existingUser = userList.find((u) => u.user === username && u.domain === domain);
          if (existingUser) {
            existingUser.lastSeen = now;
            existingUser.source = "device-inventory";
          } else {
            userList.push({ user: username, domain, lastSeen: now, source: "device-inventory" });
          }
          sortNewestFirst(userList, (e) => e.lastSeen);
          updateData.associatedUsers = userList;
        }

        let macListForReconcile: MacJsonEntry[] | null = null;
        if (normalizedMac && !handledByDhcp) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          // Evidence time, never run time: stamping `now` here made a
          // remembered-but-offline (or ZTNA-relayed) row re-freshen its MAC
          // entry every discovery run, which kept it winning the primary-MAC
          // sort over the device's real NICs (prod 2026-08). Only-advance, so
          // an old cached row can't move a fresher stamp backwards.
          const macSeenMs = invSeenValid ? invSeenAt.getTime() : 0;
          const existingMac = macList.find((m) => m.mac === normalizedMac);
          if (existingMac) {
            if (macSeenMs > (Date.parse(existingMac.lastSeen) || 0)) {
              existingMac.lastSeen = invSeenAt.toISOString();
            }
            // A sighting must not relabel a hardware-truth entry — the source
            // keeps the entry eligible as primary (selectPrimaryMac) — and a
            // refused one must not launder an unverified entry (rule 91(b)).
            if (!invAdoptRefused && !isHardwareMacSource(existingMac.source)) existingMac.source = "device-inventory";
            if (inv.device && invIsLocal) existingMac.device = inv.device;
          } else {
            macList.push({
              mac: normalizedMac,
              lastSeen: invSeenValid ? invSeenAt.toISOString() : now,
              source: invAdoptRefused ? UNVERIFIED_HOSTNAME_MAC_SOURCE : "device-inventory",
              ...(inv.device && invIsLocal ? { device: inv.device } : {}),
            });
          }
          sortNewestFirst(macList, (e) => e.lastSeen);
          // Rule 91(b): a refused sighting keeps the current primary.
          updateData.macAddress = (invAdoptRefused && existingAsset.macAddress)
            ? existingAsset.macAddress
            : selectPrimaryMac(macList) ?? macList[0].mac;
          // Update in-memory `existingAsset.macAddresses` for downstream sync
          // phases that read it before the next pre-load. Side-table reconcile
          // happens after the asset.update lands.
          existingAsset.macAddresses = macList;
          macListForReconcile = macList;
        }

        if (Object.keys(updateData).length > 0 || macListForReconcile) {
          try {
            clampAcquiredToLastSeen(updateData, existingAsset);
            // Drop what the row already holds, so an unchanged device's write
            // is one UPDATE (lastSeen) rather than the full db.ts hook chain.
            // Compared against this in-memory object, which already carries
            // any earlier sighting's pending change, so merging stays correct.
            const { ipHistoryRefresh } = pruneUnchangedAssetFields(existingAsset as Record<string, unknown>, updateData);
            if (ipHistoryRefresh) invIpHistoryRefresh.push({ assetId: existingAsset.id, ...ipHistoryRefresh });
            if (Object.keys(updateData).length > 0) {
              // The WRITE is deferred to the flush below; every in-memory
              // effect stays right here, in order. That split is the whole
              // trick: identity resolution for later rows runs off assetIdx
              // and off this same object, so it must see the change now —
              // but the round trip does not have to happen now, and
              // deviceInventory is the largest row set in a run.
              //
              // Two rows can land on one asset (several gates sighting the
              // same client). The second's updateData is computed from this
              // object AFTER the first's Object.assign, so merging in order
              // gives the same final row the inline writes did.
              const priorPending = pendingInvUpdates.get(existingAsset.id);
              pendingInvUpdates.set(existingAsset.id, {
                data: { ...(priorPending?.data ?? {}), ...updateData },
                label: priorPending?.label ?? `${existingAsset.hostname || normalizedMac} (updated)`,
              });
              // Update in-memory
              Object.assign(existingAsset, updateData);
              // Mirror the db.ts pin release so Phase 11 doesn't re-stage it.
              if ((existingAsset as any).ipOverride && (existingAsset as any).ipOverride === updateData.ipAddress) {
                (existingAsset as any).ipOverride = null;
              }
              assetIdx.reindex(existingAsset);
            } else if (macListForReconcile) {
              // MAC-only change still counts as a touch for the run summary.
              inventoryAssets.push(`${existingAsset.hostname || normalizedMac} (updated)`);
            }
            if (macListForReconcile) {
              // Last list per asset wins — reconcileMacAddresses is a
              // whole-list sync, so replaying an earlier row's list would
              // undo a later one. One reconcile per asset instead of one per
              // sighting (it is two queries each).
              pendingInvMacs.set(existingAsset.id, macListForReconcile);
            }
            if (!invAdoptRefused && existingAsset.assetType !== "firewall" && existingAsset.assetType !== "switch" && existingAsset.assetType !== "access_point") {
              fortigateEndpointAssetIds.add(existingAsset.id);
              // Name the endpoint gate only from a LOCAL sighting, and only
              // when it's strictly fresher than whatever named the gate so far
              // this run (the DHCP path's claim, or another gate's inventory
              // row) — a stale-but-local cached row must not out-name a
              // currently-held lease, and a ZTNA relay must never name it.
              if (invIsLocal && inv.device) {
                const prevMs = bestGateClaimMsByAsset.get(existingAsset.id);
                const gateMs = invSeenValid ? invSeenAt.getTime() : 0;
                if (prevMs === undefined || gateMs > prevMs) {
                  bestGateClaimMsByAsset.set(existingAsset.id, gateMs);
                  noteEndpointGate(existingAsset.id, inv.device);
                }
              }
            }
          } catch (err: any) {
            syncLog("error", `Failed to update inventory asset ${existingAsset.hostname || normalizedMac}: ${err.message || "Unknown error"}`);
          }
        }
      } else {
        // Only create new assets that have a MAC and a resolvable IP
        if (!normalizedMac) continue;
        let resolvedIp = inv.ipAddress || "";
        if (!resolvedIp) resolvedIp = dhcpMacToIp.get(normalizedMac) || "";
        if (!resolvedIp && inv.hostname) resolvedIp = resHostnameToIp.get(inv.hostname.toLowerCase()) || "";
        if (!resolvedIp) continue;

        try {
          const userList: Array<{user: string; domain?: string; lastSeen: string; source: string}> = [];
          if (inv.user) {
            const parts = inv.user.includes("\\") ? inv.user.split("\\") : [null, inv.user];
            userList.push({ user: parts[1] || inv.user, domain: parts[0] || undefined, lastSeen: now, source: "device-inventory" });
          }
          const newAsset = await prisma.asset.create({
            data: {
              ipAddress: resolvedIp,
              // Location-shaped fields only from a LOCAL sighting — a ZTNA
              // relay's entry still creates the asset (the device is real),
              // but must not claim it sits behind this gate.
              ipSource: (invIsLocal ? inv.device : null) || integrationType,
              macAddress: normalizedMac || null,
              ...(normalizedMac
                ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedMac, lastSeen: invSeenValid ? invSeenAt.toISOString() : now, source: "device-inventory", ...(inv.device && invIsLocal ? { device: inv.device } : {}) }]) } }
                : {}),
              hostname: inv.hostname || null,
              manufacturer: inv.hardwareVendor || null,
              assetType: inferInventoryAssetType({
                os: inv.os || null,
                osVersion: inv.osVersion || null,
                hostname: inv.hostname || null,
                manufacturer: inv.hardwareVendor || null,
              }),
              status: "active",
              statusChangedAt: new Date(now),
              statusChangedBy: integrationLabel,
              os: inv.os || null,
              osVersion: inv.osVersion || null,
              learnedLocation: invIsLocal ? inv.device || null : null,
              lastSeenSwitch: switchConn,
              lastSeenAp: apConn,
              associatedUsers: userList,
              // Honest timestamp on create too — the FortiGate's per-client
              // last_seen, or `now` only when the client is online right now.
              lastSeen: invSeenValid ? invSeenAt : null,
              ...(invSeenValid ? { lastSeenSource: "device-inventory" } : {}),
              notes: `Auto-discovered from FortiGate device inventory (${inv.device})`,
              tags: ["device-inventory", "auto-discovered"],
            },
          });
          assetIdx.add(newAsset);
          if (newAsset.hostname) invCreated.push({ id: newAsset.id, hostname: newAsset.hostname });
          inventoryAssets.push(inv.hostname || normalizedMac || inv.ipAddress);
          logDiscoveryAssetCreated(newAsset.id, inv.hostname || normalizedMac || inv.ipAddress, {
            integrationName, integrationId, sourceKind: "fortigate-endpoint", actor,
          });
          if (newAsset.assetType !== "firewall" && newAsset.assetType !== "switch" && newAsset.assetType !== "access_point") {
            fortigateEndpointAssetIds.add(newAsset.id);
            if (invIsLocal && inv.isOnline && inv.ipAddress && inv.device) {
              addressSightings.push({
                assetId: newAsset.id, mac: normalizedMac, ip: inv.ipAddress, source: "device-inventory",
                device: inv.device,
                medium: claimMedium({ wirelessEvidence: !!inv.apName, wiredEvidence: !!inv.switchName }),
                seenAt: invSeenAt,
              });
            }
            if (invIsLocal && inv.device) {
              bestGateClaimMsByAsset.set(newAsset.id, invSeenValid ? invSeenAt.getTime() : 0);
              noteEndpointGate(newAsset.id, inv.device);
            }
          }
        } catch (err: any) {
          syncLog("error", `Failed to create inventory asset ${inv.hostname || normalizedMac || inv.ipAddress}: ${err.message || "Unknown error"}`);
        }
      }
    }

    // ── Flush Phase 7's deferred writes ──────────────────────────────────────
    // One write per asset (already merged in accumulation order), through
    // mapSettledWithConcurrency rather than a transaction so one bad row costs its own
    // update and logs individually — the isolation the per-row try/catch gave.
    // Everything downstream (7.5 / 7.6 / 8 …) reads the DB after this point,
    // so it must land before the phase ends.
    if (pendingInvUpdates.size > 0) {
      const flush = [...pendingInvUpdates];
      const results = await mapSettledWithConcurrency(flush, 50, ([id, u]) =>
        prisma.asset.update({ where: { id }, data: u.data as any }),
      );
      for (let i = 0; i < results.length; i++) {
        const u = flush[i]![1];
        if (results[i].status === "rejected") {
          syncLog("error", `Failed to update inventory asset ${u.label.replace(" (updated)", "")}: ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
        } else {
          inventoryAssets.push(u.label);
        }
      }
    }
    if (pendingInvMacs.size > 0) {
      await mapSettledWithConcurrency([...pendingInvMacs], 50, ([assetId, macs]) => reconcileMacAddresses(assetId, macs));
    }
    if (invIpHistoryRefresh.length > 0) await refreshIpHistoryLastSeen(invIpHistoryRefresh);

    // Business rule 91(i): a created asset whose name another live asset
    // already carries — every bare-named member of that family whose name
    // discovery gave it becomes "<name>-<last 3 MAC octets>". After the flush
    // so the family read sees this run's writes; the in-memory row is renamed
    // too, because Phase 10 echoes it into the fortigate-endpoint source.
    if (invCreated.length > 0) {
      try {
        const renames = await planHostnameMacSuffixes(invCreated);
        const results = await mapSettledWithConcurrency(renames, 50, (r) =>
          prisma.asset.update({ where: { id: r.id }, data: { hostname: r.to } }),
        );
        for (let i = 0; i < renames.length; i++) {
          const r = renames[i]!;
          if (results[i]!.status === "rejected") {
            syncLog("error", `Failed to rename ${r.from} to ${r.to}: ${(results[i] as PromiseRejectedResult).reason?.message || "Unknown error"}`);
            continue;
          }
          const mem = assetIdx.findById(r.id);
          if (mem) { mem.hostname = r.to; assetIdx.reindex(mem); }
          logDiscoveryAssetUpdated({ hostname: r.from }, { hostname: r.to }, r.id, r.to, {
            integrationName, integrationId, sourceKind: "fortigate-endpoint", actor,
          });
        }
        if (renames.length > 0) syncLog("info", `Named ${renames.length} asset(s) apart by MAC: ${renames.map((r) => r.to).join(", ")}`);
      } catch (err: any) {
        syncLog("error", `Hostname MAC-suffix naming failed: ${err?.message || "Unknown error"}`);
      }
    }
  }
}
