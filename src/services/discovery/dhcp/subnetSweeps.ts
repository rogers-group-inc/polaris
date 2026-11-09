/**
 * src/services/discovery/dhcp/subnetSweeps.ts — syncDhcpSubnets Phases 2 and
 * 2c (CQ-B060; the bodies moved verbatim, their free variables made
 * parameters). The caller keeps each phase's `sweepPhaseEnabled(mode, …)`
 * gate, so this module imports nothing from the engine at runtime.
 */

import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { logEvent } from "../../eventLogService.js";
import { findCoveringExclusion, type ExclusionLike } from "../../../utils/subnetExclusion.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import * as autoMonitor from "../../autoMonitorInterfacesService.js";

/** The subnet fields Phase 2 reads and writes (a row of syncDhcpSubnets' in-memory `allSubnets`). */
interface SweepSubnet {
  id: string;
  cidr: string;
  name: string;
  discoveredBy: string | null;
  status: string;
  fortigateDevice: string | null;
}

/**
 * Phase 2 — Deprecate stale subnets (single updateMany). Caller gates on
 * `sweepPhaseEnabled(mode, "2") && knownDeviceNames.size > 0`.
 *
 * Roster check is case-insensitive: a subnet's fortigateDevice can carry
 * FortiOS-cased casing while the FMG roster carries FMG-cased casing (same
 * device, different source). An excluded CIDR is out of discovery's hands in
 * BOTH directions (business rule 42): Phase 1 no longer re-stamps it, so its
 * `fortigateDevice` is frozen at whichever site claimed it first, and
 * deprecating the row the moment that one gate leaves the roster would be
 * discovery acting on a subnet the operator told it to leave alone.
 * Mutates `allSubnets` rows (status) and appends to `deprecated`, as before.
 */
export async function deprecateStaleSubnets(input: {
  allSubnets: SweepSubnet[];
  knownDeviceNamesLc: Set<string>;
  subnetExclusions: readonly ExclusionLike[];
  deprecated: string[];
  integrationId: string;
  integrationName: string;
  actor: string | undefined;
}): Promise<void> {
  const { allSubnets, knownDeviceNamesLc, subnetExclusions, deprecated, integrationId, integrationName, actor } = input;
  // Find stale subnets in-memory first (for the return value).
  const staleSubnets = allSubnets.filter(
    (s) => s.discoveredBy === integrationId && s.status !== "deprecated" &&
           s.fortigateDevice && !knownDeviceNamesLc.has(s.fortigateDevice.toLowerCase()) &&
           !findCoveringExclusion(s.cidr, subnetExclusions)
  );
  if (staleSubnets.length > 0) {
    const staleIds = staleSubnets.map((s) => s.id);
    await prisma.subnet.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "deprecated" },
    });
    for (const s of staleSubnets) {
      deprecated.push(s.cidr);
      s.status = "deprecated"; // update in-memory
      logEvent({
        action: "subnet.deprecated",
        resourceType: "subnet",
        resourceId: s.id,
        resourceName: s.name,
        actor,
        message: `Subnet "${s.name}" (${s.cidr}) deprecated — FortiGate "${s.fortigateDevice}" no longer configured in "${integrationName}"`,
        details: {
          reason: "device-removed",
          fortigateDevice: s.fortigateDevice,
          integrationId,
          integrationName,
          cidr: s.cidr,
        },
      });
    }
  }
}

/**
 * Phase 2c — Auto-Monitor Interfaces apply pass. Caller gates on
 * `sweepPhaseEnabled(mode, "2c")`.
 *
 * For each per-class block (fortigate / fortiswitch / fortiap), if an
 * `autoMonitorInterfaces` selection has been configured on this integration,
 * resolve it against each discovered asset's latest AssetInterfaceSample rows
 * and union the result into Asset.monitoredInterfaces. Strictly additive.
 * Only applies to fortimanager + fortigate integrations. windowsserver /
 * entraid / activeDirectory don't manage Fortinet hardware.
 */
export async function applyAutoMonitorInterfaces(input: {
  integrationId: string;
  integrationName: string;
  integrationType: string;
  actor: string | undefined;
  /** syncDhcpSubnets' `scopedAssets?.infra` (rule 142): undefined on a full run. */
  scopedInfra: Set<string> | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const { integrationId, integrationName, integrationType, actor, scopedInfra, syncLog } = input;
  if (isFortinetIntegrationType(integrationType)) {
    const integ = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: { config: true },
    });
    const cfg = (integ?.config ?? {}) as Record<string, any>;
    for (const [klass, blockKey] of [
      ["fortigate",   "fortigateMonitor"],
      ["fortiswitch", "fortiswitchMonitor"],
      ["fortiap",     "fortiapMonitor"],
    ] as const) {
      // Same legacy-shape coercion as the on-demand apply route, for the
      // window between deploy and the one-shot migration sweeping configs.
      const selection = autoMonitor.coerceLegacySelection(cfg[blockKey]?.autoMonitorInterfaces ?? null);
      if (!selection) continue;
      try {
        const r = await autoMonitor.applyAutoMonitorForClass(integrationId, klass, selection, actor, scopedInfra);
        if (r.interfacesAdded > 0) {
          syncLog("info", `Auto-monitor (${klass}): pinned ${r.interfacesAdded} interface(s) on ${r.devices} device(s)`);
          await logEvent({
            action:       "integration.auto_monitor_interfaces.applied",
            resourceType: "integration",
            resourceId:   integrationId,
            resourceName: integrationName,
            actor,
            message:      `Auto-monitor interfaces applied for "${integrationName}" (${klass}) — ${r.devices} device(s), ${r.interfacesAdded} interface(s) added`,
            details:      { class: klass, devices: r.devices, interfacesAdded: r.interfacesAdded },
          });
        }
      } catch (err: any) {
        syncLog("error", `Auto-monitor (${klass}) failed: ${err?.message || "Unknown error"}`);
      }
    }
  }
}
