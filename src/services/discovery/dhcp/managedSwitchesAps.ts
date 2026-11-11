/**
 * src/services/discovery/dhcp/managedSwitchesAps.ts — syncDhcpSubnets Phase
 * 3b: create or update one asset per FortiSwitch and FortiAP each gate
 * manages, plus the reservation at its address. Matched by serial first,
 * then by the MAC its own controller sees on its address (rules 91(e) /
 * 91(g)); a stale fortigate-endpoint ghost of the device is merged into it;
 * the per-class policy stamps credentials and sweeps `monitored`, honouring
 * an operator override; the controller stamp and the claim each gate makes
 * are recorded (rule 83, flushed by the caller). An AP's parent switch comes
 * from LLDP. CQ-B060; the body moved verbatim, its free variables made
 * parameters. The engine-defined helpers (findSubnetForIp, reservationKey) and
 * its infra-source closures are passed in, so this module imports nothing
 * from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex, EntraSourceEntry } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { ChangeBaselineFields } from "./changeEvents.js";
import type { ControllerClaimInput } from "../../duplicateSerialConflictService.js";
import { prisma } from "../../../db.js";
import type { upsertConflict as UpsertConflict, upsertFortinetInfraAssetSource as UpsertFortinetInfraAssetSource } from "../discoveryEngine.js";
import {
  logEvent,
  snapshotMaterialAssetFields,
  logDiscoveryAssetCreated,
  logDiscoveryAssetUpdated,
} from "../../eventLogService.js";
import { isMergeableEndpointGhost, mergeEndpointGhostIntoAsset } from "../../assetGhostMergeService.js";
import { releaseDnsResolvedAt } from "../../dnsResolvedReservationService.js";
import { persistManagedApLldpNeighbors, invalidateLldpMatchCache } from "../../monitoringService.js";
import { persistApRadioInventory } from "../../apRadioService.js";
import { reconcileMacAddresses } from "../../macAddressService.js";
import { buildGateMacIndex, fortiapGateMac, fortiswitchGateMac, isFortiapUnauthorized } from "../../../utils/fortiapGateMac.js";
import { isFortiapStatusOnline } from "../../../utils/fortiapMonitorRow.js";
import { reservationBelongsToInfraDevice } from "../../../utils/infraDhcpBinding.js";
import { normalizeMacOrNull } from "../../../utils/mac.js";
import { normalizeSerialKey } from "../../../utils/fortinetParentKey.js";
import { projectAssetFromSources } from "../../../utils/assetProjection.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../../../utils/assetInvariants.js";
import { buildMacRowsForCreate, type MacJsonEntry } from "../../../utils/macAddresses.js";
import { sortNewestFirst } from "../../../utils/sortByTime.js";

// Source-shaped observed blob for managed FortiSwitch assets. Mirrors the
// per-source JSON shape sketched in polaris-monitoring-discovery -> discovery-fortinet.md ("Per-source observed shapes
// / sourceKind: fortiswitch"). Companion to the firewall blob above.
function buildFortiswitchObservedBlob(
  sw: { device?: string; deviceSerial?: string; name?: string; serial?: string; ipAddress?: string; fgtInterface?: string; osVersion?: string; joinTime?: number; state?: string; connected?: boolean; baseMac?: string; description?: string | null },
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "fortiswitch",
    syncedAt: syncedAt.toISOString(),
    serial: sw.serial || null,
    switchId: sw.name || null,
    model: "FortiSwitch",
    osVersion: sw.osVersion || null,
    mgmtIp: sw.ipAddress || null,
    // Admin description from the managed-switch CMDB — carries a:/b:/f:/r:/jb:
    // location codes (utils/locationCodes.ts). Sources-tab truth; the
    // projected copy lives on fortinetTopology.deviceDescription.
    description: sw.description || null,
    // Management MAC of the switch: the MAC its controller sees at
    // `connecting_from` (business rule 91(g), stamped by the FortiSwitch loop
    // before this blob is built). Null when the gate's lease / ARP / online
    // inventory had no single answer for that address.
    baseMac: sw.baseMac || null,
    controllerFortigate: sw.device || null,
    controllerSerial: sw.deviceSerial || null,
    uplinkInterface: sw.fgtInterface || null,
    state: sw.state || null,
    connected: typeof sw.connected === "boolean" ? sw.connected : null,
    joinTime: Number.isFinite(sw.joinTime) && sw.joinTime ? new Date(sw.joinTime * 1000).toISOString() : null,
  };
}

// Source-shaped observed blob for managed FortiAP assets.
function buildFortiapObservedBlob(
  ap: {
    device?: string;
    deviceSerial?: string;
    name?: string;
    serial?: string;
    model?: string;
    ipAddress?: string;
    baseMac?: string;
    status?: string;
    authorizationState?: string;
    profile?: string;
    osVersion?: string;
    peerSwitch?: string;
    peerPort?: string;
    peerVlan?: number;
    peerSource?: "lldp" | "detected-device";
    meshUplink?: "ethernet" | "mesh";
    parentApSerial?: string;
    apUplinkInterface?: string;
    cpuPct?: number;
    memFreeMb?: number;
    memTotalMb?: number;
    sensorTemperatures?: Array<{ name: string; celsius: number }>;
    description?: string | null;
  },
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: "fortiap",
    syncedAt: syncedAt.toISOString(),
    serial: ap.serial || null,
    name: ap.name || null,
    model: ap.model || null,
    osVersion: ap.osVersion || null,
    mgmtIp: ap.ipAddress || null,
    baseMac: ap.baseMac || null,
    status: ap.status || null,
    // Admin description (wtp `comment`) — carries a:/b:/f:/r:/jb: location
    // codes. Mirrors the fortiswitch blob's `description` field.
    description: ap.description || null,
    // Controller admission state ("authorized" / "discovered" / ...) —
    // mirrors the fortiswitch blob's `state` field.
    state: ap.authorizationState || null,
    // AP profile the controller binds this WTP to — the object that decides
    // its radios, SSIDs and power.
    profile: ap.profile || null,
    controllerFortigate: ap.device || null,
    controllerSerial: ap.deviceSerial || null,
    parentSwitch: ap.peerSwitch || null,
    parentPort: ap.peerPort || null,
    parentVlan: typeof ap.peerVlan === "number" ? ap.peerVlan : null,
    // AP's own local port (lan1, lan2, wbh0 …) from wan_status.interface
    // or, when wan_status is empty, the LLDP entry's local_port. lan*
    // are physical Ethernet, wbh* are virtual wireless bridge.
    uplinkInterface: ap.apUplinkInterface ?? null,
    // Provenance for the parentSwitch/parentPort pair: "lldp" (authoritative,
    // from the AP's own LLDP table) or "detected-device" (FortiSwitch MAC
    // table fallback).
    peerSource: ap.peerSource ?? null,
    // Mesh topology — populated for wireless-mesh leaves.
    meshUplink: ap.meshUplink ?? null,
    parentApSerial: ap.parentApSerial ?? null,
    // Live telemetry snapshot at the moment of discovery. Not authoritative
    // for charts (the telemetry cadence re-queries the same endpoint), but
    // surfaced on the Sources tab so operators can see fresh values
    // immediately after a discovery run.
    cpuPct: typeof ap.cpuPct === "number" ? ap.cpuPct : null,
    memFreeMb: typeof ap.memFreeMb === "number" ? ap.memFreeMb : null,
    memTotalMb: typeof ap.memTotalMb === "number" ? ap.memTotalMb : null,
    sensorTemperatures: ap.sensorTemperatures ?? null,
  };
}

// Device admin description stamp for managed FortiSwitches/FortiAPs. The
// description carries a:/b:/f:/r:/jb: location codes (see
// utils/locationCodes.ts); it's stamped onto fortinetTopology.deviceDescription
// unconditionally every cycle for the Device Map's code resolution
// (Asset.description → deviceDescription). Asset.notes is operator-only:
// the former description→notes mirror (and its notesSyncedFrom provenance
// marker) was removed 2026-07 — discovery seeds notes with the
// auto-discovered boilerplate at CREATION only and never writes them again.
function buildDeviceDescriptionStamp(
  description: string | null | undefined,
): { deviceDescription: string | null } {
  const device = typeof description === "string" && description.trim() ? description.trim() : null;
  return { deviceDescription: device };
}

/** The per-class (FortiSwitch / FortiAP) monitoring policy an integration configures. */
export type ClassMonCfg = {
  enabled: boolean;
  snmpCredentialId: string | null;
  sshCredentialId:  string | null;
  addAsMonitored:   boolean;
  // Pre-resolved credential ID to stamp; null = don't stamp.
  stampCredentialId: string | null;
};

export async function syncManagedSwitchesAndAps(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey; updated in place. */
  activeResMap: Map<string, any>;
  assetIdx: AssetIndex;
  /** Appended to for the run's summary, as before. */
  assetNames: string[];
  reservationNames: string[];
  /** This pass's controller claims (rule 83); the caller flushes them after Phase 3c. */
  controllerClaims: ControllerClaimInput[];
  now: string;
  switchMonitorCfg: ClassMonCfg;
  apMonitorCfg: ClassMonCfg;
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  projectRefLabel: string;
  /** The run's in-memory AssetSource map and the mirrors of what the upserts do to it. */
  infraSourcesOf: (assetId: string) => EntraSourceEntry[];
  infraPriorObserved: (assetId: string, sourceKind: string, externalId: string) => Record<string, unknown> | null;
  applyInfraSourceInMemory: (
    assetId: string, sourceKind: string, externalId: string,
    observed: Record<string, unknown>, lastSeen: Date | null, syncedAt: Date,
  ) => void;
  noteChangeBaseline: (asset: any, fields: ChangeBaselineFields[]) => void;
  upsertConflict: typeof UpsertConflict;
  upsertFortinetInfraAssetSource: typeof UpsertFortinetInfraAssetSource;
  integrationId: string;
  integrationName: string;
  integrationType: string;
  integrationLabel: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, activeResMap, assetIdx, assetNames, reservationNames, controllerClaims, now,
    switchMonitorCfg, apMonitorCfg, findSubnetForIp, reservationKey, projectRefLabel,
    infraSourcesOf, infraPriorObserved, applyInfraSourceInMemory, noteChangeBaseline,
    upsertConflict, upsertFortinetInfraAssetSource,
    integrationId, integrationName, integrationType, integrationLabel, actor, syncLog,
  } = input;

  // Auto-stamping policy for managed FortiSwitch / FortiAP. `enabled` drives
  // credential stamping (direct polling SNMP/SSH); `addAsMonitored` drives
  // the bidirectional `monitored` sweep through the monitor-override model.
  //
  //   enabled=false, addAsMonitored=false  → ensure monitored=false (sweep off)
  //   enabled=false, addAsMonitored=true   → stamp monitored=true; resolver
  //                                          falls back to the source default
  //                                          (ICMP) since no credential is
  //                                          configured for this class
  //   enabled=true,  addAsMonitored=false  → stamp monitorCredentialId AND
  //                                          ensure monitored=false (sweep off)
  //   enabled=true,  addAsMonitored=true   → stamp credential AND flip
  //                                          monitored=true (sweep on)
  //
  // Monitor-override semantics: when the operator's current `monitored`
  // diverges from `addAsMonitored`, `Asset.monitorOverride` is true and
  // discovery leaves `monitored` alone (operator wins). When they match,
  // override is false and discovery enforces `monitored = addAsMonitored`
  // on every cycle. Credentials are still preserved when the operator
  // pointed at a different one (a soft override on credential identity).
  function buildClassMonitorStamp(
    cfg: ClassMonCfg,
    existing?: { monitorCredentialId?: string | null; monitored?: boolean | null; monitorOverride?: boolean | null },
  ): Record<string, unknown> {
    if (!cfg.enabled && !cfg.addAsMonitored && existing?.monitored !== true) {
      // No opt-in and the asset isn't currently monitored — nothing to do.
      // (Integration attribution is NOT this function's job: the switch/AP
      // create + update paths stamp `discoveredByIntegrationId`
      // unconditionally themselves, so the Inherit-from-integration option
      // and the decommission sweep work regardless of this toggle.)
      return {};
    }

    const stamp: Record<string, unknown> = {};
    // Stamp the integration's class credential only when the existing
    // asset has none (or has the same credential — the no-op idempotent
    // case). Anything else (operator-chosen credential of a different
    // type or pointing elsewhere) is preserved.
    //
    // The credential to stamp is pre-resolved into stampCredentialId based
    // on the integration's responseTimePolling: SSH polling stamps the SSH
    // credential, anything else stamps the SNMP credential.
    if (cfg.enabled && cfg.stampCredentialId) {
      const existingCred = existing?.monitorCredentialId ?? null;
      if (existingCred === null || existingCred === cfg.stampCredentialId) {
        stamp.monitorCredentialId = cfg.stampCredentialId;
      }
      // Operator-chosen credential pointing elsewhere stays in place; we
      // still continue to the monitored sweep below (credential identity
      // is a separate concern from the monitored bit).
    }
    // Monitored sweep: discovery enforces `monitored = addAsMonitored`
    // unless the operator has set an override. New assets land here with
    // `monitorOverride=false` (Prisma default) and `monitored=false`, so
    // the integration's flag still picks the initial state cleanly.
    if (existing?.monitorOverride !== true) {
      const desired = cfg.addAsMonitored === true;
      if (desired && existing?.monitored !== true) {
        stamp.monitored = true;
      } else if (!desired && existing?.monitored === true) {
        stamp.monitored = false;
      }
    }
    return stamp;
  }

  /**
   * Sibling endpoint-ghost sweep for the FortiSwitch / FortiAP loops below.
   *
   * A managed device's mgmt interface pulls a DHCP lease from its FortiGate,
   * so the DHCP / device-inventory pathway learns the MAC independently and
   * creates a separate "fortigate-endpoint" asset — hostname = the device
   * serial (that's what device inventory reports for the mgmt MAC). Once the
   * real infrastructure asset exists, the serial match above resolves it
   * FIRST every cycle, so the MAC / hostname adoption fallbacks never run
   * against the ghost and it survives forever (the lease pathway keeps
   * freshening it, and the duplicate-hostname job can't group it — the two
   * rows have different hostnames).
   *
   * Candidates are the strong-identity lookups only (the device's base MAC,
   * an asset hostnamed exactly the device serial) — never bare IP, which
   * recycles. Each candidate is validated against its AssetSource rows
   * (fortigate-endpoint provenance, nothing authoritative) before the merge,
   * so a hand-created asset or a real discovered device can never be
   * absorbed. Best-effort: a sweep failure never fails the device sync.
   */
  async function sweepEndpointGhostsInto(
    canonical: any,
    candidates: Array<any | undefined>,
    deviceLabel: string,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const ghost of candidates) {
      if (!ghost || ghost.id === canonical.id || seen.has(ghost.id)) continue;
      seen.add(ghost.id);
      try {
        if (!(await isMergeableEndpointGhost(ghost.id))) continue;
        const res = await mergeEndpointGhostIntoAsset(canonical.id, ghost.id);
        assetIdx.remove(ghost);
        if (res.adoptedMac && !canonical.macAddress) canonical.macAddress = res.adoptedMac;
        if (res.transferredMonitored) canonical.monitored = true;
        assetIdx.reindex(canonical);
        syncLog("info", `Merged duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}`);
        logEvent({
          action: "asset.duplicate_merged",
          resourceType: "asset",
          resourceId: canonical.id,
          resourceName: canonical.hostname ?? deviceLabel,
          actor,
          level: "info",
          message: `Discovery merged duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}`,
          details: {
            integrationId,
            integrationName,
            ghostId: ghost.id,
            ghostHostname: ghost.hostname ?? null,
            adoptedMac: res.adoptedMac,
            transferredMonitored: res.transferredMonitored,
          },
        });
      } catch (err: any) {
        syncLog("error", `Failed to merge duplicate endpoint asset ${ghost.hostname || ghost.id} into ${deviceLabel}: ${err?.message || "Unknown error"}`);
      }
    }
  }

  // Controller claims for THIS pass (business rule 83). Every managed switch
  // and AP this run saw, paired with the gate that reported it — the evidence
  // `AssetSource` cannot hold, because its `(sourceKind, externalId)` key is
  // unique on the DEVICE serial and a second claiming gate therefore overwrites
  // the first instead of colliding with it. Accumulated in memory and flushed
  // once below rather than written per device: at 2000 managed devices a round
  // trip inside these loops would add 2000 sequential awaits to the run.
  const noteControllerClaim = (
    assetId: string,
    deviceSerial: string | null | undefined,
    sourceKind: "fortiswitch" | "fortiap",
    controllerDevice: string | null | undefined,
    controllerSerial: string | null | undefined,
  ): void => {
    if (!deviceSerial || !controllerDevice) return;
    controllerClaims.push({
      assetId,
      deviceSerial,
      sourceKind,
      controllerDevice,
      controllerSerial: controllerSerial || null,
      integrationId,
    });
  };

  // Business rules 91(e) / 91(g): the MAC a managed switch's or AP's OWN
  // controller sees on the address the device reports (its online inventory
  // row, dynamic lease or ARP entry there). One index for both loops, so an
  // address a switch and an AP on one gate both report identifies neither.
  const gateMacIndex = buildGateMacIndex({
    leases: result.dhcpEntries || [],
    inventory: result.deviceInventory || [],
    arp: result.arpTable || [],
    aps: result.fortiAps || [],
    switches: result.fortiSwitches || [],
  });

  for (const sw of result.fortiSwitches || []) {
    const swStatus = sw.state === "Unauthorized" ? "storage" : "active";
    const swJoinDate = sw.joinTime && Number.isFinite(sw.joinTime) && sw.joinTime > 0
      ? new Date(sw.joinTime * 1000) : null;
    const swNotes = `Auto-discovered from FortiGate ${sw.device}${sw.fgtInterface ? ` via ${sw.fgtInterface}` : ""} via ${integrationLabel}`;
    // Management MAC: what the switch's own controller sees at its
    // `connecting_from` address (rule 91(g)). Stamped onto `sw` so the
    // fortiswitch source blob records it. Used for the orphan-endpoint dedup
    // lookup below and to seed Asset.macAddress / macAddressRows.
    sw.baseMac = fortiswitchGateMac(gateMacIndex, sw) ?? undefined;
    const normalizedSwMac = normalizeMacOrNull(sw.baseMac);
    // The endpoint twin holding that MAC, looked up BEFORE this loop
    // reindexes the switch — reindexing re-points the MAC at the switch, and
    // a lookup afterwards finds only the switch itself.
    const swMacTwin = normalizedSwMac ? assetIdx.findByMac(normalizedSwMac) : undefined;
    try {
      let existingAsset: any = sw.serial ? assetIdx.findBySerial(sw.serial) : null;
      // MAC fallback before name/IP fallback — adopts an orphan
      // "fortigate-endpoint" asset that was created by the DHCP/ARP/MAC-table
      // pathway at this switch's mgmt IP before FortiSwitch discovery linked
      // it up. The inline retype-and-sweep block below converts the
      // adopted asset to assetType="switch" and removes the stale
      // fortigate-endpoint source row.
      if (!existingAsset && normalizedSwMac) existingAsset = assetIdx.findByMac(normalizedSwMac);
      if (!existingAsset && sw.name) existingAsset = assetIdx.findByEntry(undefined, sw.name, sw.ipAddress || undefined);
      // Serial-mismatch guard — same rule as the FortiAP loop: a fallback
      // (MAC/name/IP) match must never bind to an asset carrying a
      // DIFFERENT non-empty serial (RMA'd replacement hardware inheriting
      // the old unit's address). Serial-less orphan adoption still binds.
      if (existingAsset && sw.serial && existingAsset.serialNumber
          && normalizeSerialKey(existingAsset.serialNumber) !== normalizeSerialKey(sw.serial)) {
        existingAsset = null;
      }

      const swTopology = {
        role: "fortiswitch" as const,
        controllerFortigate: sw.device || null,
        // Definitive controller identity — see resolveInfraParentAsset in
        // utils/fortinetParentKey.ts. `controllerFortigate` is FMG's device
        // NAME, which routinely differs from the gate's configured hostname
        // (and therefore from Asset.hostname); the serial does not.
        controllerSerial: sw.deviceSerial || null,
        uplinkInterface: sw.fgtInterface || null,
        // Controller admission state ("Authorized" | "Unauthorized"). Also
        // drives the create-path status→storage flip below; surfaced as the
        // Authorization row on the asset details General tab.
        state: sw.state || null,
        // Physical uplink port to the controller FortiGate (e.g. "port47"),
        // from the managed-switch CMDB. Distinct from uplinkInterface (the
        // FortiGate-side logical "fortilink"). Lets the Device Map label the
        // FG↔switch edge's switch side with the real port. Null for chained /
        // dual-homed switches (left to LLDP). See findFortiswitchUplinkPorts.
        uplinkPhysicalPort: sw.uplinkPhysicalPort ?? null,
        // Raw admin description from the managed-switch CMDB (a:/b:/f:/r:/jb:
        // location codes for the Device Map). Notes are operator-only.
        ...buildDeviceDescriptionStamp(sw.description),
      };
      if (existingAsset) {
        // Snapshot before the branch retypes assetType / mutates status below.
        const swBefore = snapshotMaterialAssetFields(existingAsset);
        const acquiredAtUpdate = swJoinDate && (!existingAsset.acquiredAt || swJoinDate < new Date(existingAsset.acquiredAt))
          ? swJoinDate : undefined;
        // Re-discovery resurrects a previously-decommissioned asset back to
        // its current FortiOS-reported state (active or storage). Mirrors
        // the FortiAP path right below.
        const reactivate = existingAsset.status === "decommissioned";

        // Phase 3b.1 cutover: projection-driven discovery fields.
        if (sw.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortiswitchObservedBlob(sw, syncedAt);
            await upsertFortinetInfraAssetSource("fortiswitch", existingAsset.id, integrationId, sw.serial, observed, syncedAt, syncedAt, integrationName, infraPriorObserved(existingAsset.id, "fortiswitch", sw.serial));
            applyInfraSourceInMemory(existingAsset.id, "fortiswitch", sw.serial, observed, syncedAt, syncedAt);
            noteControllerClaim(existingAsset.id, sw.serial, "fortiswitch", sw.device, sw.deviceSerial);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortiswitch AssetSource for ${sw.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const { projected: swProjected } = projectAssetFromSources(infraSourcesOf(existingAsset.id));

        const updateData: Record<string, unknown> = {
          // Resurrection of a decommissioned switch requires it to be
          // connected right now; ordinary active↔storage state sync is
          // unaffected. A maintenance-window asset is scheduler-owned —
          // never write status over it (the maintenanceScheduler restores
          // the right state when the window ends).
          ...(existingAsset.status !== "maintenance" &&
          (existingAsset.status !== "decommissioned" || sw.connected)
            ? {
                status: swStatus,
                ...(swStatus !== existingAsset.status ? { statusChangedAt: new Date(now), statusChangedBy: integrationLabel } : {}),
              }
            : {}),
          fortinetTopology: swTopology,
          ...(acquiredAtUpdate ? { acquiredAt: acquiredAtUpdate } : {}),
          ...buildClassMonitorStamp(switchMonitorCfg, existingAsset),
          // Attribution is unconditional for managed infrastructure — the
          // Monitoring tab's "Inherit from <integration>" option, the
          // monitor-settings tier-3 resolution, and the Phase 2b
          // decommission sweep all key off this column, so it must not
          // depend on the class-monitor toggle (buildClassMonitorStamp only
          // stamps it when that's enabled). Mirrors the FortiGate paths.
          ...(existingAsset.discoveredByIntegrationId !== integrationId
            ? { discoveredByIntegrationId: integrationId }
            : {}),
        };
        // Presence gate: the managed-switch table includes FortiLink-
        // configured switches that are currently offline (status !=
        // "Connected"). Only a connected switch is evidence it's on the wire.
        if (sw.connected) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Correct assetType when an existing asset was created via a different
        // pathway (device-inventory, DHCP) before FortiSwitch discovery linked
        // up. Without this, the asset stays "other" forever and the endpoint
        // pathway keeps stamping a stale fortigate-endpoint source on it.
        if (existingAsset.assetType !== "switch") {
          updateData.assetType = "switch";
          // Sweep the stale fortigate-endpoint source — it was a placeholder
          // created when this asset was misclassified. The fortiswitch source
          // upserted just above is now the canonical record.
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
          } catch { /* best-effort */ }
          existingAsset.assetType = "switch";
        }
        if (swProjected.hostname !== null) updateData.hostname = swProjected.hostname;
        if (swProjected.osVersion !== null) updateData.osVersion = swProjected.osVersion;
        if (swProjected.manufacturer !== null) updateData.manufacturer = swProjected.manufacturer;
        if (swProjected.serialNumber !== null) updateData.serialNumber = swProjected.serialNumber;
        if (swProjected.learnedLocation !== null) updateData.learnedLocation = swProjected.learnedLocation;
        if (swProjected.ipAddress !== null) {
          updateData.ipAddress = swProjected.ipAddress;
          updateData.ipSource = sw.device || integrationType;
        }
        // Backfill macAddress + AssetMacAddress when we know the switch's
        // management MAC from this discovery and the existing asset doesn't
        // carry it yet. Mirrors the merge pattern Phase 7 uses for endpoints
        // (lines 4626-4648 + 4660-4662) so the next discovery cycle's
        // MAC-keyed dedup finds this switch. Idempotent — when the MAC is
        // already in macList, only its lastSeen + source are bumped.
        let swMacListForReconcile: MacJsonEntry[] | null = null;
        if (normalizedSwMac) {
          const macList: MacJsonEntry[] = Array.isArray(existingAsset.macAddresses) ? [...(existingAsset.macAddresses as any)] : [];
          const existingMacEntry = macList.find((m) => m.mac === normalizedSwMac);
          if (existingMacEntry) {
            existingMacEntry.lastSeen = now;
            existingMacEntry.source = "fmg-discovery";
            if (sw.device) existingMacEntry.device = sw.device;
          } else {
            macList.push({ mac: normalizedSwMac, lastSeen: now, source: "fmg-discovery", ...(sw.device ? { device: sw.device } : {}) });
          }
          sortNewestFirst(macList, (e) => e.lastSeen);
          if (!existingAsset.macAddress) updateData.macAddress = macList[0].mac;
          existingAsset.macAddresses = macList;
          swMacListForReconcile = macList;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(swBefore, updateData, existingAsset.id, sw.name || sw.serial, {
          integrationName, integrationId, sourceKind: "fortiswitch", actor,
        });
        if (swMacListForReconcile) {
          await reconcileMacAddresses(existingAsset.id, swMacListForReconcile);
        }
        if (sw.ipAddress) existingAsset.ipAddress = sw.ipAddress;
        // Phase 6/7's serial rung (rule 91(c)) reads the stamp off this object.
        existingAsset.fortinetTopology = swTopology;
        if (reactivate && sw.connected) existingAsset.status = swStatus;
        if (existingAsset.discoveredByIntegrationId !== integrationId) existingAsset.discoveredByIntegrationId = integrationId;
        assetIdx.reindex(existingAsset);
        await sweepEndpointGhostsInto(existingAsset, [
          swMacTwin,
          sw.serial ? assetIdx.findByEntry(undefined, sw.serial) : undefined,
        ], sw.name || sw.serial);
        assetNames.push(`${sw.name} (updated${reactivate ? " — reactivated" : ""})`);
      } else {
        // Phase 3b.1 cutover: project from a synthetic single-source array.
        const swSyncedAt = new Date(now);
        const swObserved = buildFortiswitchObservedBlob(sw, swSyncedAt);
        const { projected: swCreateProjected } = projectAssetFromSources([
          { sourceKind: "fortiswitch", inferred: false, observed: swObserved },
        ]);
        const createData: Record<string, unknown> = {
          ipAddress: swCreateProjected.ipAddress,
          ...(swCreateProjected.ipAddress ? { ipSource: sw.device || integrationType } : {}),
          // Management MAC from the detected-device fortilink-peer cross-join.
          // Seeded here so the next discovery cycle's MAC-keyed dedup
          // (Phase 7 device-inventory, Phase 7.5 MAC-table enrichment, and
          // the new MAC-fallback lookup above) recognizes this switch and
          // doesn't spawn a phantom fortigate-endpoint asset alongside it.
          macAddress: normalizedSwMac,
          ...(normalizedSwMac
            ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedSwMac, lastSeen: now, source: "fmg-discovery" }]) } }
            : {}),
          hostname: swCreateProjected.hostname,
          serialNumber: swCreateProjected.serialNumber,
          manufacturer: swCreateProjected.manufacturer || "Fortinet",
          // FortiSwitch's observed.model is always literally "FortiSwitch"
          // and the projection skips it as too generic. Keep the legacy
          // literal here so the create row gets a non-null model.
          model: "FortiSwitch",
          assetType: "switch",
          // Unconditional attribution — see the update-path comment above.
          discoveredByIntegrationId: integrationId,
          status: swStatus,
          statusChangedAt: new Date(now),
          statusChangedBy: integrationLabel,
          osVersion: swCreateProjected.osVersion,
          ...buildClassMonitorStamp(switchMonitorCfg),
          learnedLocation: swCreateProjected.learnedLocation,
          acquiredAt: swJoinDate,
          ...(sw.connected ? { lastSeen: new Date(now), lastSeenSource: "discovery" } : {}),
          fortinetTopology: swTopology,
          // Notes are operator-only — seed the auto-discovered boilerplate at
          // creation; discovery never writes notes again after this.
          notes: swNotes,
          tags: ["fortiswitch", "auto-discovered"],
        };
        clampAcquiredToLastSeen(createData);
        const newAsset = await prisma.asset.create({ data: createData as any });
        if (sw.serial) {
          try {
            await upsertFortinetInfraAssetSource("fortiswitch", newAsset.id, integrationId, sw.serial, swObserved, swSyncedAt, swSyncedAt, integrationName);
            applyInfraSourceInMemory(newAsset.id, "fortiswitch", sw.serial, swObserved, swSyncedAt, swSyncedAt);
            noteControllerClaim(newAsset.id, sw.serial, "fortiswitch", sw.device, sw.deviceSerial);
          } catch (err: any) {
            syncLog("error", `Created FortiSwitch asset ${sw.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
          }
        }
        logDiscoveryAssetCreated(newAsset.id, sw.name || sw.serial, {
          integrationName, integrationId, sourceKind: "fortiswitch", actor,
        });
        assetIdx.add(newAsset);
        await sweepEndpointGhostsInto(newAsset, [
          swMacTwin,
          sw.serial ? assetIdx.findByEntry(undefined, sw.serial) : undefined,
        ], sw.name || sw.serial);
        assetNames.push(sw.name || sw.serial);
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiSwitch ${sw.name}: ${err.message || "Unknown error"}`);
    }

    if (sw.ipAddress) {
      const matchingSubnet = findSubnetForIp(sw.ipAddress);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, sw.ipAddress);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          // A manual row at this switch's own address is only a conflict when it
          // belongs to something ELSE. Once an operator reserves a managed
          // switch's lease-backed IP (which is the point of making those rows
          // takeover-able), this is exactly what the next cycle finds — so
          // without the identity check the first effect of that feature would be
          // a conflict card per reserved switch, re-raised as the 30-day
          // upsertConflict guard aged out.
          if (
            existingRes.sourceType === "manual" &&
            !reservationBelongsToInfraDevice(existingRes, { mac: normalizedSwMac, name: sw.name })
          ) {
            await upsertConflict(existingRes.id, integrationId, { hostname: sw.name || null, owner: "network-team", projectRef: projectRefLabel, notes: swNotes, sourceType: "fortiswitch" }, existingRes);
          }
        } else {
          try {
            await releaseDnsResolvedAt(matchingSubnet.id, sw.ipAddress);
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: sw.ipAddress,
                hostname: sw.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: swNotes,
                status: "active",
                sourceType: "fortiswitch",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${sw.ipAddress} (${sw.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiSwitch ${sw.name} at ${sw.ipAddress}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }

  // Build hostname → {ip, mac} from DHCP data so APs that get management IPs
  // via DHCP can be matched even when the managed_ap API returns no IP/MAC.
  const dhcpByHostname = new Map<string, { ip: string; mac: string }>();
  for (const e of result.dhcpEntries || []) {
    if (e.hostname && e.ipAddress) {
      const key = e.hostname.toLowerCase();
      if (!dhcpByHostname.has(key)) dhcpByHostname.set(key, { ip: e.ipAddress, mac: e.macAddress || "" });
    }
  }

  // The AP LLDP persist below resolves matchedAssetId through the module-
  // level match index in monitoringService, which caches for 60s. The
  // FortiSwitch loop above may have just created the very switches these
  // neighbors point at — drop the cache once so the first persist rebuilds
  // against this run's fresh asset set instead of ghosting brand-new switches
  // until the next cycle.
  if ((result.fortiAps || []).some((ap) => Array.isArray(ap.lldpNeighbors) && ap.lldpNeighbors.length > 0)) {
    invalidateLldpMatchCache();
  }
  // Business rule 91(e): an AP with no base MAC (unauthorized — named by its
  // serial, while the gate's lease knows it by its own hostname) is paired
  // with the MAC its OWN controller sees on its reported address
  // (`gateMacIndex`, built before the FortiSwitch loop).
  for (const ap of result.fortiAps || []) {
    const dhcpFallback = dhcpByHostname.get(ap.name.toLowerCase()) ?? dhcpByHostname.get(ap.serial.toLowerCase()) ?? null;
    const resolvedIp = ap.ipAddress || dhcpFallback?.ip || null;
    const rawMac = ap.baseMac || dhcpFallback?.mac || fortiapGateMac(gateMacIndex, ap) || "";
    // Unauthorized on its controller → the asset sits in storage, like an
    // Unauthorized FortiSwitch. Blank state (older firmware) decides nothing.
    const apUnauthorized = isFortiapUnauthorized(ap.authorizationState);
    const apAuthKnown = !!(ap.authorizationState || "").trim();
    const normalizedMac = normalizeMacOrNull(rawMac);
    try {
      let existingAsset: any = ap.serial ? assetIdx.findBySerial(ap.serial) : null;
      if (!existingAsset && normalizedMac) existingAsset = assetIdx.findByMac(normalizedMac);
      // Name only — never bare IP (rule 91(e)). The AP's address is often the
      // factory default 192.168.1.2, which sits behind many gates at once; a
      // fleet-wide IP rung adopted whichever serial-less asset last indexed
      // it, at any site. The same-gate case is the gate MAC above.
      if (!existingAsset && ap.name) existingAsset = assetIdx.findByEntry(undefined, ap.name, undefined, { allowIpFallback: false });
      // Serial-mismatch guard on the fallback matches: serial is chassis
      // identity, so a MAC/name/IP match must never bind this row to an
      // asset that carries a DIFFERENT non-empty serial. Without it, an
      // RMA'd replacement AP inheriting the old unit's IP re-binds to the
      // old asset every cycle — resurrecting it out of decommissioned,
      // stamping the new unit's MAC onto it, and never getting an asset of
      // its own, while Phase 2b re-decommissions the old serial each
      // finalize (observed as a flap loop between an RMA'd AP's old and new
      // serial at one site, one decommission Event every run).
      // Serial-less matches (orphan fortigate-endpoint adoption) still bind.
      if (existingAsset && ap.serial && existingAsset.serialNumber
          && normalizeSerialKey(existingAsset.serialNumber) !== normalizeSerialKey(ap.serial)) {
        existingAsset = null;
      }

      const apTopology = {
        role: "fortiap" as const,
        controllerFortigate: ap.device || null,
        // Definitive controller identity — see the fortiswitch stamp above.
        controllerSerial: ap.deviceSerial || null,
        parentSwitch: ap.peerSwitch || null,
        parentPort: ap.peerPort || null,
        parentVlan: ap.peerVlan ?? null,
        // Controller admission state ("authorized" / "discovered" / ...) from
        // managed_ap's `state` field — distinct from `status` (connectivity).
        // Surfaced as the Authorization row on the asset details General tab.
        state: ap.authorizationState || null,
        // AP profile (`wtp_profile`) — the FortiOS object that decides this
        // AP's radios, SSIDs and power. Surfaced as the AP Profile row on the
        // asset details General tab.
        profile: ap.profile || null,
        // AP-local uplink port (lan1, lan2, wbh0 …) — preferred from
        // wan_status.interface, falls back to LLDP local_port. Mirrors
        // the FortiSwitch fortinetTopology.uplinkInterface convention.
        uplinkInterface: ap.apUplinkInterface ?? null,
        // peerSource records HOW the (parentSwitch, parentPort) pair was
        // resolved — "lldp" (the AP's own LLDP table; authoritative) or
        // "detected-device" (FortiSwitch MAC table fallback). Topology
        // graph can use this to flag uncertain edges if needed.
        peerSource: ap.peerSource ?? null,
        // Mesh role + parent. parentApSerial points at the parent AP's
        // serialNumber when this AP is a wireless-mesh leaf; the topology
        // graph renders a mesh edge from this AP to the parent instead of
        // (or in addition to) the wired uplink.
        meshUplink: ap.meshUplink ?? null,
        parentApSerial: ap.parentApSerial ?? null,
        // Raw admin description from the wtp CMDB `location` (comment
        // fallback) — a:/b:/f:/r:/jb: location codes for the Device Map.
        // Notes are operator-only.
        ...buildDeviceDescriptionStamp(ap.description),
      };
      // Presence gate: the managed-AP table includes configured-but-offline
      // WTPs. FortiOS reports "online" on most releases and "connected" on
      // some (same variance the controller-status probe accepts) — the
      // previous /^connected$/-only check evaluated every healthy AP on an
      // "online"-reporting fleet as offline, gating off lastSeen bumps,
      // decommission resurrection, and the LLDP persist below.
      const apOnline = isFortiapStatusOnline(ap.status);
      let apAssetId: string | null = null;
      if (existingAsset) {
        // Snapshot before the branch retypes assetType / mutates status below.
        const apBefore = snapshotMaterialAssetFields(existingAsset);
        // Phase 3b.1 cutover: projection-driven discovery fields.
        if (ap.serial) {
          try {
            const syncedAt = new Date(now);
            const observed = buildFortiapObservedBlob(ap, syncedAt);
            await upsertFortinetInfraAssetSource("fortiap", existingAsset.id, integrationId, ap.serial, observed, syncedAt, syncedAt, integrationName, infraPriorObserved(existingAsset.id, "fortiap", ap.serial));
            applyInfraSourceInMemory(existingAsset.id, "fortiap", ap.serial, observed, syncedAt, syncedAt);
            noteControllerClaim(existingAsset.id, ap.serial, "fortiap", ap.device, ap.deviceSerial);
          } catch (err: any) {
            syncLog("error", `Failed to upsert fortiap AssetSource for ${ap.name}: ${err?.message || "Unknown error"}`);
          }
        }
        const { projected: apProjected } = projectAssetFromSources(infraSourcesOf(existingAsset.id));

        const updateData: Record<string, unknown> = {
          fortinetTopology: apTopology,
          // Resurrection, like the lastSeen bump below, requires the AP to
          // be connected — an offline WTP entry must not undo a decommission.
          // Authorization moves an asset only between active and storage, so an
          // operator-set status (and a scheduler-owned maintenance) is left alone.
          ...(existingAsset.status === "decommissioned" && apOnline
            ? { status: apUnauthorized ? "storage" : "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel }
            : apAuthKnown
              && (existingAsset.status === "active" || existingAsset.status === "storage")
              && existingAsset.status !== (apUnauthorized ? "storage" : "active")
              ? { status: apUnauthorized ? "storage" : "active", statusChangedAt: new Date(now), statusChangedBy: integrationLabel }
              : {}),
          ...buildClassMonitorStamp(apMonitorCfg, existingAsset),
          // Unconditional attribution — see the FortiSwitch update-path comment.
          ...(existingAsset.discoveredByIntegrationId !== integrationId
            ? { discoveredByIntegrationId: integrationId }
            : {}),
        };
        if (apOnline) bumpLastSeen(updateData, existingAsset, new Date(now), "discovery");
        // Mirror the resolved wired-uplink switch/port (from LLDP first, then
        // the detected-device MAC table fallback) into `lastSeenSwitch` so the
        // asset details panel shows where the AP is plugged in. Same
        // "<switchId>/<portName>" format Phase 7.5 uses for endpoints. Phase
        // 7.5 itself rarely fires on APs because switches usually see the
        // AP's wired NIC MAC, not its baseMac which is what's indexed.
        if (ap.peerSwitch && ap.peerPort) {
          noteChangeBaseline(existingAsset, ["lastSeenSwitch"]);
          updateData.lastSeenSwitch = `${ap.peerSwitch}/${ap.peerPort}`;
        }
        // Same correction as the FortiSwitch path — fix assetType if a prior
        // pathway created this asset as "other" before FortiAP discovery linked
        // up, and sweep the stale fortigate-endpoint source row.
        if (existingAsset.assetType !== "access_point") {
          updateData.assetType = "access_point";
          try {
            await prisma.assetSource.deleteMany({
              where: { assetId: existingAsset.id, sourceKind: "fortigate-endpoint" },
            });
          } catch { /* best-effort */ }
          existingAsset.assetType = "access_point";
        }
        if (apProjected.hostname !== null) updateData.hostname = apProjected.hostname;
        if (apProjected.model !== null) updateData.model = apProjected.model;
        if (apProjected.osVersion !== null) updateData.osVersion = apProjected.osVersion;
        if (apProjected.manufacturer !== null) updateData.manufacturer = apProjected.manufacturer;
        if (apProjected.serialNumber !== null) updateData.serialNumber = apProjected.serialNumber;
        if (apProjected.learnedLocation !== null) updateData.learnedLocation = apProjected.learnedLocation;
        if (apProjected.ipAddress !== null) {
          updateData.ipAddress = apProjected.ipAddress;
          updateData.ipSource = ap.device || integrationType;
        }
        clampAcquiredToLastSeen(updateData, existingAsset);
        await prisma.asset.update({ where: { id: existingAsset.id }, data: updateData });
        logDiscoveryAssetUpdated(apBefore, updateData, existingAsset.id, ap.name || ap.serial, {
          integrationName, integrationId, sourceKind: "fortiap", actor,
        });
        if (resolvedIp) existingAsset.ipAddress = resolvedIp;
        // Phase 6/7's serial rung (rule 91(c)) reads the stamp off this object.
        existingAsset.fortinetTopology = apTopology;
        // Mirror the wired-uplink stamp in memory: later phases (and the
        // end-of-run change-event flush) compare against this row, and without
        // it the flush would read the pre-update value and re-report the same
        // move every run.
        if (updateData.lastSeenSwitch) existingAsset.lastSeenSwitch = updateData.lastSeenSwitch;
        if (typeof updateData.status === "string") existingAsset.status = updateData.status;
        if (existingAsset.discoveredByIntegrationId !== integrationId) existingAsset.discoveredByIntegrationId = integrationId;
        assetIdx.reindex(existingAsset);
        await sweepEndpointGhostsInto(existingAsset, [
          normalizedMac ? assetIdx.findByMac(normalizedMac) : undefined,
          ap.serial ? assetIdx.findByEntry(undefined, ap.serial) : undefined,
        ], ap.name || ap.serial);
        assetNames.push(`${ap.name} (updated)`);
        apAssetId = existingAsset.id;
      } else {
        // Phase 3b.1 cutover: project from a synthetic single-source array.
        const apSyncedAt = new Date(now);
        const apObserved = buildFortiapObservedBlob(ap, apSyncedAt);
        const { projected: apCreateProjected } = projectAssetFromSources([
          { sourceKind: "fortiap", inferred: false, observed: apObserved },
        ]);
        const newAsset = await prisma.asset.create({
          data: {
            ipAddress: apCreateProjected.ipAddress,
            ...(apCreateProjected.ipAddress ? { ipSource: ap.device || integrationType } : {}),
            macAddress: normalizedMac,
            ...(normalizedMac
              ? { macAddressRows: { create: buildMacRowsForCreate([{ mac: normalizedMac, lastSeen: now, source: "fmg-discovery" }]) } }
              : {}),
            hostname: apCreateProjected.hostname,
            serialNumber: apCreateProjected.serialNumber,
            manufacturer: apCreateProjected.manufacturer || "Fortinet",
            model: apCreateProjected.model || "FortiAP",
            assetType: "access_point",
            // Unconditional attribution — see the FortiSwitch update-path comment.
            discoveredByIntegrationId: integrationId,
            status: apUnauthorized ? "storage" : "active",
            statusChangedAt: new Date(now),
            statusChangedBy: integrationLabel,
            osVersion: apCreateProjected.osVersion,
            learnedLocation: apCreateProjected.learnedLocation,
            ...(apOnline ? { lastSeen: new Date(now), lastSeenSource: "discovery" } : {}),
            fortinetTopology: apTopology,
            ...(ap.peerSwitch && ap.peerPort ? { lastSeenSwitch: `${ap.peerSwitch}/${ap.peerPort}` } : {}),
            ...buildClassMonitorStamp(apMonitorCfg),
            // Notes are operator-only — boilerplate at creation, never
            // written by discovery again.
            notes: `Auto-discovered from FortiGate ${ap.device} via ${integrationLabel}`,
            tags: ["fortiap", "auto-discovered"],
          },
        });
        if (ap.serial) {
          try {
            await upsertFortinetInfraAssetSource("fortiap", newAsset.id, integrationId, ap.serial, apObserved, apSyncedAt, apSyncedAt, integrationName);
            applyInfraSourceInMemory(newAsset.id, "fortiap", ap.serial, apObserved, apSyncedAt, apSyncedAt);
            noteControllerClaim(newAsset.id, ap.serial, "fortiap", ap.device, ap.deviceSerial);
          } catch (err: any) {
            syncLog("error", `Created FortiAP asset ${ap.name} but failed to upsert AssetSource row: ${err?.message || "Unknown error"}`);
          }
        }
        logDiscoveryAssetCreated(newAsset.id, ap.name || ap.serial, {
          integrationName, integrationId, sourceKind: "fortiap", actor,
        });
        assetIdx.add(newAsset);
        await sweepEndpointGhostsInto(newAsset, [
          normalizedMac ? assetIdx.findByMac(normalizedMac) : undefined,
          ap.serial ? assetIdx.findByEntry(undefined, ap.serial) : undefined,
        ], ap.name || ap.serial);
        assetNames.push(ap.name || ap.serial);
        apAssetId = newAsset.id;
      }

      // Persist the AP's full LLDP table (managed_ap `lldp` array) as real
      // AssetLldpNeighbor rows so the asset-details LLDP section and Device
      // Map show the AP's exact neighbors instead of peer-inferred ones.
      // Gated on apOnline (offline WTP entries carry stale tables) and on
      // the field being present (absent = firmware didn't return `lldp` —
      // must not wipe existing rows). Best-effort: an LLDP persist failure
      // must not fail the asset sync itself.
      if (apAssetId && apOnline && Array.isArray(ap.lldpNeighbors)) {
        try {
          await persistManagedApLldpNeighbors(apAssetId, ap.lldpNeighbors, new Date(now));
        } catch (err: any) {
          syncLog("error", `Failed to persist LLDP neighbors for FortiAP ${ap.name}: ${err?.message || "Unknown error"}`);
        }
      }
      // Radio + broadcast-SSID inventory off the same managed_ap row. This is
      // the REST half of the Stations tab's radio → SSID → station tree, and
      // it is written from DISCOVERY rather than the monitor pass on purpose:
      // system-info only runs for an AP whose interfaces stream is on SNMP,
      // so hanging the tree off that path would leave it empty on exactly the
      // APs that have SNMP disabled — which is most of them. Same two gates
      // as the LLDP persist above: online (an offline WTP's row is stale) and
      // field-present (absent = firmware said nothing, must not wipe).
      if (apAssetId && apOnline && Array.isArray(ap.radios)) {
        try {
          await persistApRadioInventory(apAssetId, ap.radios, "fortios", new Date(now));
        } catch (err: any) {
          syncLog("error", `Failed to persist radios for FortiAP ${ap.name}: ${err?.message || "Unknown error"}`);
        }
      }
    } catch (err: any) {
      syncLog("error", `Failed to create/update asset for FortiAP ${ap.name}: ${err.message || "Unknown error"}`);
    }

    if (resolvedIp) {
      const matchingSubnet = findSubnetForIp(resolvedIp);
      if (matchingSubnet) {
        const key = reservationKey(matchingSubnet.id, resolvedIp);
        const existingRes = activeResMap.get(key);
        if (existingRes) {
          // Same identity check as the FortiSwitch path above — an operator's
          // reservation for THIS AP is not a conflict with this AP.
          if (
            existingRes.sourceType === "manual" &&
            !reservationBelongsToInfraDevice(existingRes, { mac: normalizedMac, name: ap.name })
          ) {
            await upsertConflict(existingRes.id, integrationId, { hostname: ap.name || null, owner: "network-team", projectRef: projectRefLabel, notes: `FortiAP managed by FortiGate ${ap.device}`, sourceType: "fortinap" }, existingRes);
          }
        } else {
          try {
            await releaseDnsResolvedAt(matchingSubnet.id, resolvedIp);
            const newRes = await prisma.reservation.create({
              data: {
                subnetId: matchingSubnet.id,
                ipAddress: resolvedIp,
                hostname: ap.name || null,
                owner: "network-team",
                projectRef: projectRefLabel,
                notes: `FortiAP managed by FortiGate ${ap.device}`,
                status: "active",
                sourceType: "fortinap",
              },
            });
            activeResMap.set(key, newRes);
            reservationNames.push(`${resolvedIp} (${ap.name})`);
          } catch (err: any) {
            syncLog("error", `Failed to create reservation for FortiAP ${ap.name} at ${resolvedIp}: ${err.message || "Unknown error"}`);
          }
        }
      }
    }
  }
}
