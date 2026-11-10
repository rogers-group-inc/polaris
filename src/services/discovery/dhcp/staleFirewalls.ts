/**
 * src/services/discovery/dhcp/staleFirewalls.ts — syncDhcpSubnets Phase 2a,
 * the stale FortiGate decommission sweep and its switch / AP cascade, with the
 * pure roster decisions it makes (CQ-B060; body and helpers moved verbatim,
 * its free variables made parameters). The caller keeps the
 * `sweepPhaseEnabled(mode, "2a")` + roster + Fortinet-type gate and passes
 * `scopedRun`, so this module imports nothing from the engine at runtime.
 */

import type { AssetIndex } from "../discoveryEngine.js";
import { prisma } from "../../../db.js";
import { logEvent } from "../../eventLogService.js";
import { releaseAssetsForDecommission } from "../../maintenanceScheduleService.js";
import { releaseInfraReservationsForAssets } from "../../reservationService.js";
import { readFirewallDeviceName } from "../../../utils/fortinetParentKey.js";
import { isUsableSerial } from "../../../utils/serialNumber.js";

/**
 * Pure guard for the Phase 2a stale-firewall sweep: is this asset the standby
 * member of a cluster whose membership NOBODY read this run?
 *
 * A standby has no identity outside its cluster's HA roster — no top-level
 * device name, and (by design) no management IP of its own. So the sweep can
 * only judge it when that roster was actually published: `knownFirewallSerialsUc`
 * says the upstream still knows the peer chassis, and `haRosterPublishedUc`
 * says some device this run enumerated its members. Three outcomes:
 *
 *   - peer serial unknown to the upstream  → the WHOLE cluster is gone; judge
 *     this asset normally (both members are genuinely stale).
 *   - peer known AND its roster published  → membership was read and this
 *     member wasn't in it; it really did leave the cluster. Judge it.
 *   - peer known, roster NOT published     → protected. The cluster is still
 *     configured but nothing enumerated it — an unreachable gate, a skipped
 *     direct read, a FortiOS build whose `ha-peer` endpoint 404s, an FMG API
 *     user without the field. Absence of evidence is not evidence of absence.
 *
 * Both sets are UPPER-CASE serials; the topology serial is folded to match.
 */
export function haStandbyOfUnreadCluster(
  fortinetTopology: unknown,
  knownFirewallSerialsUc: Set<string>,
  haRosterPublishedUc: Set<string>,
): boolean {
  const topo = (fortinetTopology as Record<string, unknown> | null) || null;
  if (!topo || topo.haRole !== "secondary") return false;
  const peer = typeof topo.haPeerSerial === "string" ? topo.haPeerSerial.toUpperCase() : "";
  if (!peer) return false;
  if (!knownFirewallSerialsUc.has(peer)) return false;
  return !haRosterPublishedUc.has(peer);
}

/** What the Phase 2a roster says about one previously-discovered firewall asset. */
export type RosterFirewallVerdict =
  /** Still configured upstream (by chassis, by name, or unknowable) — leave it. */
  | { kind: "keep" }
  /** Gone from the roster entirely — decommission, and cascade to its children. */
  | { kind: "stale" }
  /**
   * Its NAME is still on the roster, but this run read that gate and got a
   * different chassis (business rule 41(a)): the box was swapped under the
   * same name. Decommission the old chassis's asset — but never cascade, since
   * the name the cascade keys on now belongs to the new chassis's children.
   */
  | { kind: "replaced"; oldSerial: string; newSerials: string[] };

export interface RosterFirewallContext {
  /** Every chassis serial on the roster, HA members included — UPPER-CASE. */
  knownFirewallSerialsUc: Set<string>;
  /** Every roster device name, lower-case. */
  knownDeviceNamesLc: Set<string>;
  /** HA member serials whose cluster roster was published this run — UPPER-CASE. */
  haRosterPublishedUc: Set<string>;
  /** Per processed device (FMG name AND FortiOS hostname, lower-case): its chassis set. */
  clusterSerialsByDevice: Map<string, Set<string>>;
}

/**
 * Pure verdict for the Phase 2a stale-firewall sweep.
 *
 * Serial first, then the HA-standby protection, then the name. The name match
 * used to be an unconditional KEEP, which is exactly wrong for an RMA: FMG's
 * serial-swap keeps the device name, so the old chassis's asset kept matching
 * the roster by name and was never retired (prod 2026-10-05 — an operator
 * decommissioned it by hand). A name match is now a keep only when it cannot
 * be told apart from the same chassis:
 *
 *   - the asset has no usable serial            → keep (legacy / placeholder row)
 *   - nobody READ that gate's chassis this run  → keep (absence of evidence —
 *     an offline gate, a failed direct read; same tri-state as classifyChassis)
 *   - the gate was read, and its chassis set does not hold this serial
 *                                               → replaced
 *
 * The asset serial is already known NOT to be anywhere on the fleet roster by
 * the time the name is consulted, so an HA failover (the old serial still a
 * cluster member) never reaches the replaced branch.
 */
export function judgeRosterFirewall(
  asset: { hostname: string | null; serialNumber: string | null; fortinetTopology: unknown },
  ctx: RosterFirewallContext,
): RosterFirewallVerdict {
  const serial = asset.serialNumber && isUsableSerial(asset.serialNumber)
    ? asset.serialNumber.trim().toUpperCase()
    : null;
  if (serial && ctx.knownFirewallSerialsUc.has(serial)) return { kind: "keep" };
  if (haStandbyOfUnreadCluster(asset.fortinetTopology, ctx.knownFirewallSerialsUc, ctx.haRosterPublishedUc)) {
    return { kind: "keep" };
  }

  // Every name this gate might be listed under: FMG's device name (stamped on
  // the topology blob) and the FortiOS hostname, which can differ.
  const names = [readFirewallDeviceName(asset.fortinetTopology), asset.hostname]
    .map((n) => (typeof n === "string" ? n.trim().toLowerCase() : ""))
    .filter((n) => n.length > 0);
  const onRoster = names.filter((n) => ctx.knownDeviceNamesLc.has(n));
  if (onRoster.length === 0) {
    // Nothing to identify it by: never judged (matches the old `!hostname` skip).
    return asset.hostname ? { kind: "stale" } : { kind: "keep" };
  }
  if (!serial) return { kind: "keep" };

  for (const name of onRoster) {
    const cluster = ctx.clusterSerialsByDevice.get(name);
    if (!cluster || cluster.size === 0) continue;
    if (cluster.has(serial)) return { kind: "keep" };
    return { kind: "replaced", oldSerial: serial, newSerials: [...cluster].sort() };
  }
  return { kind: "keep" };
}

/**
 * Phase 2a's narrowing for a scoped (single-gate) run: does this firewall asset
 * carry the name of a gate processed this run? `processedDevices` is the
 * per-device chassis map (`clusterSerialsByDevice`), keyed on each processed
 * gate's FMG device name AND FortiOS hostname, lower-cased — so a scoped run's
 * map holds exactly the scoped gate. Pure; business rule 142.
 */
export function firewallNamedForScopedGate(
  asset: { hostname: string | null; fortinetTopology: unknown },
  processedDevices: Map<string, unknown>,
): boolean {
  for (const n of [readFirewallDeviceName(asset.fortinetTopology), asset.hostname]) {
    if (typeof n !== "string") continue;
    const key = n.trim().toLowerCase();
    if (key && processedDevices.has(key)) return true;
  }
  return false;
}

/**
 * Pure matcher for the Phase 2a controller cascade: given a FortiSwitch/FortiAP
 * asset's `fortinetTopology` blob and the set of just-decommissioned FortiGate
 * hostnames (lowercased), return the matched controller name, or null when the
 * child isn't managed by any of them. Case-insensitive on the controller side,
 * mirroring Phase 2a's hostname fallback (FMG device names and FortiOS
 * hostnames can disagree in case for the same device). Extracted (and exported)
 * for the same reason as sweepPhaseEnabled — a wrong match here decommissions
 * healthy switches/APs.
 */
export function cascadeControllerOf(fortinetTopology: unknown, staleFwNamesLc: Set<string>): string | null {
  const topo = (fortinetTopology as Record<string, unknown> | null) || null;
  const controller = typeof topo?.controllerFortigate === "string" ? topo.controllerFortigate : "";
  if (!controller || !staleFwNamesLc.has(controller.toLowerCase())) return null;
  return controller;
}

/**
 * Phase 2a — Decommission stale FortiGate firewalls, then cascade to the
 * FortiSwitches / FortiAPs of every gate that LEFT the roster (a replaced
 * chassis, rule 41(a), is retired without a cascade). On a scoped run
 * (`scopedRun`, business rule 142) only firewalls named for the scoped gate
 * are judged and only the chassis-replaced verdict acts. Keeps the run's
 * `assetIdx` snapshot in step with the status flips, and appends the cascaded
 * children to `decommissionedSwitches` / `decommissionedAps`.
 */
export async function decommissionStaleFirewalls(input: {
  integrationId: string;
  integrationName: string;
  integrationLabel: string;
  actor: string | undefined;
  now: string;
  scopedRun: boolean;
  knownDeviceNamesLc: Set<string>;
  knownFirewallSerials: Set<string>;
  haRosterPublished: Set<string>;
  clusterSerialsByDevice: Map<string, Set<string>>;
  assetIdx: AssetIndex;
  decommissionedSwitches: string[];
  decommissionedAps: string[];
}): Promise<void> {
  const {
    integrationId, integrationName, integrationLabel, actor, now, scopedRun,
    knownDeviceNamesLc, knownFirewallSerials, haRosterPublished, clusterSerialsByDevice,
    assetIdx, decommissionedSwitches, decommissionedAps,
  } = input;
  const candidateFws = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integrationId,
      assetType: "firewall",
      // Maintenance-window assets ARE judged here: roster absence is config
      // truth, not a reachability signal (an offline device stays in the
      // roster), so a device deleted at the source outranks its open window.
      // releaseAssetsForDecommission below force-closes those windows before
      // the status flip — see maintenanceScheduleService.
      status: { not: "decommissioned" },
    },
    select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true },
  });
  const staleFwIds: string[] = [];
  // Only the gates that LEFT the roster cascade to their children. A
  // replaced chassis (rule 41(a)) is retired too, but its name now belongs to
  // the new chassis — cascading on it would decommission every switch and AP
  // the new gate manages.
  const staleFwHostnames: string[] = [];
  const rosterCtx: RosterFirewallContext = {
    knownFirewallSerialsUc: knownFirewallSerials,
    knownDeviceNamesLc,
    haRosterPublishedUc: haRosterPublished,
    clusterSerialsByDevice,
  };
  for (const a of candidateFws) {
    if (scopedRun && !firewallNamedForScopedGate(a, clusterSerialsByDevice)) continue;
    const verdict = judgeRosterFirewall(a, rosterCtx);
    if (verdict.kind === "keep") continue;
    if (scopedRun && verdict.kind !== "replaced") continue;
    staleFwIds.push(a.id);
    if (verdict.kind === "replaced") {
      logEvent({
        action: "asset.fortigate.decommissioned",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: a.hostname || a.serialNumber || a.id,
        actor,
        message:
          `FortiGate "${a.hostname || verdict.oldSerial}" (serial ${verdict.oldSerial}) decommissioned — ` +
          `"${integrationName}" now reports chassis ${verdict.newSerials.join(", ")} under that name`,
        details: {
          reason: "chassis-replaced",
          oldSerial: verdict.oldSerial,
          newSerials: verdict.newSerials,
          integrationId,
          integrationName,
        },
      });
      continue;
    }
    staleFwHostnames.push(a.hostname!);
    logEvent({
      action: "asset.fortigate.decommissioned",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: a.hostname || a.serialNumber || a.id,
      actor,
      message: `FortiGate "${a.hostname || a.serialNumber}" decommissioned — no longer configured in "${integrationName}"`,
      details: { reason: "missing-from-roster", integrationId, integrationName },
    });
  }
  if (staleFwIds.length > 0) {
    // Any of these sitting in an open maintenance window: close the window +
    // decommission atomically first, so the 30s maintenance reconcile can't
    // self-heal-reflip the status back to "maintenance" (or, at window end,
    // restore a deleted device to "active"). No-op when none are in a window.
    await releaseAssetsForDecommission(staleFwIds, {
      at: new Date(now),
      actor,
      statusChangedBy: integrationLabel,
      reason: `no longer configured in "${integrationName}"`,
    });
    await prisma.asset.updateMany({
      where: { id: { in: staleFwIds } },
      data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
    });
    // Keep the in-memory index in step with the DB. `assetIdx` is a snapshot
    // taken before this sweep, and in "full" mode (the standalone FortiGate
    // integration — one pass, Phase 2a ahead of the Phase 3 firewall fan-out)
    // that snapshot is what Phase 3 reads. A row this sweep just
    // decommissioned would still look "active" there, the resurrection clause
    // would not fire, and the DB row would stay decommissioned with nothing
    // able to flip it back on any later cycle.
    for (const id of staleFwIds) {
      const row = assetIdx.findById(id);
      if (row) row.status = "decommissioned";
    }
    // Cascade — a decommissioned FortiGate takes its managed FortiSwitches /
    // FortiAPs with it. Phase 2b can't cover this case: it only judges
    // children whose controller was successfully INVENTORIED this run, and a
    // roster-removed gate is never queried again — so without this cascade
    // its switches/APs would sit "active" forever (ghost infra). Linkage is
    // fortinetTopology.controllerFortigate (the FMG device name the Phase 3b
    // switch / Phase 6 AP paths stamp), matched case-insensitively against
    // the just-decommissioned gates' hostnames via cascadeControllerOf.
    // Children rehomed to another gate earlier this run already carry the
    // new controller name, so they never match here. If the gate returns to
    // FMG, Phase 3b resurrects it and the children resurrect through their
    // own update paths once the controller reports them connected again.
    const staleFwNamesLc = new Set(staleFwHostnames.map((h) => h.toLowerCase()));
    const cascadeCandidates = await prisma.asset.findMany({
      where: {
        discoveredByIntegrationId: integrationId,
        assetType: { in: ["switch", "access_point"] },
        status: { not: "decommissioned" },
      },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
    });
    const cascadeIds: string[] = [];
    for (const child of cascadeCandidates) {
      const controller = cascadeControllerOf(child.fortinetTopology, staleFwNamesLc);
      if (!controller) continue;
      cascadeIds.push(child.id);
      if (child.assetType === "switch") decommissionedSwitches.push(child.hostname || child.serialNumber || child.id);
      else                              decommissionedAps.push(child.hostname || child.serialNumber || child.id);
      logEvent({
        action: child.assetType === "switch" ? "asset.fortiswitch.decommissioned" : "asset.fortiap.decommissioned",
        resourceType: "asset",
        resourceId: child.id,
        resourceName: child.hostname || child.serialNumber || child.id,
        actor,
        message: `${child.assetType === "switch" ? "FortiSwitch" : "FortiAP"} "${child.hostname || child.serialNumber}" decommissioned — its controller FortiGate "${controller}" was decommissioned`,
        details: { reason: "controller-decommissioned", controllerFortigate: controller, integrationId, integrationName },
      });
    }
    if (cascadeIds.length > 0) {
      // Force-exit maintenance for any of these in an open window (see 2a
      // preamble) before the status flip.
      await releaseAssetsForDecommission(cascadeIds, {
        at: new Date(now),
        actor,
        statusChangedBy: integrationLabel,
        reason: "its controller FortiGate was decommissioned",
      });
      await prisma.asset.updateMany({
        where: { id: { in: cascadeIds } },
        data: { status: "decommissioned", statusChangedAt: new Date(now), statusChangedBy: integrationLabel },
      });
      // Same snapshot sync as the firewall flip above — the switch / AP
      // update paths resurrect off `existingAsset.status`, which comes from
      // the pre-sweep `assetIdx`.
      for (const id of cascadeIds) {
        const row = assetIdx.findById(id);
        if (row) row.status = "decommissioned";
      }
      // Give back the addresses. Runs BEFORE the status flip would matter but
      // AFTER it for ordering safety: the helper reads asset ipAddress only,
      // so a decommissioned row is still resolvable. Never throws.
      await releaseInfraReservationsForAssets(cascadeIds, {
        reason: "controller FortiGate decommissioned",
        actor,
      });
    }
  }
}
