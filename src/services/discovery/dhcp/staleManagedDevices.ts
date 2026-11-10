/**
 * src/services/discovery/dhcp/staleManagedDevices.ts — syncDhcpSubnets Phase
 * 2b, the stale FortiSwitch / FortiAP decommission sweep, and the pure
 * decisions it makes (CQ-B060; body and helpers moved verbatim, its free
 * variables made parameters). The caller keeps the `sweepPhaseEnabled(mode,
 * "2b")` gate and computes `rosterJudgeable`, so this module imports nothing
 * from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import { prisma } from "../../../db.js";
import { logEvent } from "../../eventLogService.js";
import { releaseAssetsForDecommission } from "../../maintenanceScheduleService.js";
import { releaseInfraReservationsForAssets } from "../../reservationService.js";
import { readControllerStamp, normalizeNameKey, normalizeSerialKey } from "../../../utils/fortinetParentKey.js";

/**
 * Sighting evidence for the Phase 2b stale FortiSwitch/FortiAP sweep, built
 * once per sync from the discovery result. Serials are fleet-wide (globally
 * unique); hostname and CMDB sightings are keyed by lowercased controller
 * device name so one gate's roster never vouches for another gate's devices.
 */
export interface ManagedDeviceSightings {
  seenSerials: Set<string>;
  seenHostnamesByController: Map<string, Set<string>>;
  cmdbSerialsByController: Map<string, Set<string>>;
}

/**
 * Pure Phase 2b decision: is this previously-discovered FortiSwitch/FortiAP
 * asset still vouched for this run? (Caller has already established that the
 * asset's controller was queried successfully.)
 *
 * Serial is AUTHORITATIVE when the asset has one on file: a same-hostname
 * sighting must never vouch for a different serial. An RMA'd/replaced unit
 * keeps the old unit's hostname, and the former `seenBySerial || seenByHostname`
 * OR let the replacement's name shield the dead serial's asset from
 * decommission forever (prod 2026-08: three RIVERBEND-112F-7 switch assets,
 * distinct serials, only one still on the gate — none ever decommissioned).
 * Hostname is consulted only for assets with no serial on file, and only
 * against sightings on the asset's OWN controller — same per-controller
 * scoping the CMDB protection already uses (a staged/offline gate's cloned
 * config must not vouch for another gate's fleet).
 */
export function isVouchedManagedDevice(
  asset: { serialNumber: string | null; hostname: string | null },
  controller: string,
  sightings: ManagedDeviceSightings,
): boolean {
  const ctlKey = controller.toLowerCase();
  if (asset.serialNumber) {
    if (sightings.seenSerials.has(asset.serialNumber)) return true;
    // CMDB decommission protection: configured-but-currently-offline.
    return !!sightings.cmdbSerialsByController.get(ctlKey)?.has(asset.serialNumber);
  }
  return !!(asset.hostname && sightings.seenHostnamesByController.get(ctlKey)?.has(asset.hostname));
}

/**
 * Pure Phase 2b guard for an ORPHAN (see resolveSweepController): is this
 * switch/AP still evidenced anywhere this run? Deliberately fleet-wide, the
 * opposite of isVouchedManagedDevice's per-controller scope — the asset's own
 * controller no longer exists, so any gate that reports it live, or still has
 * it in its CMDB, is the gate it now sits under and will re-stamp it.
 */
export function isSightedAnywhere(
  asset: { serialNumber: string | null; hostname: string | null },
  sightings: ManagedDeviceSightings,
): boolean {
  if (asset.serialNumber) {
    if (sightings.seenSerials.has(asset.serialNumber)) return true;
    for (const set of sightings.cmdbSerialsByController.values()) if (set.has(asset.serialNumber)) return true;
    return false;
  }
  if (!asset.hostname) return false;
  for (const set of sightings.seenHostnamesByController.values()) if (set.has(asset.hostname)) return true;
  return false;
}

/** What Phase 2b knows about controllers this run, for resolveSweepController. */
export interface SweepControllerContext {
  /** Controller device names whose switch (or AP) inventory query succeeded. */
  inventoried: Set<string>;
  /** UPPER serial (a gate's own, and each HA member's) → its device name THIS run. */
  currentNameBySerial: Map<string, string>;
  /** True only when the run read the whole roster (Phase 2a's gate). */
  rosterJudgeable: boolean;
  rosterNamesLc: Set<string>;
  rosterSerialsUc: Set<string>;
}

export type SweepControllerVerdict =
  | { kind: "judge"; controller: string; renamedFrom: string | null }
  | { kind: "orphan"; controller: string }
  | { kind: "skip" };

/**
 * Pure Phase 2b decision (business rule 41(b)): which controller does this
 * switch/AP answer to this run, if any?
 *
 * The chassis, not the name, says which gate (rule 41). A gate renamed in
 * FortiManager keeps its serial, so the stamped `controllerSerial` resolves to
 * the gate's CURRENT name and the asset is judged under it. Matching the
 * stamped name alone stranded every switch/AP a renamed gate no longer had:
 * the ones still connected were re-stamped with the new name, the ones left
 * behind kept the old name, which was never in the inventoried set again — so
 * they sat `active` forever (prod 2026-10: a gate renamed for a site move).
 *
 * `orphan` = the controller exists in the roster under NEITHER its stamped name
 * NOR its serial — it was renamed (a pre-serial stamp) or removed. Only on a
 * run that read the whole roster; the caller still spares an orphan any gate
 * reports (isSightedAnywhere). `skip` = no fresh answer either way.
 */
export function resolveSweepController(topology: unknown, ctx: SweepControllerContext): SweepControllerVerdict {
  const stamp = readControllerStamp(topology);
  const name = (stamp.name || "").trim();
  const serial = normalizeSerialKey(stamp.serial);
  const current = serial ? ctx.currentNameBySerial.get(serial) : undefined;
  const controller = current || name;
  if (controller && ctx.inventoried.has(controller)) {
    return { kind: "judge", controller, renamedFrom: current && name && current !== name ? name : null };
  }
  if (!ctx.rosterJudgeable || (!name && !serial)) return { kind: "skip" };
  if (serial && ctx.rosterSerialsUc.has(serial)) return { kind: "skip" };
  if (name && ctx.rosterNamesLc.has(normalizeNameKey(name))) return { kind: "skip" };
  return { kind: "orphan", controller: name || serial };
}

/**
 * Phase 2b — Decommission stale FortiSwitches / FortiAPs.
 *
 * For every previously-discovered FortiSwitch / FortiAP whose controller
 * was queried successfully this run but whose serial (or hostname, when
 * there's no serial on file) no longer appears in the controller's managed
 * inventory: flip the asset to status="decommissioned". Caller gates on
 * `sweepPhaseEnabled(mode, "2b")` and a non-empty switch or AP inventory.
 * `rosterJudgeable` is true only on a run that read the whole roster (never
 * "finalize-scoped"). Appends to `decommissionedSwitches` / `decommissionedAps`.
 */
export async function decommissionStaleManagedDevices(input: {
  result: DiscoveryResult;
  integrationId: string;
  integrationName: string;
  integrationLabel: string;
  actor: string | undefined;
  now: string;
  rosterJudgeable: boolean;
  knownDeviceNamesLc: Set<string>;
  knownFirewallSerials: Set<string>;
  switchInventoriedDevices: Set<string>;
  apInventoriedDevices: Set<string>;
  seenSwitchSerials: Set<string>;
  seenApSerials: Set<string>;
  seenSwitchHostnamesByController: Map<string, Set<string>>;
  seenApHostnamesByController: Map<string, Set<string>>;
  cmdbSwitchSerialsByDevice: Map<string, Set<string>>;
  cmdbApSerialsByDevice: Map<string, Set<string>>;
  decommissionedSwitches: string[];
  decommissionedAps: string[];
}): Promise<void> {
  const {
    result, integrationId, integrationName, integrationLabel, actor, now, rosterJudgeable,
    knownDeviceNamesLc, knownFirewallSerials, switchInventoriedDevices, apInventoriedDevices,
    seenSwitchSerials, seenApSerials, seenSwitchHostnamesByController, seenApHostnamesByController,
    cmdbSwitchSerialsByDevice, cmdbApSerialsByDevice, decommissionedSwitches, decommissionedAps,
  } = input;
  const candidates = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integrationId,
      assetType: { in: ["switch", "access_point"] },
      // Maintenance-window assets are judged here too — same reasoning as
      // Phase 2a: a powered-off-for-maintenance switch/AP is still in its
      // controller's CMDB (cmdbProtected below), so only a real removal from
      // the managed inventory reaches the decommission path.
      status: { not: "decommissioned" },
    },
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true, status: true },
  });
  // Business rule 41(b): the controller is resolved by chassis first, so a
  // gate renamed in FortiManager still judges the switches/APs it left
  // behind (their stamp keeps the old name). The serial → current-name map
  // comes from the gates processed this run; the roster half is only
  // trusted on a run that read the whole roster — Phase 2a's own gate,
  // never "finalize-scoped".
  const currentNameBySerial = new Map<string, string>();
  for (const dev of result.devices) {
    const devName = dev.name || dev.hostname;
    if (!devName) continue;
    if (dev.serial) currentNameBySerial.set(normalizeSerialKey(dev.serial), devName);
    for (const m of dev.haMembers ?? []) if (m.serial) currentNameBySerial.set(normalizeSerialKey(m.serial), devName);
  }
  // Never on a scoped run, even though 2a now runs there narrowed: the
  // orphan clause judges children of gates OTHER than the scoped one.
  const staleIds: string[] = [];
  for (const a of candidates) {
    const isSwitch = a.assetType === "switch";
    const sightings: ManagedDeviceSightings = isSwitch
      ? { seenSerials: seenSwitchSerials, seenHostnamesByController: seenSwitchHostnamesByController, cmdbSerialsByController: cmdbSwitchSerialsByDevice }
      : { seenSerials: seenApSerials,     seenHostnamesByController: seenApHostnamesByController,     cmdbSerialsByController: cmdbApSerialsByDevice };
    const verdict = resolveSweepController(a.fortinetTopology, {
      inventoried: isSwitch ? switchInventoriedDevices : apInventoriedDevices,
      currentNameBySerial,
      rosterJudgeable,
      rosterNamesLc: knownDeviceNamesLc,
      rosterSerialsUc: knownFirewallSerials,
    });
    // Skip when this asset's controller wasn't reachable this run — we
    // didn't get a fresh answer either way.
    if (verdict.kind === "skip") continue;
    const controller = verdict.controller;
    let message: string;
    let details: Record<string, unknown>;
    if (verdict.kind === "judge") {
      // Serial-authoritative sighting check (pure, unit-tested): serial on
      // file must reappear (live monitor or this controller's CMDB roster);
      // hostname vouches only for serial-less assets, and only on the same
      // controller. See isVouchedManagedDevice for the replaced-unit rationale.
      if (isVouchedManagedDevice(a, controller, sightings)) continue;
      const formerly = verdict.renamedFrom ? ` (formerly "${verdict.renamedFrom}")` : "";
      message = `controller "${controller}"${formerly} no longer reports it`;
      details = { reason: "missing-from-controller", controllerFortigate: controller, ...(verdict.renamedFrom ? { renamedFrom: verdict.renamedFrom } : {}), integrationId, integrationName };
    } else {
      // Orphan: its controller is gone from the roster under every identity.
      // Any gate that still reports it (live or CMDB) now owns it.
      if (isSightedAnywhere(a, sightings)) continue;
      message = `its controller "${controller}" is no longer in "${integrationName}"`;
      details = { reason: "controller-not-in-roster", controllerFortigate: controller, integrationId, integrationName };
    }
    staleIds.push(a.id);
    if (isSwitch)                            decommissionedSwitches.push(a.hostname || a.serialNumber || a.id);
    else if (a.assetType === "access_point") decommissionedAps.push(a.hostname || a.serialNumber || a.id);
    logEvent({
      action: isSwitch ? "asset.fortiswitch.decommissioned" : "asset.fortiap.decommissioned",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: a.hostname || a.serialNumber || a.id,
      actor,
      message: `${isSwitch ? "FortiSwitch" : "FortiAP"} "${a.hostname || a.serialNumber}" decommissioned — ${message}`,
      details,
    });
  }
  if (staleIds.length > 0) {
    // Force-exit maintenance for any of these in an open window (see 2a).
    await releaseAssetsForDecommission(staleIds, {
      at: new Date(now),
      actor,
      statusChangedBy: integrationLabel,
      reason: "no longer reported by its controller",
    });
    await prisma.asset.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
    });
    // The device is gone from its controller's inventory — deletion at source,
    // which business rule 16 already treats as config truth. Give the address
    // back rather than leaving it claimed (or, once auto-push exists, leaving a
    // real MAC→IP binding orphaned on the gate). Never throws.
    await releaseInfraReservationsForAssets(staleIds, {
      reason: "no longer reported by its controller",
      actor,
    });
  }
}
