/**
 * src/services/assetMergeService.ts
 *
 * Operator-driven asset merge — the inverse of the Sources-tab "Split" action
 * (POST /assets/:id/sources/:sourceId/split). An operator who finds two Asset
 * rows that are really the same physical device (e.g. a FortiGate-discovered
 * endpoint and an AD computer that never cross-linked) picks one as the
 * survivor (canonical) and absorbs the other (ghost) into it.
 *
 * How this differs from the automatic merges:
 *   - `mergeDuplicateHostnameAssets` job cascade-DELETEs the ghost's
 *     AssetSource rows (it assumes the ghost's sources are redundant
 *     duplicates of the canonical's). Here the whole point is that the two
 *     assets carry DIFFERENT discovery sources, so we RE-BIND the ghost's
 *     AssetSource rows onto the canonical — the survivor ends up
 *     multi-source. The global unique constraint on (sourceKind, externalId)
 *     guarantees no collision: two distinct assets can never already hold the
 *     same source identity. `absorbAssetRelations` below is that re-bind, and
 *     is SHARED with the conflict-resolution ghost absorb in
 *     `api/routes/conflicts.ts` (`acceptAssetConflict`) — merging a sibling
 *     conflict must not drop the duplicate's unrelated sources either.
 *   - Those paths blank-fill only. Here the caller supplies per-field winners
 *     (operator chose, field by field, in the comparison UI). An empty value
 *     never overwrites a populated one whatever the winner says, and for
 *     `assetType` the `other` catch-all counts as empty (`fieldIsEmpty`) — a
 *     specific type always beats it.
 *
 * What is preserved vs. discarded (matches the confirmed product decision —
 * the comparison UI tells the operator to keep the asset with monitoring
 * history as the survivor):
 *   - Re-bound onto the survivor: AssetSource rows, AssetMacAddress,
 *     AssetAssociatedIp, AssetIpHistory, AssetFortigateSighting (all
 *     delete-on-conflict against the survivor's existing rows), the
 *     ManagedAgent enrollment IFF the survivor has none, and the
 *     AssetDependencyParent edges (see `transferDependencyEdges` — dependents
 *     always re-point to the survivor; the absorbed asset's own parent links
 *     blank-fill, with an operator-chosen winner when BOTH sides have
 *     parents, since one physical device has one real upstream and unioning
 *     two parent sets would weaken all-down suppression).
 *   - `monitored` is OR-ed across the two rows: if either side was monitored,
 *     the survivor comes out monitored. Same intent as the automatic
 *     endpoint-ghost merge (`assetGhostMergeService.transferredMonitored`) —
 *     monitoring is an explicit operator choice and a merge must not silently
 *     drop it. When the carry-over actually flips the survivor ON, the ghost's
 *     monitoring CONFIGURATION rides along too (per-stream polling methods,
 *     credentials, MIBs, intervals/timeouts, and the pinned interface /
 *     storage / process / service / tunnel arrays) — enabling the flag without
 *     it would leave a monitored asset whose streams resolve off the survivor's
 *     empty overrides. Business rule 10 still wins: a survivor whose merged
 *     status lands on decommissioned/disabled stays unmonitored.
 *   - Cascade-DELETED with the ghost (FK kept): LLDP neighbors, wireless
 *     stations, interface comment overrides, and pending Conflicts. The
 *     survivor keeps its own. Called out in the confirm dialog.
 *   - ORPHANED + aged out (no FK since migration 20260615000000): all
 *     monitoring/telemetry/interface/storage/temperature/IPsec/SD-WAN/custom-
 *     widget samples + every *Hourly/*Daily rollup. These are TimescaleDB
 *     hypertables; a cascade DELETE matching compressed-chunk rows would
 *     decompress them into un-truncatable bloat (prod incident 2026-06-08), so
 *     the ghost's sample rows are left orphaned (never queried) and removed by
 *     drop_chunks on the retention schedule. Net effect matches the old cascade
 *     (the ghost's history isn't carried onto the survivor), just bloat-free.
 *
 * Scale note: every transfer is bounded by ONE ghost asset's side-table rows
 * (tens, not thousands) inside a single transaction. Not a ticking job — a
 * one-shot operator action. Safe at 100 and 2000 monitored assets.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { clampAcquiredToLastSeen } from "../utils/assetInvariants.js";
import { isGenericAssetType } from "../utils/assetTypes.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";

// Scalar fields the comparison UI diffs and the operator can pick a winner
// for. Kept in sync with the COMPARE_FIELDS list in public/js/assets.js so the
// modal and the server agree on what's mergeable. Tags (union) and lastSeen
// (max) are handled separately below and are NOT in this list.
export const MERGEABLE_FIELDS = [
  "hostname",
  "dnsName",
  "ipAddress",
  "macAddress",
  "serialNumber",
  "manufacturer",
  "model",
  "assetType",
  "status",
  "location",
  "learnedLocation",
  "department",
  "assignedTo",
  "os",
  "osVersion",
  "snmpLocation",
  "learnedAddress",
  "purchaseOrder",
  "notes",
  "acquiredAt",
  "warrantyExpiry",
] as const;

export type MergeableField = (typeof MERGEABLE_FIELDS)[number];
export type FieldWinner = "canonical" | "ghost";

/**
 * Monitoring configuration carried from the ghost onto the survivor when the
 * merge flips the survivor's `monitored` ON (i.e. the ghost was the monitored
 * side). Nullable scalars: the ghost's non-null value wins, the survivor's is
 * kept wherever the ghost has none — the survivor was NOT being polled, so any
 * override it holds is inert config that no successful poll ever validated,
 * while the ghost's is the configuration that was actually working.
 *
 * NOT carried when both sides were already monitored: the survivor's own
 * working configuration is authoritative and must not be rewritten by the
 * absorbed row.
 */
const MONITOR_CONFIG_FIELDS = [
  // Per-stream polling methods (null = inherit from the settings hierarchy).
  "responseTimePolling",
  "cpuMemoryPolling",
  "temperaturePolling",
  "interfacesPolling",
  "lldpPolling",
  "storagePolling",
  "processesPolling",
  "eventLogPolling",
  "customWidgetPolling",
  // Credentials the above methods authenticate with.
  "monitorCredentialId",
  "responseTimeCredentialId",
  "cpuMemoryCredentialId",
  "temperatureCredentialId",
  "interfacesCredentialId",
  "lldpCredentialId",
  "customWidgetCredentialId",
  "processesCredentialId",
  "eventLogCredentialId",
  // Per-stream MIB pins.
  "responseTimeMibId",
  "cpuMemoryMibId",
  "temperatureMibId",
  "interfacesMibId",
  "lldpMibId",
  "processesMibId",
  // Cadence + timeout overrides.
  "monitorIntervalSec",
  "cpuMemoryIntervalSec",
  "temperatureIntervalSec",
  "systemInfoIntervalSec",
  "lldpIntervalSec",
  "storageIntervalSec",
  "customWidgetIntervalSec",
  "processesIntervalSec",
  "eventLogIntervalSec",
  "cpuMemoryTimeoutMs",
  "temperatureTimeoutMs",
  "systemInfoTimeoutMs",
  "customWidgetTimeoutMs",
  "processesTimeoutMs",
  "eventLogTimeoutMs",
] as const;

/**
 * Operator pin arrays carried the same way, but UNIONed rather than overwritten
 * — a pin is additive intent ("also poll this interface"), and the survivor's
 * own pins stay valid. Order-preserving with the survivor's first.
 */
const MONITOR_PIN_FIELDS = [
  "monitoredInterfaces",
  "monitoredStorage",
  "monitoredIpsecTunnels",
  "monitoredProcesses",
  "monitoredServices",
  "mappedProcesses",
  "mappedServices",
] as const;

type MonitorCarryField =
  | (typeof MONITOR_CONFIG_FIELDS)[number]
  | (typeof MONITOR_PIN_FIELDS)[number];

const MONITOR_CARRY_SELECT = Object.fromEntries(
  [...MONITOR_CONFIG_FIELDS, ...MONITOR_PIN_FIELDS].map((f) => [f, true]),
) as Record<MonitorCarryField, true>;

type AssetForMerge = {
  id: string;
  hostname: string | null;
  lastSeen: Date | null;
  acquiredAt: Date | null;
  tags: string[];
  monitored: boolean;
} & Record<string, unknown>;

export interface MergeAssetsResult {
  survivorId: string;
  absorbedId: string;
  movedSources: number;
  movedMacs: number;
  movedIps: number;
  movedIpHistory: number;
  movedSightings: number;
  movedManagedAgent: boolean;
  appliedFields: string[];
  /** True when the ghost's monitored=true flipped the survivor ON. */
  carriedMonitoring: boolean;
  /** Monitoring config/pin fields adopted from the ghost alongside that flip. */
  monitorFieldsAdopted: string[];
  /** Ghost's upstream dependency links now on the survivor. */
  movedDependencyParents: number;
  /** True when the ghost's parent set REPLACED a survivor set (operator picked the ghost side). */
  replacedDependencyParents: boolean;
  /** Downstream dependency edges (devices depending on the ghost) re-pointed at the survivor. */
  movedDependents: number;
}

const ASSET_SELECT = {
  id: true,
  hostname: true,
  dnsName: true,
  ipAddress: true,
  macAddress: true,
  serialNumber: true,
  manufacturer: true,
  model: true,
  assetType: true,
  status: true,
  location: true,
  learnedLocation: true,
  department: true,
  assignedTo: true,
  os: true,
  osVersion: true,
  snmpLocation: true,
  learnedAddress: true,
  purchaseOrder: true,
  notes: true,
  acquiredAt: true,
  warrantyExpiry: true,
  lastSeen: true,
  lastSeenSource: true,
  lastSeenSwitch: true,
  lastSeenAp: true,
  tags: true,
  monitored: true,
  // Monitoring config + pins, for the monitored-side carry-over below. Derived
  // from the two lists above so they stay the single source of truth (the cast
  // gives Prisma literal keys instead of fromEntries' string index signature).
  ...MONITOR_CARRY_SELECT,
} as const;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Per-field emptiness. For `assetType` the `other` catch-all counts as empty
 * (`isGenericAssetType`): it says "unclassified", so a specific type on the
 * absorbed row fills it by default and "other" is never written over a
 * specific type, whatever the caller's winner says. Mirrored client-side by
 * `_mergeFieldIsEmpty` in public/js/asset-merge-modal.js, which pre-selects
 * the radios and previews the write.
 */
function fieldIsEmpty(field: MergeableField, v: unknown): boolean {
  if (isEmpty(v)) return true;
  return field === "assetType" && isGenericAssetType(v as string);
}

/**
 * Fields that are COMBINED across the two rows rather than won by one side.
 *
 * `notes` is the only one. Every other mergeable field names a single fact
 * about the device — it has one hostname, one serial, one owner — so picking a
 * winner is the right verb and the loser's value is redundant. Notes are not a
 * fact, they are an accumulated operator record, and each side's was written by
 * somebody who did not know the other row existed. Discarding half of that is a
 * silent data loss that no comparison UI makes obvious (the loser's text simply
 * stops existing), and a merge is irreversible.
 *
 * Kept in MERGEABLE_FIELDS so the field list stays the one vocabulary the route
 * validates and the select is derived from; a `fieldWinners` entry naming one
 * of these is accepted and IGNORED rather than refused, so an older client (or
 * the conflict-card merge, which sends no winners at all) cannot fail on it.
 */
export const CONCATENATED_FIELDS: readonly MergeableField[] = ["notes"];

/** One side of a notes combine — the text and the name to label it with. */
export interface NotesSide {
  notes?: string | null;
  hostname?: string | null;
  id?: string | null;
}

/**
 * Combine both rows' notes into the survivor's, labeled by the asset each block
 * came from so the record stays legible a year later.
 *
 * Returns `undefined` when there is nothing to write — no notes on either side,
 * or the survivor's text already contains the absorbed row's (the idempotence
 * guard that stops a second merge from stacking the same block twice).
 *
 * Shape decisions, all of them about not manufacturing noise:
 *   - one side empty → the other's text is written through UNLABELED. Nothing
 *     was combined, so a provenance header would be pure clutter.
 *   - identical text on both sides → written once, unlabeled. Same reasoning.
 *   - labels that collide (the duplicate-hostname merge, where both rows carry
 *     the same name) are disambiguated with a short id, because two blocks
 *     under one identical header say nothing.
 *
 * `notes` is a `@db.Text` column and the result is editable on the asset form
 * afterwards, so this is a starting value rather than a final one.
 *
 * NOTE: mirrored in `public/js/asset-merge-modal.js` (`_mergeCombineNotes`) for
 * the comparison preview. The two must agree — there is no build step to share
 * one implementation, so a change here needs the same change there.
 */
export function combineAssetNotes(
  canonical: NotesSide,
  ghost: NotesSide,
): string | undefined {
  const cText = (canonical.notes ?? "").trim();
  const gText = (ghost.notes ?? "").trim();

  if (!cText && !gText) return undefined;
  if (!gText) return undefined;            // survivor keeps what it has
  if (!cText) return gText;                // nothing to combine with
  if (cText === gText) return undefined;   // already says it
  if (cText.includes(gText)) return undefined;

  const label = (side: NotesSide, other: NotesSide): string => {
    const name = (side.hostname ?? "").trim() || "unnamed asset";
    const otherName = (other.hostname ?? "").trim() || "unnamed asset";
    if (name !== otherName) return name;
    const suffix = (side.id ?? "").slice(0, 8);
    return suffix ? `${name} · ${suffix}` : name;
  };

  return `[${label(canonical, ghost)}]\n${cText}\n\n[${label(ghost, canonical)}]\n${gText}`;
}

export interface SideTableTransferCounts {
  movedMacs: number;
  movedIps: number;
  movedIpHistory: number;
  movedSightings: number;
}

/**
 * Transfer the four per-asset side tables (AssetMacAddress /
 * AssetAssociatedIp / AssetIpHistory / AssetFortigateSighting) from one
 * asset to another inside the caller's transaction. Each is unique on
 * (assetId, <key>): non-colliding rows re-point to the target, colliding
 * rows are deleted (the target's row wins). Shared by the operator merge
 * below and the endpoint-ghost merge in assetGhostMergeService.
 */
export async function transferAssetSideTables(
  tx: any,
  fromAssetId: string,
  toAssetId: string,
): Promise<SideTableTransferCounts> {
  const moveUnique = async (delegate: any, keyField: string): Promise<number> => {
    const cur = await delegate.findMany({
      where: { assetId: toAssetId },
      select: { [keyField]: true },
    });
    const curSet = new Set(cur.map((r: any) => r[keyField]));
    const incoming = await delegate.findMany({
      where: { assetId: fromAssetId },
      select: { id: true, [keyField]: true },
    });
    let moved = 0;
    for (const r of incoming) {
      if (curSet.has(r[keyField])) {
        await delegate.delete({ where: { id: r.id } });
      } else {
        await delegate.update({ where: { id: r.id }, data: { assetId: toAssetId } });
        curSet.add(r[keyField]);
        moved++;
      }
    }
    return moved;
  };
  return {
    movedMacs: await moveUnique(tx.assetMacAddress, "mac"),
    movedIps: await moveUnique(tx.assetAssociatedIp, "ip"),
    movedIpHistory: await moveUnique(tx.assetIpHistory, "ip"),
    movedSightings: await moveUnique(tx.assetFortigateSighting, "fortigateDevice"),
  };
}

export type DependencyParentWinner = "canonical" | "ghost";

export interface DependencyTransferCounts {
  movedDependencyParents: number;
  replacedDependencyParents: boolean;
  movedDependents: number;
}

/**
 * Carry the dependency DAG across a merge inside the caller's transaction.
 * Before this existed every AssetDependencyParent edge cascade-deleted with
 * the absorbed asset — including operator-pinned `override` rows nothing ever
 * recomputes, and every downstream device's edge when the absorbed asset was
 * their PARENT (a merged-away switch silently unparented its whole subtree
 * until the next discovery finalize).
 *
 * Two halves with different rules:
 *
 *   - DOWNSTREAM (rows where the absorbed asset is the parent): always
 *     re-pointed to the survivor — the two rows were one physical device, so
 *     everything that depended on the absorbed record depends on the survivor.
 *     A row whose child already holds the same (child, survivor, source) edge
 *     is left to cascade (the child's existing edge wins the unique key), as
 *     is a row whose child IS the survivor (re-pointing would self-edge).
 *
 *   - UPSTREAM (the absorbed asset's own parent links): blank-fill — moved
 *     only when the survivor has no parent rows of its own. When BOTH sides
 *     have parents, `parentWinner` decides WHOLESALE: one device has one real
 *     upstream, and unioning two parent sets would weaken all-down suppression
 *     (a dead parent from one record "covered" by a live parent from the
 *     other). "canonical" (default — the conflict-absorb path's behavior)
 *     keeps the survivor's set and lets the ghost's cascade; "ghost" deletes
 *     the survivor's rows and moves the ghost's. The merge modal surfaces the
 *     conflict and passes the operator's pick. A ghost row naming the survivor
 *     as parent is never moved (self-edge).
 *
 * Both callers delete the absorbed asset afterwards, so "not moved" needs no
 * explicit delete — the cascade handles it. Bounded by one asset's edges; the
 * worst case (a site gate parenting every endpoint behind it) is a single
 * set-based updateMany over the (indexed) parentAssetId.
 */
export async function transferDependencyEdges(
  tx: any,
  fromAssetId: string,
  toAssetId: string,
  parentWinner: DependencyParentWinner = "canonical",
): Promise<DependencyTransferCounts> {
  // ── Upstream half: the absorbed asset's own parent links ──
  const [fromParents, toParents] = await Promise.all([
    tx.assetDependencyParent.findMany({
      where: { assetId: fromAssetId },
      select: { id: true, parentAssetId: true },
    }),
    tx.assetDependencyParent.findMany({
      where: { assetId: toAssetId },
      select: { id: true },
    }),
  ]);

  let movedDependencyParents = 0;
  let replacedDependencyParents = false;
  if (fromParents.length > 0 && (toParents.length === 0 || parentWinner === "ghost")) {
    if (toParents.length > 0) {
      await tx.assetDependencyParent.deleteMany({ where: { assetId: toAssetId } });
      replacedDependencyParents = true;
    }
    const moveIds = fromParents
      .filter((r: any) => r.parentAssetId !== toAssetId)
      .map((r: any) => r.id);
    if (moveIds.length > 0) {
      const res = await tx.assetDependencyParent.updateMany({
        where: { id: { in: moveIds } },
        data: { assetId: toAssetId },
      });
      movedDependencyParents = res.count;
    }
  }

  // ── Downstream half: devices depending on the absorbed asset ──
  const [fromChildren, toChildren] = await Promise.all([
    tx.assetDependencyParent.findMany({
      where: { parentAssetId: fromAssetId },
      select: { id: true, assetId: true, source: true },
    }),
    tx.assetDependencyParent.findMany({
      where: { parentAssetId: toAssetId },
      select: { assetId: true, source: true },
    }),
  ]);
  const held = new Set(toChildren.map((r: any) => `${r.assetId}|${r.source}`));
  const childMoveIds: string[] = [];
  for (const r of fromChildren) {
    if (r.assetId === toAssetId) continue; // would self-edge
    const key = `${r.assetId}|${r.source}`;
    if (held.has(key)) continue; // child already bound to the survivor
    held.add(key);
    childMoveIds.push(r.id);
  }
  let movedDependents = 0;
  if (childMoveIds.length > 0) {
    const res = await tx.assetDependencyParent.updateMany({
      where: { id: { in: childMoveIds } },
      data: { parentAssetId: toAssetId },
    });
    movedDependents = res.count;
  }

  return { movedDependencyParents, replacedDependencyParents, movedDependents };
}

export interface AbsorbedRelationCounts extends SideTableTransferCounts, DependencyTransferCounts {
  movedSources: number;
  movedManagedAgent: boolean;
}

/**
 * Re-bind every transferable relation from `fromAssetId` onto `toAssetId`
 * inside the caller's transaction, so deleting the absorbed asset afterwards
 * doesn't cascade them away. Shared by the operator merge below and the
 * sibling-conflict ghost absorb in `acceptAssetConflict`.
 *
 *   - AssetSource — ALL rows re-point. No collision is possible:
 *     (sourceKind, externalId) is globally unique, so two distinct assets can
 *     never already hold the same source identity. This is what leaves the
 *     survivor multi-source instead of losing the absorbed asset's
 *     discovery provenance.
 *   - The four side tables — via `transferAssetSideTables` (delete-on-conflict,
 *     survivor's row wins).
 *   - ManagedAgent — 1:1 on assetId; re-bound only when the survivor has none,
 *     so the agent enrollment + its cert pins survive. If both sides have one,
 *     the absorbed asset's cascade-deletes (survivor keeps its own).
 *   - AssetDependencyParent — via `transferDependencyEdges` (dependents always
 *     re-point; the absorbed asset's own parent links blank-fill, with
 *     `dependencyWinner` deciding when both sides have parents).
 *
 * Everything NOT listed here cascade-deletes with the absorbed row (LLDP
 * neighbors, wireless stations, interface overrides, pending conflicts) and
 * the sample hypertables' rows orphan + age out — see the file header.
 */
export async function absorbAssetRelations(
  tx: any,
  fromAssetId: string,
  toAssetId: string,
  opts?: { dependencyWinner?: DependencyParentWinner },
): Promise<AbsorbedRelationCounts> {
  const srcRes = await tx.assetSource.updateMany({
    where: { assetId: fromAssetId },
    data: { assetId: toAssetId },
  });
  const side = await transferAssetSideTables(tx, fromAssetId, toAssetId);
  const deps = await transferDependencyEdges(
    tx,
    fromAssetId,
    toAssetId,
    opts?.dependencyWinner ?? "canonical",
  );

  const agents = await tx.managedAgent.findMany({
    where: { assetId: { in: [fromAssetId, toAssetId] } },
    select: { assetId: true },
  });
  let movedManagedAgent = false;
  const fromHasAgent = agents.some((a: any) => a.assetId === fromAssetId);
  const toHasAgent = agents.some((a: any) => a.assetId === toAssetId);
  if (fromHasAgent && !toHasAgent) {
    await tx.managedAgent.update({ where: { assetId: fromAssetId }, data: { assetId: toAssetId } });
    movedManagedAgent = true;
  }

  return { movedSources: srcRes.count, ...side, ...deps, movedManagedAgent };
}

/**
 * Resolve the `monitored` OR-carry onto `update`: monitoring is an explicit
 * operator choice, so absorbing a monitored asset must never silently stop
 * polling the device. Only the OFF→ON direction does work (both-monitored and
 * survivor-already-monitored are no-ops; an unmonitored ghost never turns the
 * survivor off). When the flip happens, the ghost's monitoring CONFIGURATION
 * rides along — see MONITOR_CONFIG_FIELDS / MONITOR_PIN_FIELDS.
 *
 * Business rule 10 still wins: `decommissioned`/`disabled` never monitors. The
 * db.ts extension clamps that only when the write stages `status`, which a
 * merge keeping the survivor's status doesn't — so the effective status is
 * resolved here (staged value first) and the carry-over skipped.
 *
 * Shared with `acceptAssetConflict`; both callers pass rows carrying at least
 * `monitored`, `status`, and the MONITOR_CARRY_SELECT fields.
 */
export function resolveMonitoringCarry(
  update: Record<string, unknown>,
  canonical: Record<string, any>,
  ghost: Record<string, any>,
): { carried: boolean; adopted: string[] } {
  const effectiveStatus = (update.status ?? canonical.status) as string | null;
  const statusBlocksMonitoring = effectiveStatus === "decommissioned" || effectiveStatus === "disabled";
  const carried = ghost.monitored === true && canonical.monitored !== true && !statusBlocksMonitoring;
  const adopted: string[] = [];
  if (!carried) return { carried, adopted };

  update.monitored = true;
  // Fresh state: the survivor has never been polled under this config and the
  // ghost's samples are orphaned by the merge, so a leftover monitorStatus
  // would assert history the survivor can't back. null renders as "unknown"
  // and the first probe (≤ one monitor tick) replaces it.
  update.monitorStatus = null;
  update.consecutiveFailures = 0;
  update.consecutiveSuccesses = 0;
  // Config the enabled monitoring needs in order to resolve a method. Ghost's
  // non-null wins; survivor keeps its own wherever the ghost has none.
  for (const field of MONITOR_CONFIG_FIELDS) {
    const gVal = ghost[field];
    if (gVal === null || gVal === undefined) continue;
    if (gVal === canonical[field]) continue;
    update[field] = gVal;
    adopted.push(field);
  }
  // Pins are additive intent — union, survivor's order first.
  for (const field of MONITOR_PIN_FIELDS) {
    const cArr = Array.isArray(canonical[field]) ? (canonical[field] as string[]) : [];
    const gArr = Array.isArray(ghost[field]) ? (ghost[field] as string[]) : [];
    const merged = [...cArr];
    const have = new Set(cArr);
    for (const v of gArr) {
      if (!have.has(v)) {
        merged.push(v);
        have.add(v);
      }
    }
    if (merged.length > cArr.length) {
      update[field] = merged;
      adopted.push(field);
    }
  }
  return { carried, adopted };
}

/**
 * Merge `ghostId` into `canonicalId`. The canonical survives; the ghost is
 * deleted. `fieldWinners` maps a MERGEABLE_FIELDS key to which side wins; any
 * field not present defaults to blank-fill (keep canonical, fill from ghost
 * only when the canonical's value is empty). `dependencyWinner` resolves the
 * upstream dependency-parent conflict when BOTH sides have parent links (see
 * transferDependencyEdges) — omitted, the canonical keeps its own.
 */
export async function mergeAssets(opts: {
  canonicalId: string;
  ghostId: string;
  fieldWinners?: Partial<Record<MergeableField, FieldWinner>>;
  dependencyWinner?: DependencyParentWinner;
}): Promise<MergeAssetsResult> {
  const { canonicalId, ghostId } = opts;
  const fieldWinners = opts.fieldWinners ?? {};

  if (canonicalId === ghostId) {
    throw new AppError(400, "Cannot merge an asset into itself");
  }

  const [canonical, ghost] = await Promise.all([
    prisma.asset.findUnique({ where: { id: canonicalId }, select: ASSET_SELECT }),
    prisma.asset.findUnique({ where: { id: ghostId }, select: ASSET_SELECT }),
  ]);
  if (!canonical) throw new AppError(404, "Survivor asset not found");
  if (!ghost) throw new AppError(404, "Absorbed asset not found");

  const c = canonical as unknown as AssetForMerge;
  const g = ghost as unknown as AssetForMerge;

  // Resolve the per-field update. Blank-fill default mirrors
  // mergeGhostIntoCanonical / acceptAssetConflict; an explicit "ghost" winner
  // overwrites (but never writes an empty value over a populated one).
  const update: Record<string, unknown> = {};
  const appliedFields: string[] = [];
  for (const field of MERGEABLE_FIELDS) {
    // Combined, not won — any winner the caller sent for these is ignored.
    if (CONCATENATED_FIELDS.includes(field)) continue;
    const cVal = c[field];
    const gVal = g[field];
    const cBlank = fieldIsEmpty(field, cVal);
    const gBlank = fieldIsEmpty(field, gVal);
    const winner: FieldWinner = fieldWinners[field] ?? (cBlank && !gBlank ? "ghost" : "canonical");
    // A ghost win writes only a value that beats the survivor's: never an
    // empty one, and for Type never the `other` catch-all over a specific type.
    if (winner === "ghost" && !isEmpty(gVal) && !(gBlank && !cBlank)) {
      update[field] = gVal;
      appliedFields.push(field);
    }
  }

  // notes — both rows' text, labeled by origin. See combineAssetNotes for why
  // this is a combine rather than a pick.
  const combinedNotes = combineAssetNotes(
    { notes: c.notes as string | null, hostname: c.hostname as string | null, id: canonicalId },
    { notes: g.notes as string | null, hostname: g.hostname as string | null, id: ghostId },
  );
  if (combinedNotes !== undefined) {
    update.notes = combinedNotes;
    appliedFields.push("notes");
  }

  // lastSeen — always keep the more recent so the survivor reflects the
  // ghost's sightings (provenance label travels with it). tags — always
  // union, preserving the canonical order.
  const ghostSeenMoreRecently = !!g.lastSeen && (!c.lastSeen || (g.lastSeen as Date) > (c.lastSeen as Date));
  if (ghostSeenMoreRecently) {
    update.lastSeen = g.lastSeen;
    if (g.lastSeenSource) update.lastSeenSource = g.lastSeenSource;
  }
  // lastSeenSwitch / lastSeenAp — system-learned connection facts (they also
  // re-derive the endpoint dependency edge via resolveEndpointParent), carried
  // with the same recency rule as lastSeen: blank-fill from the ghost, and
  // when both sides have a value the more recently seen record's fact wins.
  // Not winner-radio fields — there's no operator judgment to make about
  // which port a device was last sighted on.
  for (const field of ["lastSeenSwitch", "lastSeenAp"] as const) {
    const gVal = g[field];
    if (isEmpty(gVal)) continue;
    if (isEmpty(c[field]) || ghostSeenMoreRecently) {
      if (gVal !== c[field]) {
        update[field] = gVal;
        appliedFields.push(field);
      }
    }
  }
  const cTags = new Set(c.tags);
  const mergedTags = [...c.tags];
  for (const t of g.tags) {
    if (!cTags.has(t)) {
      mergedTags.push(t);
      cTags.add(t);
    }
  }
  if (mergedTags.length > c.tags.length) update.tags = mergedTags;

  // acquiredAt ≤ lastSeen invariant (also enforced by the db.ts write
  // extension, but we resolve it here so the value is correct in-transaction).
  clampAcquiredToLastSeen(update, { acquiredAt: c.acquiredAt, lastSeen: c.lastSeen });

  // monitored — OR across the two rows (+ the ghost's monitoring config when
  // the flip actually turns the survivor ON). Shared with the conflict path.
  const { carried: carriedMonitoring, adopted: monitorFieldsAdopted } =
    resolveMonitoringCarry(update, c, g);

  let movedSources = 0;
  let movedMacs = 0;
  let movedIps = 0;
  let movedIpHistory = 0;
  let movedSightings = 0;
  let movedManagedAgent = false;
  let movedDependencyParents = 0;
  let replacedDependencyParents = false;
  let movedDependents = 0;

  await prisma.$transaction(async (tx) => {
    // Sources / side tables / dependency edges / managed agent — re-bound onto
    // the canonical so the ghost delete below can't cascade them away. Shared
    // with the conflict-resolution ghost absorb.
    const absorbed = await absorbAssetRelations(tx, g.id, c.id, {
      dependencyWinner: opts.dependencyWinner,
    });
    movedSources = absorbed.movedSources;
    movedMacs = absorbed.movedMacs;
    movedIps = absorbed.movedIps;
    movedIpHistory = absorbed.movedIpHistory;
    movedSightings = absorbed.movedSightings;
    movedManagedAgent = absorbed.movedManagedAgent;
    movedDependencyParents = absorbed.movedDependencyParents;
    replacedDependencyParents = absorbed.replacedDependencyParents;
    movedDependents = absorbed.movedDependents;

    if (Object.keys(update).length > 0) {
      await tx.asset.update({ where: { id: c.id }, data: update });
    }

    // Delete the ghost. Everything still pointing at it cascade-deletes (see
    // the file header for the full list). Sources / MACs / IPs / sightings /
    // managed agent have already been moved off, so only the discarded
    // streams remain to cascade.
    await tx.asset.delete({ where: { id: g.id } });
  });

  // Keep monitorOverride faithful to the carried-over monitoring intent — the
  // same post-write hook the operator asset-write paths and the endpoint-ghost
  // merge use. Best-effort: a recompute failure must not undo the merge.
  if (carriedMonitoring) {
    try {
      await recomputeMonitorOverrideForAssets(prisma, [c.id]);
    } catch {
      /* swallowed — see above */
    }
  }

  return {
    survivorId: c.id,
    absorbedId: g.id,
    movedSources,
    movedMacs,
    movedIps,
    movedIpHistory,
    movedSightings,
    movedManagedAgent,
    appliedFields,
    carriedMonitoring,
    monitorFieldsAdopted,
    movedDependencyParents,
    replacedDependencyParents,
    movedDependents,
  };
}
