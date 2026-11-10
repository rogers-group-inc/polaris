/**
 * src/services/discovery/dhcp/subnetSync.ts — syncDhcpSubnets Phase 1: sync
 * the networks each gate serves (DHCP / DHCPv6 scopes, router-advertised
 * prefixes) into the IPAM tree. In-memory lookups, one locked create per new
 * network, one batched update for the rest. Skips an excluded CIDR whole (rule
 * 42); compares the serving chassis and raises a conflict on a replacement
 * (rule 41); retires a dead row squatting on the CIDR only when a different
 * gate now serves it; records a manual network's first claim. CQ-B060; the
 * body moved verbatim, its free variables made parameters. The caller keeps
 * the `full | skip-deprecation` gate. Imports nothing from the engine at
 * runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { SyncLog } from "../syncLog.js";
import type { ExclusionLike } from "../../../utils/subnetExclusion.js";
import { prisma } from "../../../db.js";
import { logEvent } from "../../eventLogService.js";
import { AppError } from "../../../utils/errors.js";
import { normalizeCidr, cidrOverlaps } from "../../../utils/cidr.js";
import { findCoveringExclusion } from "../../../utils/subnetExclusion.js";
import { classifyChassis, verdictWritesSerial, classifyDeprecatedSupersede } from "../../../utils/chassisIdentity.js";
import { createSubnetRowChecked } from "../../subnetService.js";
import { snapshotSubnet, archiveSubnet } from "../../subnetArchiveService.js";
import { raiseChassisReplacedConflict } from "../../subnetChassisConflictService.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/**
 * The FortiGate interface a discovered network is served on and, for a VLAN
 * interface, the interface it sits on (business rule 137). Only what the run
 * read: an entry whose interface table was not read this run (`vlanParent`
 * undefined) leaves the stored parent alone, so one failed CMDB read never
 * clears it.
 */
function subnetInterfaceFields(entry: { name?: string; vlanParent?: string | null }): {
  fortigateInterface?: string;
  fortigateVlanParent?: string | null;
} {
  return {
    ...(entry.name ? { fortigateInterface: entry.name } : {}),
    ...(entry.vlanParent !== undefined ? { fortigateVlanParent: entry.vlanParent } : {}),
  };
}

/**
 * Phase 1 — Sync subnets. Mutates the run's in-memory subnet state
 * (`allSubnets`, `subnetByCidr`, `siblingsByBlockId`, `deprecatedByBlockCidr`)
 * so Phase 2 and the later phases see what this phase wrote, and appends to
 * the run's `created` / `updated` / `skipped` lists, as before.
 */
export async function syncDiscoveredSubnets(input: {
  result: DiscoveryResult;
  allSubnets: any[];
  subnetByCidr: Map<string, any>;
  siblingsByBlockId: Map<string, any[]>;
  deprecatedByBlockCidr: Map<string, any>;
  subnetExclusions: readonly ExclusionLike[];
  /** Per processed device (FMG name AND FortiOS hostname, lower-case): its chassis set. */
  clusterSerialsByDevice: Map<string, Set<string>>;
  /** The most specific IPAM block containing a CIDR. */
  findParentBlock: (cidr: string) => { id: string; cidr: string } | undefined;
  created: string[];
  updated: string[];
  skipped: string[];
  integrationId: string;
  integrationName: string;
  integrationType: string;
  integrationLabel: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, allSubnets, subnetByCidr, siblingsByBlockId, deprecatedByBlockCidr, subnetExclusions,
    clusterSerialsByDevice, findParentBlock, created, updated, skipped,
    integrationId, integrationName, integrationType, integrationLabel, actor, syncLog,
  } = input;

  // Collect subnet updates to batch
  const subnetUpdates: Array<{ id: string; data: any }> = [];
  // First-claim audit trail: manual subnets (discoveredBy IS NULL) whose CIDR
  // discovery just matched. After the batch update we emit one
  // `subnet.claimed` Event per row so operators can see when an integration
  // took over a manually-created subnet.
  const claimedSubnets: Array<{
    id: string;
    cidr: string;
    previousName: string;
    newName: string;
    fortigateDevice: string;
  }> = [];
  // Subnets whose serving chassis changed this run (business rule 41).
  // Collected here and processed AFTER the batch update, because each one
  // archives a snapshot + raises a conflict and neither belongs inside the
  // tight per-subnet loop.
  const chassisReplacements: Array<{
    subnetId: string;
    cidr: string;
    blockId: string;
    from: string;
    to: string;
    oldDeviceName: string | null;
    newDeviceName: string | null;
  }> = [];

  for (const entry of result.subnets) {
    // What served the network names it: a DHCP scope (IPv4), a DHCPv6 scope,
    // or a prefix the gate announces by router advertisement (rule 125).
    const originLabel = entry.origin === "ra" ? "IPv6 RA" : entry.origin === "dhcp6" ? "DHCPv6" : "DHCP";
    let cidr: string;
    try {
      cidr = normalizeCidr(entry.cidr);
    } catch {
      skipped.push(`${entry.cidr} (invalid CIDR)`);
      continue;
    }

    // ── Excluded address space (business rule 42) ────────────────────────────
    // The operator has declared this CIDR out of scope for the networks list,
    // which is how a subnet several sites serve identically stops being one
    // row every site fights over. The entry is skipped WHOLE — before the
    // existing-row branch, not just the create — because the conflict this
    // exists to stop is raised by the UPDATE side: each site's gate answers
    // with its own serial, so the chassis check on a shared row reads
    // `replaced` on every run. No create, no update, no chassis comparison,
    // and (Phase 2) no stale sweep either.
    const excludedBy = findCoveringExclusion(cidr, subnetExclusions);
    if (excludedBy) {
      skipped.push(`${cidr} (excluded as "${excludedBy.name}")`);
      continue;
    }

    // Check if a non-deprecated subnet with this CIDR already exists (in-memory)
    const existing = subnetByCidr.get(cidr);
    if (existing) {
      const isFirstClaim = existing.discoveredBy == null;

      // ── Chassis identity (business rule 41) ──────────────────────────────
      // Is this still the same physical FortiGate? The stored serial, the one
      // this run reports, and the reporting device's whole cluster set decide.
      // `unknown` (nothing readable this run) writes nothing and constrains
      // nothing; `learn` adopts; `same` re-stamps so the stored value tracks
      // the active cluster member; `replaced` archives the old chassis's state
      // and raises a conflict WITHOUT re-pointing the serial — the pending
      // conflict is the unresolved state, and accepting it is what moves it.
      const chassis = classifyChassis(
        existing.fortigateSerial,
        entry.fortigateSerial,
        clusterSerialsByDevice.get((entry.fortigateDevice || "").toLowerCase()),
      );
      const serialToWrite = verdictWritesSerial(chassis);
      if (chassis.kind === "replaced") {
        chassisReplacements.push({
          subnetId: existing.id,
          cidr,
          blockId: existing.blockId,
          from: chassis.from,
          to: chassis.to,
          oldDeviceName: existing.fortigateDevice ?? null,
          newDeviceName: entry.fortigateDevice ?? null,
        });
      }

      const baseData: any = {
        discoveredBy: integrationId,
        fortigateDevice: entry.fortigateDevice,
        lastDiscoveredAt: new Date(),
        ...(serialToWrite ? { fortigateSerial: serialToWrite } : {}),
        ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
        ...subnetInterfaceFields(entry),
      };
      if (isFirstClaim) {
        // Bring the manually-created row into parity with a freshly-discovered
        // subnet so it stops looking like an orphan in tag/filter UI. Name +
        // status are intentionally overwritten on first claim (the manual
        // values were placeholders); operator-typed purpose is preserved.
        const existingTags: string[] = Array.isArray(existing.tags) ? existing.tags : [];
        baseData.name = `${originLabel}: ${entry.name} (${entry.fortigateDevice})`;
        baseData.status = "available";
        baseData.tags = Array.from(new Set([...existingTags, "dhcp-discovered", integrationType]));
        if (!existing.purpose) {
          baseData.purpose = `Discovered from ${integrationLabel} ${originLabel}`;
        }
        claimedSubnets.push({
          id: existing.id,
          cidr,
          previousName: existing.name,
          newName: baseData.name,
          fortigateDevice: entry.fortigateDevice,
        });
      }
      subnetUpdates.push({ id: existing.id, data: baseData });
      updated.push(cidr);
      continue;
    }

    // Find the most specific parent block
    const matchingBlock = findParentBlock(cidr);
    if (!matchingBlock) {
      skipped.push(`${cidr} (no matching parent block)`);
      continue;
    }

    // ── A dead subnet must not squat on the CIDR (business rule 41) ─────────
    //
    // A subnet deprecated before the chassis column existed — or by Phase 2
    // when its gate left the roster — still holds `@@unique([blockId, cidr])`
    // while being INVISIBLE to `subnetByCidr` above. So a replacement gate
    // reporting the identical range matched nothing, fell through to the
    // create, and was refused by the committed-state overlap check on the dead
    // row: skipped every run, forever, with a self-overlap message. The chassis
    // check above cannot reach this case — it only runs when a LIVE row exists
    // to compare against.
    //
    // Retire the dead row here so the create can proceed, but ONLY when a
    // DIFFERENT gate is now serving that space (`classifyDeprecatedSupersede`).
    // An operator who deprecated a subnet its own gate still serves gets it
    // re-reported every cycle, and archiving there would silently undo their
    // decision and hand the range back as active.
    const deadKey = `${matchingBlock.id}|${cidr}`;
    const dead = deprecatedByBlockCidr.get(deadKey);
    if (dead) {
      const verdict = classifyDeprecatedSupersede({
        storedSerial: dead.fortigateSerial,
        storedDeviceName: dead.fortigateDevice,
        discoveredSerial: entry.fortigateSerial,
        discoveredDeviceName: entry.fortigateDevice,
        clusterSerials: clusterSerialsByDevice.get((entry.fortigateDevice || "").toLowerCase()),
      });
      if (verdict.kind === "supersede") {
        try {
          const snap = await archiveSubnet(dead.id, { actor, reason: "chassis-replaced" });
          // Drop it from every in-memory structure so Phase 2 and the later
          // phases cannot act on a row that no longer exists.
          deprecatedByBlockCidr.delete(deadKey);
          const at = allSubnets.findIndex((s: any) => s.id === dead.id);
          if (at >= 0) allSubnets.splice(at, 1);
          syncLog(
            "info",
            `Retired the dead subnet ${cidr} (was served by "${dead.fortigateDevice || "unknown"}", ` +
              `${snap.reservationCount} reservation(s) archived) so "${entry.fortigateDevice}" can serve it — ` +
              `superseded by ${verdict.via === "serial" ? "a different chassis serial" : "a different FortiGate"}`,
          );
        } catch (err: any) {
          skipped.push(`${cidr} (could not archive the deprecated subnet it replaces)`);
          syncLog("error", `Failed to archive deprecated subnet ${cidr}: ${err?.message || "Unknown error"}`);
          continue;
        }
      } else {
        // Deliberately actionable: the old message was a bare self-overlap and
        // told an operator nothing about what to do.
        skipped.push(`${cidr} (a deprecated network still holds this range — archive it to free the address space)`);
        syncLog(
          "warning",
          `Subnet ${cidr} is still held by a deprecated network on the same FortiGate ` +
            `("${dead.fortigateDevice || "unknown"}", ${verdict.reason}). Its address space stays reserved ` +
            `until that network is archived; discovery will not reactivate a network somebody retired.`,
        );
        continue;
      }
    }

    // Cheap in-memory pre-filter against the siblings this run already knows
    // about — avoids a pointless transaction for the common "obviously
    // overlapping" case and keeps the skip reason specific.
    const siblings = siblingsByBlockId.get(matchingBlock.id) || [];
    const overlap = siblings.find((s: any) => cidrOverlaps(s.cidr, cidr));
    if (overlap) {
      skipped.push(`${cidr} (overlaps ${overlap.cidr})`);
      continue;
    }

    // Create the subnet through the locked seam in subnetService. Discovery
    // runs in its own process, concurrently with operators creating subnets in
    // the web UI, so the in-memory sibling snapshot above is inherently stale:
    // it was read at the top of this phase. createSubnetRowChecked re-tests the
    // overlap against committed state under the per-block advisory lock, so a
    // subnet an operator added mid-run is seen and this create is skipped
    // instead of landing an overlapping row.
    try {
      const newSubnet = await createSubnetRowChecked({
        blockId: matchingBlock.id,
        cidr,
        name: `${originLabel}: ${entry.name} (${entry.fortigateDevice})`,
        purpose: `Discovered from ${integrationLabel} ${originLabel}`,
        status: "available",
        discoveredBy: integrationId,
        fortigateDevice: entry.fortigateDevice,
        // Chassis identity from the first sighting. A fresh row has nothing to
        // compare against, so this is a learn, never a replacement.
        ...(entry.fortigateSerial ? { fortigateSerial: entry.fortigateSerial } : {}),
        lastDiscoveredAt: new Date(),
        tags: ["dhcp-discovered", integrationType],
        ...(entry.vlan != null ? { vlan: entry.vlan } : {}),
        ...subnetInterfaceFields(entry),
      // Hand the seam this run's already-loaded exclusion set so its business
      // rule 42 backstop costs no read per created subnet.
      }, { exclusions: subnetExclusions });
      // Update in-memory state so later phases can find this subnet
      allSubnets.push(newSubnet);
      subnetByCidr.set(cidr, newSubnet);
      const blockSiblings = siblingsByBlockId.get(matchingBlock.id) || [];
      blockSiblings.push(newSubnet);
      siblingsByBlockId.set(matchingBlock.id, blockSiblings);
      created.push(cidr);
    } catch (err: any) {
      // A 409 is the locked seam telling us a sibling landed between this run's
      // sibling snapshot and now (an operator created it mid-run). That is a
      // normal skip, not a failure, so it must not colour the run's log red.
      if (err instanceof AppError && err.httpStatus === 409) {
        skipped.push(`${cidr} (${err.message})`);
        syncLog("info", `Skipped subnet ${cidr}: ${err.message}`);
      } else {
        skipped.push(`${cidr} (create failed)`);
        syncLog("error", `Failed to create subnet ${cidr}: ${err.message || "Unknown error"}`);
      }
    }
  }

  // Batch-execute subnet updates (discoveredBy/fortigateDevice)
  if (subnetUpdates.length > 0) {
    await mapSettledWithConcurrency(subnetUpdates, 50, (u) =>
      prisma.subnet.update({ where: { id: u.id }, data: u.data })
    );
    // Mirror each write onto the in-memory row Phase 2 filters.
    //
    // Phase 2 decides staleness from `allSubnets` — the snapshot read at the
    // top of this function — and `subnetByCidr` hands out references INTO it.
    // So a subnet this phase just re-pointed at a renamed or replaced gate
    // still carried the OLD `fortigateDevice` in memory, was not found in the
    // roster, and was deprecated by Phase 2 in the SAME run that had just
    // re-pointed it. The DB then held a subnet pointing at a live gate with
    // status=deprecated, and because a deprecated row is invisible to
    // `subnetByCidr` (no update path) while still occupying
    // `@@unique([blockId, cidr])` (no create path), that CIDR could never be
    // recorded again — every later run skipped it with a self-overlap message.
    // A gate rename was enough to trigger it.
    const subnetById = new Map(allSubnets.map((s: any) => [s.id, s]));
    for (const u of subnetUpdates) {
      const row = subnetById.get(u.id);
      if (row) Object.assign(row, u.data);
    }
  }

  // ── Chassis replacements (business rule 41) ────────────────────────────────
  // Archive a COPY of what the old chassis served, then raise one conflict per
  // subnet. Additive on purpose: no live reservation is released, re-pushed or
  // deleted on the strength of an automatic detection, so a false positive
  // costs a card and an archive row rather than data. Migration is an explicit
  // operator action.
  for (const rep of chassisReplacements) {
    try {
      const snap = await snapshotSubnet(
        rep.subnetId,
        { reason: "chassis-replaced", actor },
      );
      const outcome = await raiseChassisReplacedConflict({
        subnetId: rep.subnetId,
        cidr: rep.cidr,
        blockId: rep.blockId,
        oldSerial: rep.from,
        newSerial: rep.to,
        oldDeviceName: rep.oldDeviceName,
        newDeviceName: rep.newDeviceName,
        archivedSubnetId: snap.archivedSubnetId,
        integrationId,
        integrationName,
        actor,
      });
      syncLog(
        "warning",
        `Subnet ${rep.cidr} is served by a different FortiGate chassis (${rep.from} → ${rep.to}) — ` +
          `${snap.reservationCount} reservation(s) archived, conflict ${outcome}`,
      );
    } catch (err: any) {
      // Never fail the run over this: the subnet itself synced fine, and the
      // next pass re-derives the verdict from the still-unchanged stored serial.
      syncLog("error", `Failed to record chassis replacement for ${rep.cidr}: ${err?.message || "Unknown error"}`);
    }
  }

  // Emit one `subnet.claimed` Event per first-claim row (manual → discovered
  // transition). Fires once per subnet; subsequent discovery passes see
  // discoveredBy already set and skip the claim branch entirely.
  for (const c of claimedSubnets) {
    logEvent({
      action: "subnet.claimed",
      resourceType: "subnet",
      resourceId: c.id,
      resourceName: c.newName,
      actor,
      message: `Subnet "${c.previousName}" (${c.cidr}) claimed by "${integrationName}" — now tracked as "${c.newName}"`,
      details: {
        reason: "first-claim",
        previousName: c.previousName,
        previousDiscoveredBy: null,
        integrationId,
        integrationName,
        fortigateDevice: c.fortigateDevice,
        cidr: c.cidr,
      },
    });
  }
}
