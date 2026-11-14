/**
 * src/services/discovery/dhcp/firewallAssets.ts — syncDhcpSubnets Phase 3:
 * create or update one asset per FortiGate (and per HA member), matched by
 * serial in memory. Resolves coordinates once per device from the address
 * metavar or, when opted in, SNMP sysLocation through the geocoder, and can
 * push geocoded coords back to the gate; writes the fortigate-firewall
 * AssetSource row and projects the asset from its sources; sweeps a stale
 * endpoint ghost of the gate; stamps `monitored` from the integration's flag
 * (an HA standby is swept off, an operator override is kept). Geocode misses
 * are written as asset Events in one batch after the loop. CQ-B060; the body
 * moved verbatim, its free variables made parameters, and the nested
 * buildFortigateMonitorStamp (only Phase 3 calls it) moved with it, taking
 * the flag it used to capture as an argument. The engine's infra-source
 * closures and its two firewall source helpers are passed in, so this module
 * imports nothing from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type {
  AssetIndex,
  EntraSourceEntry,
  buildFortigateFirewallObservedBlob as BuildFortigateFirewallObservedBlob,
  upsertFortigateFirewallAssetSource as UpsertFortigateFirewallAssetSource,
} from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import {
  logEvent,
  snapshotMaterialAssetFields,
  logDiscoveryAssetCreated,
  logDiscoveryAssetUpdated,
} from "../../eventLogService.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import { fetchFortigateSysLocation } from "../../fortigateLocationService.js";
import { geocode, logGeocodeFailureEvents, type GeocodeFailure, type GeocodeFailureForAsset } from "../../geocoderService.js";
import { pushCoordsToFortigate } from "../../fortigateCoordPushService.js";
import { isValidGeoCoord, coordsClose } from "../../../utils/geo.js";
import { normalizeSerialKey } from "../../../utils/fortinetParentKey.js";
import { projectAssetFromSources } from "../../../utils/assetProjection.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../../utils/assetInvariants.js";
import { normalizeMacsDistinct } from "../../../utils/mac.js";
import { buildMacRowsForCreate, type MacJsonEntry } from "../../../utils/macAddresses.js";
import { sortNewestFirst } from "../../../utils/sortByTime.js";
import { reconcileMacAddresses } from "../../macAddressService.js";
import { pruneUnchangedAssetFields } from "../../../utils/assetWritePrune.js";
import { refreshIpHistoryLastSeen } from "../../assetIpHistoryService.js";
import { logger } from "../../../utils/logger.js";

/**
 * FortiGate-class equivalent (no enabled/credential branch — the FortiGate
 * integration always uses its own API token, no per-class credential to
 * stamp). HA standby members are actively swept to monitored=false: they
 * aren't probe-reachable (their Asset IP is nulled; the cluster IP routes
 * to the active member), so polling one is guaranteed-failure waste — and
 * without the sweep, a failover leaves the ex-primary monitored=true
 * forever, burning probe slots and raising false down noise. The flip-off
 * respects monitorOverride so an operator who deliberately pinned
 * monitoring on a standby (e.g. probing a dedicated HA mgmt interface via
 * dnsName) keeps their choice; the role flips on failover are what make
 * this a per-cycle sweep rather than a create-time default.
 */
function buildFortigateMonitorStamp(
  existing: { monitored?: boolean | null; monitorOverride?: boolean | null },
  isStandby: boolean,
  fortigateAddAsMonitored: boolean,
): Record<string, unknown> {
  if (existing.monitorOverride === true) return {};
  if (isStandby) {
    // consecutiveFailures reset mirrors the db.ts decommission/disable
    // clamp — don't let pre-failover probe-failure streaks linger.
    return existing.monitored === true ? { monitored: false, consecutiveFailures: 0 } : {};
  }
  const desired = fortigateAddAsMonitored;
  if (desired && existing.monitored !== true) return { monitored: true };
  if (!desired && existing.monitored === true) return { monitored: false };
  return {};
}

export async function syncFirewallAssets(input: {
  result: DiscoveryResult;
  assetIdx: AssetIndex;
  /** Appended to for the run's summary, as before. */
  assetNames: string[];
  now: string;
  /** Which switches / APs each gate's controller membership names this run. */
  membershipSwitchByDevice: Map<string, Set<string>>;
  membershipSwitchKnown: Set<string>;
  membershipApByDevice: Map<string, Set<string>>;
  membershipApKnown: Set<string>;
  /** The integration's FortiGate monitoring + location settings. */
  fortigateAddAsMonitored: boolean;
  pullSnmpLocation: boolean;
  useSnmpLocationCoords: boolean;
  pushGeocodedCoords: boolean;
  latitudeMetavar: string;
  longitudeMetavar: string;
  addressMetavar: string;
  integrationConfig: Record<string, unknown> | null;
  verboseLogging: boolean;
  /** The run's in-memory AssetSource map and the mirrors of what the upserts do to it. */
  infraSourcesOf: (assetId: string) => EntraSourceEntry[];
  /**
   * Loads one asset's source rows into the map when the per-gate prefetch
   * (assets matched by this gate's serials) did not cover it. Awaited at the
   * top of every update branch, before the map is read or mirrored.
   */
  ensureInfraSources: (assetId: string) => Promise<void>;
  applyInfraSourceInMemory: (
    assetId: string, sourceKind: string, externalId: string,
    observed: Record<string, unknown>, lastSeen: Date | null, syncedAt: Date,
  ) => void;
  dropInfraSourceKindInMemory: (assetId: string, sourceKind: string) => void;
  buildFortigateFirewallObservedBlob: typeof BuildFortigateFirewallObservedBlob;
  upsertFortigateFirewallAssetSource: typeof UpsertFortigateFirewallAssetSource;
  integrationId: string;
  integrationName: string;
  integrationType: string;
  integrationLabel: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, assetIdx, assetNames, now,
    membershipSwitchByDevice, membershipSwitchKnown, membershipApByDevice, membershipApKnown,
    fortigateAddAsMonitored, pullSnmpLocation, useSnmpLocationCoords, pushGeocodedCoords,
    latitudeMetavar, longitudeMetavar, addressMetavar, integrationConfig, verboseLogging,
    infraSourcesOf, ensureInfraSources, applyInfraSourceInMemory, dropInfraSourceKindInMemory,
    buildFortigateFirewallObservedBlob, upsertFortigateFirewallAssetSource,
    integrationId, integrationName, integrationType, integrationLabel, actor, syncLog,
  } = input;

  // IP-history refreshes for addresses the prune left out of a write (the
  // hook's per-write upsert, batched after the loop).
  const ipHistoryRefreshRows: Array<{ assetId: string; ip: string; source: string }> = [];
  // Geocode misses, one per firewall asset, written as asset Events after the
  // loop in one batch (logGeocodeFailureEvents dedupes against recent rows).
  const geocodeFailures: GeocodeFailureForAsset[] = [];
  for (const device of result.devices) {
    try {
      const fgHostname = device.hostname || device.name;
      // ─── Location → coords resolution (FortiGate-only, opt-in) ───────────
      // Resolved ONCE per device (not per HA member — cluster members are
      // physically co-located and share a location). Two opt-in sources feed
      // the geocoder; an address metavar (FMG-only) WINS when set + populated,
      // with SNMP sysLocation as the fallback. The geocoded coords feed the
      // observed blob for every member's AssetSource row and drive the
      // projection-tier-1 coord resolution; `snmpLocation` (when pulled) is
      // stored regardless for display on the asset General tab.
      const fgIsFortinet = isFortinetIntegrationType(integrationType);
      let devSnmpLocation: string | null = null;
      let devSnmpLocationFetchedAt: Date | null = null;
      let devGeocodedLat: number | null = null;
      let devGeocodedLng: number | null = null;
      // Address metavar string for this device (FMG-only; blank unless an
      // address metavar is configured AND populated on the device).
      const addressMetavarValue =
        addressMetavar && typeof device.metavarAddress === "string"
          ? device.metavarAddress.trim()
          : "";
      // Pull + store sysLocation whenever the toggle is on (independent of which
      // source ends up driving the coords).
      if (pullSnmpLocation && fgIsFortinet && integrationConfig) {
        devSnmpLocationFetchedAt = new Date();
        try {
          devSnmpLocation = await fetchFortigateSysLocation({
            integration: { id: integrationId, type: integrationType, config: integrationConfig },
            deviceName: device.name,
          });
        } catch (err: any) {
          syncLog("error", `${fgHostname}: SNMP location pull threw — ${err?.message || "Unknown error"}`);
        }
      }
      // Geocode source: address metavar wins; SNMP sysLocation is the
      // fallback ONLY when the operator opted into sysLocation-derived
      // coordinates (useSnmpLocationCoords) — the geocoded pair is
      // projection tier-1 and would otherwise silently override coords
      // learned from the device. With the toggle off, sysLocation is still
      // pulled + stored for display (Asset.snmpLocation) but never drives
      // the map pin.
      const snmpGeoCandidate = useSnmpLocationCoords ? (devSnmpLocation || "") : "";
      const geoString = addressMetavarValue || snmpGeoCandidate;
      const geoSource: "address-metavar" | "snmp" | null = addressMetavarValue ? "address-metavar" : (snmpGeoCandidate ? "snmp" : null);
      // Set when the lookup ran and resolved nothing; reported on each member
      // asset after the loop (logGeocodeFailureEvents).
      let devGeocodeFailure: GeocodeFailure | null = null;
      if (geoString) {
        try {
          const geo = await geocode(geoString);
          devGeocodeFailure = geo.failure;
          if (isValidGeoCoord(geo.latitude, geo.longitude)) {
            devGeocodedLat = geo.latitude;
            devGeocodedLng = geo.longitude;
            if (verboseLogging) {
              logger.info(
                { verbose: true, integrationId, deviceName: device.name, geoSource, location: geoString, lat: devGeocodedLat, lng: devGeocodedLng, provider: geo.provider, cached: geo.cached },
                "discovery.location.geocoded",
              );
            }
          }
        } catch (err: any) {
          syncLog("error", `${fgHostname}: Geocode of ${geoSource} "${geoString}" failed — ${err?.message || "Unknown error"}`);
        }
      }
      // Called once per member asset below, so every HA member's Events tab
      // carries the miss (each member has its own pin).
      const noteGeocodeFailure = (assetId: string, assetName: string): void => {
        if (!devGeocodeFailure || !geoSource) return;
        geocodeFailures.push({
          assetId, assetName, query: geoString, source: geoSource, failure: devGeocodeFailure,
          integrationId, integrationName, actor,
        });
      };
      // HA fan-out: when the cluster reports multiple members, write one
      // Asset row per physical member keyed on its own stable serial. Each
      // member's identity (serial + hostname) survives failover because we
      // never look up by `device.sn` (which flips on failover); we look up
      // by `member.serial`. The "current primary" is the member flagged
      // isPrimary=true — it holds the cluster IP and inherits the cluster's
      // top-level model/osVersion. Standby members get the same model/
      // osVersion (cluster members run identical builds) but ipAddress=null
      // since the cluster IP routes only to the active member.
      const haMembers = Array.isArray(device.haMembers) && device.haMembers.length > 0
        ? device.haMembers
        : null;
      const clusterMode: "standalone" | "a-p" | "a-a" = haMembers
        ? (device.haMode === "a-a" ? "a-a" : "a-p")
        : "standalone";
      // Build the per-iteration member list. For standalone, synthesize a
      // single primary-only entry so the loop body stays uniform.
      type MemberCtx = {
        serial: string;
        memberHostname: string;
        isPrimary: boolean;
        peerSerial: string | null;
        // Per-member health from the HA roster (FMG ha_slave[].status /
        // presence in FortiOS ha-peer). null = roster carried no signal.
        memberStatus: "up" | "down" | null;
      };
      const members: MemberCtx[] = haMembers
        ? haMembers.map((m) => {
            const others = haMembers.filter((x) => x.serial !== m.serial);
            return {
              serial: m.serial,
              memberHostname: m.name || (m.isPrimary ? fgHostname : ""),
              isPrimary: m.isPrimary,
              peerSerial: others[0]?.serial || null,
              memberStatus: m.status ?? null,
            };
          })
        : [{
            serial: device.serial || "",
            memberHostname: fgHostname,
            isPrimary: true,
            peerSerial: null,
            memberStatus: null,
          }];

      for (const member of members) {
        // Topology JSON is per-member. HA members carry haMode/haRole/
        // haPeerSerial so the asset edit modal + topology graph can show
        // the cluster relationship without re-querying FMG.
        // `deviceName` is the FMG/dvmdb device name (differs from the member
        // hostname on renamed devices and on HA members). Stamped so device-
        // targeted write paths (description sync, and any future push) can
        // build a transport without a dvmdb lookup; hostname stays the
        // display identity.
        // Managed-device membership, stamped on EVERY cluster member: an HA pair
        // is one logical controller and its switches/APs are cabled to both, so
        // both rows must carry the same member list (which is also what removes
        // any need for an HA carve-out in the dependency constraint).
        //
        // Only stamped when the roster ANSWERED. Absent means unknown, and the
        // whole-object replace below is what makes that self-correcting: a run
        // whose roster read failed simply omits the fields again.
        const membershipKey = (device.name || fgHostname || "").toLowerCase();
        const membershipStamp: Record<string, unknown> = {};
        if (membershipSwitchKnown.has(membershipKey)) {
          membershipStamp.managedSwitchSerials = [...(membershipSwitchByDevice.get(membershipKey) ?? [])];
        }
        if (membershipApKnown.has(membershipKey)) {
          membershipStamp.managedApSerials = [...(membershipApByDevice.get(membershipKey) ?? [])];
        }
        if (Object.keys(membershipStamp).length > 0) {
          membershipStamp.managedInventoryAt = new Date().toISOString();
        }
        const memberTopology: Record<string, unknown> = haMembers
          ? {
              role: "fortigate" as const,
              deviceName: device.name || fgHostname,
              haMode: clusterMode,
              haRole: member.isPrimary ? "primary" : "secondary",
              ...(member.peerSerial ? { haPeerSerial: member.peerSerial } : {}),
              // Roster-reported member health (see MemberCtx.memberStatus).
              // Drives the standby's "Standby" / "Standby Down" pill — the
              // only live health signal for a box the cluster IP never
              // routes to. Omitted (not nulled) when the roster carried no
              // signal so the UI can distinguish "healthy" from "unknown".
              ...(member.memberStatus ? { haMemberStatus: member.memberStatus } : {}),
              // Display-only cluster IP for the standby member. Deliberately
              // NOT Asset.ipAddress (which stays null on the standby): every
              // IP-keyed dedup/probe/reservation path assumes one asset per
              // IP, and any probe of this IP reaches the ACTIVE member.
              ...(!member.isPrimary && device.mgmtIp ? { haClusterIp: device.mgmtIp } : {}),
              ...membershipStamp,
            }
          : { role: "fortigate" as const, deviceName: device.name || fgHostname, ...membershipStamp };
        const memberHaCtx = haMembers && member.peerSerial
          ? {
              haMode: clusterMode as "a-p" | "a-a",
              haRole: (member.isPrimary ? "primary" : "secondary") as "primary" | "secondary",
              haPeerSerial: member.peerSerial,
            }
          : undefined;
        // Asset write payload's device-shape view — per-member fields. The
        // standby member gets ipAddress=null (cluster IP routes only to the
        // active member) but inherits the cluster's model/osVersion/geo
        // (members in an HA pair run identical hardware/firmware at the
        // same site).
        const memberDevice = {
          name: device.name,
          hostname: member.memberHostname || fgHostname,
          serial: member.serial,
          model: device.model,
          osVersion: device.osVersion,
          mgmtIp: member.isPrimary ? device.mgmtIp : "",
          // mgmt-interface MAC + all physical interface MACs, primary member
          // only — the resolved MACs belong to the box REST currently reaches
          // (the active member). Stamping them on the standby would be wrong.
          // Undefined for the standby + when the interface query surfaced none.
          mgmtMac: member.isPrimary ? device.mgmtMac : undefined,
          interfaceMacs: member.isPrimary ? device.interfaceMacs : undefined,
          latitude: device.latitude,
          longitude: device.longitude,
          // FMG-only metavars + per-device SNMP pull. Undefined when the
          // integration isn't FMG (standalone has no metavars) or the
          // toggles weren't enabled. The observed-blob helper coerces
          // missing/non-finite to null so the projection tier rules see a
          // consistent shape.
          metavarLatitude: device.metavarLatitude,
          metavarLongitude: device.metavarLongitude,
          snmpLocation: devSnmpLocation,
          snmpGeocodedLatitude: devGeocodedLat,
          snmpGeocodedLongitude: devGeocodedLng,
          metavarAddress: device.metavarAddress,
          geocodeFailure: devGeocodeFailure && geoSource
            ? { query: geoString, source: geoSource, reason: devGeocodeFailure.reason }
            : null,
          // True when this gate was offline in FMG and its config came from
          // FMG's cached CMDB (see fortimanagerService DiscoveredDevice.offline).
          // Config-only: withhold presence + decommission-resurrection below.
          offline: (device as { offline?: boolean }).offline === true,
        };
      // Match by serial first; fall back to hostname/IP for assets that
      // pre-date a serial (e.g. the placeholder created by registerFortinetHost
      // on integration create, which has no serialNumber). Mirrors how the
      // FortiSwitch and FortiAP discovery paths dedupe.
      // Fallback only fires for the primary member: standby members must
      // be keyed by serial (no legacy hostname/IP path could have created
      // a separate Asset for them).
      let existingAsset: any = member.serial ? assetIdx.findBySerial(member.serial) : null;
      if (!existingAsset && member.isPrimary) {
        existingAsset = assetIdx.findByEntry(undefined, fgHostname, device.mgmtIp || undefined);
      }
      // Serial-mismatch guard — same rule as the FortiSwitch/FortiAP loops:
      // the hostname/IP fallback exists for serial-less placeholder rows;
      // it must never bind to an asset carrying a DIFFERENT non-empty
      // serial (an RMA'd chassis keeping the old hostname is new hardware —
      // Phase 2a retires the old asset by serial).
      if (existingAsset && member.serial && existingAsset.serialNumber
          && normalizeSerialKey(existingAsset.serialNumber) !== normalizeSerialKey(member.serial)) {
        existingAsset = null;
      }
      if (existingAsset) {
        await ensureInfraSources(existingAsset.id);
        // Snapshot material fields before the branch mutates existingAsset in
        // place (macAddresses / status below) so the per-asset audit diff is
        // computed against the true pre-write state.
        const fwBefore = snapshotMaterialAssetFields(existingAsset);
        const fwPruneBase: Record<string, unknown> = { ...existingAsset };
        // Phase 3b.1 cutover: discovery-owned fields come from projection.
        // Same shape as AD/Entra cutovers — upsert source first, fetch all
        // sources, project, single Asset.update.
        if (member.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", syncedAt, memberHaCtx);
            await upsertFortigateFirewallAssetSource(existingAsset.id, integrationId, member.serial, observed, syncedAt, memberDevice.offline ? null : syncedAt);
            applyInfraSourceInMemory(existingAsset.id, "fortigate-firewall", member.serial, observed, memberDevice.offline ? null : syncedAt, syncedAt);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortigate-firewall AssetSource for ${memberDevice.hostname || device.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const fwSourceRows = infraSourcesOf(existingAsset.id);
        // Sweep any stale fortigate-endpoint source — a newly-deployed
        // FortiGate is often first sighted as a DHCP client of an existing
        // gate (endpoint source with the leased IP) before being adopted
        // into FMG; once the fortigate-firewall source exists that sighting
        // is a stale placeholder that would otherwise linger forever (the
        // endpoint pathways skip infra-typed assets, so it never refreshes
        // or clears). Parity with the FortiSwitch/FortiAP adoption sweeps.
        // Also excluded from this cycle's projection input so the mgmt IP
        // wins immediately rather than on the next run.
        let fwSourcesForProjection = fwSourceRows;
        if (fwSourceRows.some((s) => s.sourceKind === "fortigate-endpoint")) {
          fwSourcesForProjection = fwSourceRows.filter((s) => s.sourceKind !== "fortigate-endpoint");
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
            dropInfraSourceKindInMemory(existingAsset.id, "fortigate-endpoint");
          } catch { /* best-effort */ }
        }
        const { projected: fwProjected } = projectAssetFromSources(fwSourcesForProjection);

        const updateData: Record<string, unknown> = {
          // learnedLocation for firewalls: always the firewall's own
          // hostname. Deterministic overwrite (not `existing || hostname`)
          // so any rows polluted by the earlier SNMP-into-learnedLocation
          // experiment get healed on the next discovery cycle. The SNMP
          // sysLocation string is captured separately on Asset.snmpLocation
          // and surfaced on the details General tab.
          learnedLocation: memberDevice.hostname || fgHostname || existingAsset.learnedLocation,
          fortinetTopology: memberTopology,
          discoveredByIntegrationId: integrationId,
          // Correct assetType when the asset was created via a different
          // pathway (DHCP-client sighting, device-inventory) before FMG
          // adoption typed it — a serial-matched member of the firewall
          // roster IS a firewall. Mirrors the FortiSwitch/FortiAP blocks.
          ...(existingAsset.assetType !== "firewall" ? { assetType: "firewall" } : {}),
          // Resurrection: only a live-verified read may flip a decommissioned
          // firewall back to active. An offline gate's cached CMDB is NOT
          // presence evidence (business rule #12) — leave a decommissioned
          // firewall decommissioned when its config came from FMG's cache.
          ...(existingAsset.status === "decommissioned" && !memberDevice.offline ? { status: "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
        };
        // A firewall reaching this branch answered the FMG/REST queries that
        // produced this payload — that response is the presence evidence.
        // Exception: an offline gate's config came from FMG's cached CMDB, not
        // the device itself, so it is NOT presence — do not advance lastSeen.
        if (!memberDevice.offline) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Discovery-owned fields from projection.
        if (fwProjected.hostname !== null) updateData.hostname = fwProjected.hostname;
        if (fwProjected.model !== null) updateData.model = fwProjected.model;
        if (fwProjected.osVersion !== null) updateData.osVersion = fwProjected.osVersion;
        if (fwProjected.manufacturer !== null) updateData.manufacturer = fwProjected.manufacturer;
        if (fwProjected.serialNumber !== null) updateData.serialNumber = fwProjected.serialNumber;
        // Failover-resilient IP handling: only the current primary holds the
        // cluster IP. For the standby, explicitly null the IP — this is
        // a normal role swap on failover, not a conflict, so we bypass the
        // standard ip-source path. The standby's `monitored` flag stays
        // whatever the operator chose; an operator monitoring the cluster
        // IP via the primary asset doesn't get cross-bled to the standby.
        if (haMembers && !member.isPrimary) {
          updateData.ipAddress = null;
          updateData.ipSource = null;
        } else if (fwProjected.ipAddress !== null) {
          updateData.ipAddress = fwProjected.ipAddress;
          updateData.ipSource = memberDevice.hostname || fgHostname || integrationType;
        }
        // Operator-typed coordinates (coordSource="manual", set via the asset
        // edit form) outrank the projected device-side coords — skip the
        // write so discovery never clobbers a manual pin. Clearing the manual
        // pair resets coordSource to null, which re-opens this path.
        if (existingAsset.coordSource !== "manual") {
          if (fwProjected.latitude !== null) updateData.latitude = fwProjected.latitude;
          if (fwProjected.longitude !== null) updateData.longitude = fwProjected.longitude;
        }
        // SNMP sysLocation is projection-owned for display, but the
        // fetched-at timestamp lives outside the projection (no source
        // would naturally own it) — stamp it directly on Asset when we
        // pulled this cycle. Empty sysLocation still bumps fetchedAt so
        // the UI can show "checked X minutes ago, no value reported".
        if (devSnmpLocationFetchedAt) {
          updateData.snmpLocation = fwProjected.snmpLocation;
          updateData.snmpLocationFetchedAt = devSnmpLocationFetchedAt;
        }
        // Learned street address from the FMG address metavar. Only (re)written
        // when an address metavar is configured this cycle — mirrors the
        // snmpLocation "only when we looked" rule so an integration without an
        // address metavar never clobbers an address learned earlier. When the
        // metavar is configured but empty on this device, projection yields null
        // and the field is cleared.
        if (addressMetavar) {
          updateData.learnedAddress = fwProjected.learnedAddress;
        }
        // Backfill macAddress + AssetMacAddress from EVERY physical interface
        // MAC (primary member only). Mirrors the FortiSwitch backfill above.
        // A peer FortiGate can sight this firewall on any interface, so indexing
        // all of them is the only reliable way to stop discovery's MAC-keyed
        // paths (Phase 7 device-inventory, Phase 7.5 MAC-table) from spawning a
        // phantom `fortigate-endpoint` ghost. Idempotent — MACs already in
        // macList only get their lastSeen + source bumped. Scalar macAddress is
        // the mgmt-interface MAC (stable identity) when not already set.
        const fwMacs = normalizeMacsDistinct([memberDevice.mgmtMac, ...(memberDevice.interfaceMacs ?? [])]);
        let fwMacListForReconcile: MacJsonEntry[] | null = null;
        if (fwMacs.length) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          for (const mac of fwMacs) {
            const existingMacEntry = macList.find((m) => m.mac === mac);
            if (existingMacEntry) {
              existingMacEntry.lastSeen = now;
              existingMacEntry.source = "fortigate-firewall";
            } else {
              macList.push({ mac, lastSeen: now, source: "fortigate-firewall" });
            }
          }
          sortNewestFirst(macList, (e) => e.lastSeen);
          if (!existingAsset.macAddress) updateData.macAddress = memberDevice.mgmtMac || fwMacs[0];
          existingAsset.macAddresses = macList;
          fwMacListForReconcile = macList;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        // Auto-Monitor sweep: enforce monitored = fortigateAddAsMonitored on
        // every cycle unless the operator has set a divergent override.
        // Standby HA members are excluded.
        const isStandbyMember = haMembers != null && !member.isPrimary;
        Object.assign(updateData, buildFortigateMonitorStamp(existingAsset, isStandbyMember, fortigateAddAsMonitored));
        // Drop what the row already holds (efficiency audit, as Phases 6/7 do):
        // an unchanged device no longer re-sends hostname / IP / model and so
        // skips the db.ts hook chain those keys fire; a monitored one, whose
        // lastSeen discovery may not bump, usually needs no write at all.
        // Compared against the copy taken before this branch mutated the row.
        const { ipHistoryRefresh: fwIpRefresh } = pruneUnchangedAssetFields(fwPruneBase, updateData);
        if (fwIpRefresh) ipHistoryRefreshRows.push({ assetId: existingAsset.id, ...fwIpRefresh });
        if (Object.keys(updateData).length > 0) await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(fwBefore, updateData, existingAsset.id, memberDevice.hostname || device.name, {
          integrationName, integrationId, sourceKind: "fortigate-firewall", actor,
        });
        noteGeocodeFailure(existingAsset.id, memberDevice.hostname || device.name);
        // HA standby health transition. The roster status stamped into
        // memberTopology above is the standby's only live health signal
        // (probes route to the active member), so an up/unknown→down flip
        // gets a warning Event — the hook for event-trigger notification
        // rules — and the recovery an info Event. Primary members are
        // excluded (probes + upstream conn status cover them), as are
        // offline-in-FMG clusters (cached-CMDB roster is stale, not
        // evidence — same posture as the lastSeen/resurrection guards).
        if (!member.isPrimary && !memberDevice.offline && member.memberStatus) {
          const prevMemberStatus = (existingAsset.fortinetTopology as Record<string, unknown> | null)?.haMemberStatus;
          const memberLabel = `${memberDevice.hostname || member.serial} (${member.serial})`;
          if (member.memberStatus === "down" && prevMemberStatus !== "down") {
            logEvent({
              action: "asset.ha.standby_down", resourceType: "asset", resourceId: existingAsset.id,
              resourceName: memberDevice.hostname || device.name, actor, level: "warning",
              message: `[${integrationName}] HA standby ${memberLabel} reported DOWN in cluster ${device.name || fgHostname}'s HA roster`,
            });
          } else if (member.memberStatus === "up" && prevMemberStatus === "down") {
            logEvent({
              action: "asset.ha.standby_restored", resourceType: "asset", resourceId: existingAsset.id,
              resourceName: memberDevice.hostname || device.name, actor, level: "info",
              message: `[${integrationName}] HA standby ${memberLabel} is back UP in cluster ${device.name || fgHostname}'s HA roster`,
            });
          }
        }
        if (fwMacListForReconcile) {
          await reconcileMacAddresses(existingAsset.id, fwMacListForReconcile);
        }
        // Update in-memory index. For the primary, mirror the cluster IP +
        // active hostname back; for the standby, clear IP and use member
        // hostname so future lookups find each Asset by its stable identity.
        if (member.isPrimary && device.mgmtIp) existingAsset.ipAddress = device.mgmtIp;
        else if (haMembers && !member.isPrimary) existingAsset.ipAddress = null;
        if (memberDevice.hostname) existingAsset.hostname = memberDevice.hostname;
        if (device.model) existingAsset.model = device.model;
        if (!existingAsset.learnedLocation) existingAsset.learnedLocation = memberDevice.hostname || fgHostname;
        if (existingAsset.status === "decommissioned") existingAsset.status = "active";
        // Mirror the backfilled MACs so the same-cycle Phase 7 lookup finds
        // this firewall byMac (reindex below reads existingAsset.macAddress +
        // .macAddresses — the latter already holds every interface MAC from the
        // merge above), preventing a ghost even on first discovery.
        if (updateData.macAddress) existingAsset.macAddress = updateData.macAddress as string;
        assetIdx.reindex(existingAsset);
        assetNames.push(`${memberDevice.hostname || device.name}${haMembers ? ` (HA ${member.isPrimary ? "primary" : "secondary"})` : ""} (updated)`);
        continue;
      }

      // Phase 3b.1 cutover: project from a synthetic single-source array
      // built directly from this just-discovered firewall's observed blob.
      // Pure projection, no DB roundtrip — new asset has no other sources.
      const fwSyncedAt = new Date(now);
      const fwObserved = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", fwSyncedAt, memberHaCtx);
      const { projected: fwCreateProjected } = projectAssetFromSources([
        { sourceKind: "fortigate-firewall", inferred: false, observed: fwObserved },
      ]);
      const isStandbyCreate = haMembers != null && !member.isPrimary;
      // Distinct physical interface MACs to seed (mgmt MAC first as scalar
      // identity). Empty for the standby (memberDevice carries none) + when the
      // interface query surfaced nothing usable.
      const fwCreateMacs = normalizeMacsDistinct([memberDevice.mgmtMac, ...(memberDevice.interfaceMacs ?? [])]);
      const newAsset = await prisma.asset.create({
        data: {
          // Standby member: explicit null (cluster IP only routes to active).
          ipAddress: isStandbyCreate ? null : fwCreateProjected.ipAddress,
          ...(isStandbyCreate
            ? {}
            : (fwCreateProjected.ipAddress ? { ipSource: memberDevice.hostname || fgHostname || integrationType } : {})),
          hostname: fwCreateProjected.hostname || memberDevice.hostname || fgHostname,
          serialNumber: fwCreateProjected.serialNumber || member.serial || null,
          // Every physical interface MAC (primary member only — undefined for
          // the standby). Seeded on create so the next discovery cycle's
          // MAC-keyed dedup recognizes this firewall on whichever interface a
          // peer sighted it and never spawns a phantom `fortigate-endpoint`
          // asset. Scalar macAddress is the mgmt-interface MAC when present.
          ...(fwCreateMacs.length
            ? {
                macAddress: memberDevice.mgmtMac || fwCreateMacs[0],
                macAddressRows: { create: buildMacRowsForCreate(fwCreateMacs.map((mac) => ({ mac, lastSeen: now, source: "fortigate-firewall" }))) },
              }
            : {}),
          // Phase 4d: legacy `assetTag = fgt:<serial>` write retired —
          // AssetSource (sourceKind="fortigate-firewall", externalId=serial)
          // upserted just below is the canonical identity link.
          manufacturer: fwCreateProjected.manufacturer || "Fortinet",
          model: fwCreateProjected.model || "FortiGate",
          assetType: "firewall",
          status: "active",
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          department: "Network Security",
          // learnedLocation for firewalls: the firewall's own hostname.
          // Projection leaves this null for firewall sources by design —
          // set explicitly here. The SNMP sysLocation string is captured
          // separately on Asset.snmpLocation for the details General tab.
          learnedLocation: memberDevice.hostname || fgHostname,
          osVersion: fwCreateProjected.osVersion,
          // A first-seen offline gate's config came from FMG's cached CMDB, not
          // a live query — create it WITHOUT verified presence (lastSeen null),
          // like directory-only assets. A later live discovery cycle stamps it.
          ...(memberDevice.offline ? {} : { lastSeen: new Date(now), lastSeenSource: "discovery" }),
          // Stamp the discovering integration. The polling-method resolver
          // picks the source default (REST API for fortimanager / fortigate)
          // unless an operator overrides per-asset on the Monitoring tab.
          discoveredByIntegrationId: integrationId,
          // Auto-Monitored is opt-in via the integration's "Add Discovered
          // FortiGates as Monitored" checkbox. Standby HA members default
          // to monitored=false regardless — they aren't directly REST-
          // reachable through the cluster IP, so monitoring would just be
          // failed probes until failover. Operators can opt in per-asset.
          ...(fortigateAddAsMonitored && !isStandbyCreate ? { monitored: true } : {}),
          ...(fwCreateProjected.latitude !== null ? { latitude: fwCreateProjected.latitude } : {}),
          ...(fwCreateProjected.longitude !== null ? { longitude: fwCreateProjected.longitude } : {}),
          ...(fwCreateProjected.snmpLocation !== null ? { snmpLocation: fwCreateProjected.snmpLocation } : {}),
          ...(addressMetavar && fwCreateProjected.learnedAddress !== null ? { learnedAddress: fwCreateProjected.learnedAddress } : {}),
          ...(devSnmpLocationFetchedAt ? { snmpLocationFetchedAt: devSnmpLocationFetchedAt } : {}),
          fortinetTopology: memberTopology as any,
          notes: isStandbyCreate
            ? `Auto-discovered from ${integrationLabel} integration (HA standby member)`
            : `Auto-discovered from ${integrationLabel} integration`,
          tags: isStandbyCreate
            ? ["fortigate", "auto-discovered", "ha-standby"]
            : ["fortigate", "auto-discovered"],
        },
      });
      // Explicit fortigate-firewall AssetSource upsert with rich observed
      // blob. The Asset.create already triggered the shadow-write extension
      // which laid down a skeleton row from the assetTag — this overwrites
      // it with truth.
      if (member.serial) {
        try {
          const syncedAt = new Date(now);
          const observed = buildFortigateFirewallObservedBlob(memberDevice, integrationType as "fortimanager" | "fortigate", syncedAt, memberHaCtx);
          await upsertFortigateFirewallAssetSource(newAsset.id, integrationId, member.serial, observed, syncedAt, memberDevice.offline ? null : syncedAt);
          // Seed the mirror: a roster that lists the same device twice would
          // otherwise project the second visit from a map missing this row.
          applyInfraSourceInMemory(newAsset.id, "fortigate-firewall", member.serial, observed, memberDevice.offline ? null : syncedAt, syncedAt);
        } catch (err: any) {
          syncLog("error", `Created FortiGate asset ${memberDevice.hostname || device.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
        }
      }
      logDiscoveryAssetCreated(newAsset.id, memberDevice.hostname || device.name, {
        integrationName, integrationId, sourceKind: "fortigate-firewall", actor,
      });
      // First sighting of a standby that's ALREADY failed in the roster —
      // no prior topology stamp to diff against, so emit the warning
      // unconditionally (the update branch's transition guard takes over
      // from the next cycle).
      if (isStandbyCreate && !memberDevice.offline && member.memberStatus === "down") {
        logEvent({
          action: "asset.ha.standby_down", resourceType: "asset", resourceId: newAsset.id,
          resourceName: memberDevice.hostname || device.name, actor, level: "warning",
          message: `[${integrationName}] HA standby ${memberDevice.hostname || member.serial} (${member.serial}) reported DOWN in cluster ${device.name || fgHostname}'s HA roster`,
        });
      }
      assetIdx.add(newAsset);
      noteGeocodeFailure(newAsset.id, memberDevice.hostname || device.name);
      assetNames.push(`${memberDevice.hostname || device.name}${haMembers ? ` (HA ${member.isPrimary ? "primary" : "secondary"})` : ""}`);
      } // end inner for-member loop

      // ─── Geocoded-coords write-back (FortiGate-only, opt-in) ─────────────
      // Fires once per FortiGate (not per HA member — coord write is a
      // cluster-wide change). Only when the SNMP-geocode succeeded AND the
      // current FortiGate CMDB coords don't already match within tolerance.
      // Best-effort: failure is logged but doesn't unwind the Asset writes
      // that already landed.
      if (
        pushGeocodedCoords &&
        devGeocodedLat !== null &&
        devGeocodedLng !== null &&
        integrationConfig
      ) {
        const cmdbLat = device.latitude;
        const cmdbLng = device.longitude;
        const cmdbValid = isValidGeoCoord(cmdbLat, cmdbLng);
        const matches = cmdbValid && coordsClose(devGeocodedLat, devGeocodedLng, cmdbLat!, cmdbLng!);
        if (!matches) {
          try {
            const pushResult = await pushCoordsToFortigate(
              { id: integrationId, type: integrationType, config: integrationConfig },
              device.name,
              devGeocodedLat,
              devGeocodedLng,
              latitudeMetavar,
              longitudeMetavar,
            );
            if (pushResult.ok) {
              logEvent({
                action: "integration.coords.pushed",
                resourceType: "integration",
                resourceId: integrationId,
                resourceName: integrationName,
                actor,
                message: `[${integrationName}] Pushed geocoded coords ${devGeocodedLat.toFixed(6)},${devGeocodedLng.toFixed(6)} to ${fgHostname} (targets: ${pushResult.targets.join(", ")})`,
              });
            } else {
              logEvent({
                action: "integration.coords.push_failed",
                resourceType: "integration",
                resourceId: integrationId,
                resourceName: integrationName,
                actor,
                level: "warning",
                message: `[${integrationName}] Failed to push geocoded coords to ${fgHostname}: ${pushResult.error}`,
              });
            }
          } catch (err: any) {
            syncLog("error", `Coord write-back to ${fgHostname} threw — ${err?.message || "Unknown error"}`);
          }
        }
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for device ${device.name}: ${err.message || "Unknown error"}`);
    }
  }
  if (ipHistoryRefreshRows.length > 0) await refreshIpHistoryLastSeen(ipHistoryRefreshRows);
  await logGeocodeFailureEvents(geocodeFailures);
}
