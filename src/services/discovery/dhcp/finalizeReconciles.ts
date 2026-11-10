/**
 * src/services/discovery/dhcp/finalizeReconciles.ts — syncDhcpSubnets Phases
 * 12 to 13.7, the run-wide reconciles a finalize pass owns: the dependency
 * tree recompute (12), map-region tags (13), criteria tags (13.65), the
 * management-access summaries (13.6) and the description-sync reconcile
 * (13.7). Each is best-effort and never blocks the sync's return. CQ-B060;
 * the body moved verbatim. The caller keeps the `finalizePhasesEnabled(mode)`
 * gate and passes its `phaseMark` timer, so each sub-phase still logs its own
 * elapsed time.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { SyncMode } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { ManagementAccessSummary } from "../../fortinetManagementAccessService.js";
import { prisma } from "../../../db.js";
import { chunkArray } from "../../../utils/chunk.js";
import { isFortinetIntegrationType } from "../../../utils/pollingCompatibility.js";
import { recomputeDependencyTree } from "../../dependencyTreeService.js";
import { runDescriptionSyncForIntegration } from "../../descriptionSyncService.js";
import { anyDescriptionSyncEnabled } from "../../../utils/descriptionSyncFlags.js";
import { reconcileMapRegions } from "../../mapRegionService.js";
import { reconcileAllTags } from "../../tagAssignmentService.js";

export async function runFinalizeReconciles(input: {
  integrationId: string;
  integrationType: string;
  mode: SyncMode;
  result: DiscoveryResult;
  /** syncDhcpSubnets' per-phase timer; called between the sub-phases, as before. */
  phaseMark: (name: string) => void;
  syncLog: SyncLog;
}): Promise<void> {
  const { integrationId, integrationType, mode, result, phaseMark, syncLog } = input;
  try {
    const dep = await recomputeDependencyTree(integrationId);
    if (dep.scoped > 0) {
      syncLog("info", `Dependency tree: ${dep.edgesWritten} edge(s) across ${dep.scoped} asset(s)${dep.unresolved > 0 ? `, ${dep.unresolved} unresolved` : ""}${dep.endpointEdges > 0 ? `; ${dep.endpointEdges} endpoint edge(s)` : ""}`);
    }
  } catch (err: any) {
    syncLog("error", `Dependency tree recompute failed: ${err?.message || "Unknown error"}`);
  }

  phaseMark("13");
  // Phase 13 — Re-evaluate map-region tags. Any firewall whose lat/lng now
  // falls inside an operator-drawn region (or any FortiSwitch / FortiAP whose
  // controllerFortigate matches one, or any subnet one of those firewalls
  // serves) gets its `region:<name>` tag stamped — and a target that has
  // MOVED out since we tagged it has the tag stripped, bounded by the
  // RegionTagAssignment provenance rows so hand-applied tags survive. Running
  // here is what makes a device re-pinned or re-parented by THIS discovery
  // run land in the right region without waiting for the 6-hour tick; the
  // cost is that a transiently-absent gate pin churns its subtree's tags for
  // one pass. Best-effort, gated like Phase 12 (a scoped run reconciles
  // too: a DB-wide pass, idempotent, and it is what tags a new switch).
  try {
    const summary = await reconcileMapRegions();
    if (summary.assetsTouched > 0 || summary.subnetsTouched > 0) {
      syncLog(
        "info",
        `Map region tags: +${summary.added}/-${summary.removed} on ${summary.assetsTouched} asset(s), ` +
          `+${summary.subnetsAdded}/-${summary.subnetsRemoved} on ${summary.subnetsTouched} network(s)`,
      );
    }
  } catch (err: any) {
    syncLog("error", `Map region reconcile failed: ${err?.message || "Unknown error"}`);
  }

  phaseMark("13.65");
  // Phase 13.65 — Reconcile criteria-based auto-assigned tags. Newly
  // discovered / changed assets that now match (or no longer match) an
  // operator-defined tag criteria get the tag added / removed (managed sync,
  // engine-owned copies only). Best-effort. See src/services/tagAssignmentService.ts.
  try {
    const summary = await reconcileAllTags();
    if (summary.added > 0 || summary.removed > 0) {
      syncLog("info", `Criteria tags: +${summary.added} / -${summary.removed}`);
    }
  } catch (err: any) {
    syncLog("error", `Tag-assignment reconcile failed: ${err?.message || "Unknown error"}`);
  }

  phaseMark("13.6");
  // Phase 13.6 — Write the management-access (`allowaccess`) summaries each
  // gate's own discovery pass built (result.managementAccess; see
  // fortinetManagementAccessService → summarizeGateManagementAccess) onto
  // Asset.managementAccess. Firewall: the operator-named management
  // interface's allowaccess. FortiAP: its wtp-profile's allowaccess.
  // FortiSwitch: the controller's local-access policy. Drives the
  // slide-over's Open HTTPS / Open SSH buttons + the FortiAP "SNMP not
  // enabled" warning. No device or FortiManager call happens here — until
  // 2026-11 this phase re-read every gate after discovery finished. A device
  // absent from the list (its table was not read) keeps what it had.
  // FMG/FortiGate only; gated like Phases 12/13; a scoped run's result
  // carries its one gate. Best-effort — never blocks the sync.
  if (isFortinetIntegrationType(integrationType) && (result.managementAccess?.length ?? 0) > 0) {
    try {
      const summaries = new Map<string, ManagementAccessSummary>();
      for (const m of result.managementAccess!) {
        if (m?.serial && !summaries.has(m.serial)) summaries.set(m.serial, m.summary);
      }
      // Map device serial → assetId via the AssetSource rows discovery wrote
      // (externalId === serial for these sourceKinds), then batch the writes
      // in chunked transactions (no per-row awaits — bounded at 2000 assets).
      const sources = await prisma.assetSource.findMany({
        where: {
          integrationId,
          sourceKind: { in: ["fortigate-firewall", "fortiswitch", "fortiap"] },
          externalId: { in: [...summaries.keys()] },
        },
        select: { assetId: true, externalId: true },
      });
      const seen = new Set<string>();
      const updates: Array<ReturnType<typeof prisma.asset.update>> = [];
      for (const src of sources) {
        const summary = summaries.get(src.externalId);
        if (!summary || seen.has(src.assetId)) continue;
        seen.add(src.assetId);
        updates.push(prisma.asset.update({ where: { id: src.assetId }, data: { managementAccess: summary as any } }));
      }
      for (const chunk of chunkArray(updates, 200)) {
        await prisma.$transaction(chunk);
      }
      if (updates.length > 0) syncLog("info", `Management-access: recorded allowaccess for ${updates.length} device(s)`);
    } catch (err: any) {
      syncLog("error", `Management-access write failed: ${err?.message || "Unknown error"}`);
    }
  }

  phaseMark("13.7");
  // Phase 13.7 — Description sync reconcile (Polaris-primary; gated by the
  // integration's per-class FortiGate / FortiSwitch / FortiAP toggles,
  // all default off = zero cost; the service skips each class that's off). Per
  // FortiGate: read the current device-side descriptions (system/interface,
  // system/global, managed-switch, wtp — through the shared push transport,
  // so both useProxy modes work), adopt device values where Polaris has
  // none, and re-push wherever the device drifted from a non-empty Polaris
  // value. Also the retry path for save-time pushes that failed
  // transiently. Best-effort — failures are logged and never block the sync.
  if (isFortinetIntegrationType(integrationType)) {
    try {
      const integrationRow = await prisma.integration.findUnique({
        where: { id: integrationId },
        select: { id: true, type: true, config: true, name: true },
      });
      if (integrationRow && anyDescriptionSyncEnabled(integrationRow.config)) {
        // A scoped run reconciles only its gate's group (rule 142).
        const onlyDevices = mode === "finalize-scoped"
          ? result.devices.flatMap((d) => [d.name, d.hostname]).filter((n): n is string => !!n)
          : undefined;
        const summary = await runDescriptionSyncForIntegration(integrationRow, onlyDevices);
        if (summary.pushed || summary.adopted || summary.failed || summary.skippedDevices || summary.fmgMirrored || summary.fmgMirrorFailed) {
          syncLog("info", `Description sync: pushed ${summary.pushed}, adopted ${summary.adopted}, failed ${summary.failed}${summary.fmgMirrored || summary.fmgMirrorFailed ? `, FMG mirror ${summary.fmgMirrored} ok / ${summary.fmgMirrorFailed} failed` : ""}${summary.skippedDevices ? `, ${summary.skippedDevices} device(s) skipped` : ""}`);
        }
      }
    } catch (err: any) {
      syncLog("error", `Description sync failed: ${err?.message || "Unknown error"}`);
    }
  }
}
