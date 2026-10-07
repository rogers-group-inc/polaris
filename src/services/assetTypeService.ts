/**
 * src/services/assetTypeService.ts
 *
 * CRUD + caching for the AssetTypeDef registry. The synchronous lookups live
 * in src/utils/assetTypes.ts so the Prisma extension in db.ts can validate
 * Asset.assetType writes without cycling through this service.
 *
 * Lifecycle:
 *   1. App boot calls refreshCache() once to populate the in-memory map.
 *   2. Every mutation (create / update / delete) re-runs refreshCache() so
 *      subsequent writes see the new state immediately.
 *   3. Built-in rows (seeded by the registry cutover migration with
 *      is_built_in=true AND is_protected=true) cannot be renamed or deleted.
 *      Code special-cases keyed on the literal names ("firewall", "switch",
 *      "access_point", etc.) remain stable across operator edits.
 *   4. Custom rows can be renamed in place. Renames are transactional:
 *      every Asset row holding the old name is rewritten to the new name in
 *      the same $transaction as the registry row update, so no Asset can
 *      hold a stale assetType value referencing a renamed type.
 *   5. Custom rows can be deleted only when no Asset.assetType row
 *      references them. Asset.assetType is a String (not a relation), so the
 *      service counts usage explicitly before issuing the delete.
 */

import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import {
  setAssetTypeRegistry,
  validateAssetTypeName,
  validateAssetTypeLabel,
  normalizeAssetTypeName,
  BUILT_IN_ASSET_TYPES,
} from "../utils/assetTypes.js";
import {
  setAssetTypeMatchRegistry,
  validateMatchRules,
  validateMatchContexts,
  normalizeMatchRules,
  explainAssetType,
  DEFAULT_TYPE_MATCHING,
  type MatchRules,
  type MatchRulesInput,
  type MatchableType,
  type MatchClause,
} from "../utils/assetTypeMatch.js";

export interface AssetTypeRow {
  id: string;
  name: string;
  label: string;
  description: string | null;
  isBuiltIn: boolean;
  isProtected: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Inference rules — a nested AND/OR condition tree; see
   * utils/assetTypeMatch.ts. Null = never inferred. Always the CURRENT shape
   * on the way out: `toRow` folds the legacy flat clause list forward, so no
   * reader has to know which shape the row was written in.
   */
  matchRules: MatchRules | null;
  /** Which inference contexts the rules run in ("directory" | "scan"). */
  matchContexts: string[];
  /** Evaluation order, ascending. */
  matchPriority: number;
  /** Live count of Assets currently using this type — included on list/get for UI use. */
  usageCount?: number;
}

/**
 * Prisma hands `matchRules` back as `JsonValue`. Normalize it at the service
 * boundary so nothing downstream — route, preview, resolver — has to think
 * about a blob that predates validation or was hand-edited in SQL.
 */
function toRow<T extends { matchRules: unknown }>(row: T): T & { matchRules: MatchRules | null } {
  return { ...row, matchRules: normalizeMatchRules(row.matchRules) };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function listAssetTypes(opts: { withUsage?: boolean } = {}): Promise<AssetTypeRow[]> {
  const rows = await prisma.assetTypeDef.findMany({
    orderBy: [{ isBuiltIn: "desc" }, { label: "asc" }],
  });
  if (!opts.withUsage) return rows.map(toRow);
  const counts = await prisma.asset.groupBy({
    by: ["assetType"],
    _count: { _all: true },
  });
  const byName = new Map(counts.map((c) => [c.assetType, c._count._all]));
  return rows.map((r) => ({ ...toRow(r), usageCount: byName.get(r.name) ?? 0 }));
}

export async function getAssetType(id: string): Promise<AssetTypeRow> {
  const row = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Asset type not found");
  const usage = await prisma.asset.count({ where: { assetType: row.name } });
  return { ...toRow(row), usageCount: usage };
}

// ─── Writes ────────────────────────────────────────────────────────────────

/** Shared write-time validation for the three matching columns. */
function assertMatchingValid(input: {
  matchRules?: unknown;
  matchContexts?: unknown;
  matchPriority?: unknown;
}): void {
  const rulesErr = validateMatchRules(input.matchRules);
  if (rulesErr) throw new AppError(400, rulesErr);
  const ctxErr = validateMatchContexts(input.matchContexts);
  if (ctxErr) throw new AppError(400, ctxErr);
  if (input.matchPriority !== undefined && input.matchPriority !== null) {
    const p = input.matchPriority;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 1000) {
      throw new AppError(400, "Match priority must be a whole number between 0 and 1000.");
    }
  }
}

export async function createAssetType(input: {
  name: string;
  label: string;
  description?: string | null;
  matchRules?: MatchRulesInput | null;
  matchContexts?: string[];
  matchPriority?: number;
  createdBy?: string | null;
}): Promise<AssetTypeRow> {
  const name = normalizeAssetTypeName(input.name);
  const nameError = validateAssetTypeName(input.name);
  if (nameError) throw new AppError(400, nameError);
  const labelError = validateAssetTypeLabel(input.label);
  if (labelError) throw new AppError(400, labelError);
  assertMatchingValid(input);
  const existing = await prisma.assetTypeDef.findUnique({ where: { name } });
  if (existing) throw new AppError(409, `Asset type "${name}" already exists`);
  const row = await prisma.assetTypeDef.create({
    data: {
      name,
      label: input.label.trim(),
      description: input.description?.trim() || null,
      isBuiltIn: false,
      isProtected: false,
      createdBy: input.createdBy ?? null,
      matchRules: (normalizeMatchRules(input.matchRules) ?? undefined) as never,
      matchContexts: input.matchContexts ?? [],
      ...(input.matchPriority !== undefined ? { matchPriority: input.matchPriority } : {}),
    },
  });
  await refreshCache();
  return toRow(row);
}

export async function updateAssetType(
  id: string,
  input: {
    name?: string;
    label?: string;
    description?: string | null;
    matchRules?: MatchRulesInput | null;
    matchContexts?: string[];
    matchPriority?: number;
  },
): Promise<AssetTypeRow> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");

  assertMatchingValid(input);

  // A built-in row's IDENTITY is immutable — rename, label and description
  // alike — because dashboards, tags and a long list of special-case branches
  // key on the literal names. Its MATCHING is not: which devices land in the
  // "printer" bucket is an operator's question about their own fleet, and
  // nothing in the codebase branches on how a device got there. So the guard
  // is scoped to the three identity columns rather than to the whole row.
  const identityEdit =
    (typeof input.name === "string" && input.name !== current.name) ||
    (typeof input.label === "string" && input.label !== current.label) ||
    (input.description !== undefined && (input.description?.trim() || null) !== current.description);
  if (current.isProtected && identityEdit) {
    throw new AppError(403, "Built-in asset types cannot be renamed or relabelled. Their matching rules can still be edited.");
  }

  const data: {
    name?: string;
    label?: string;
    description?: string | null;
    matchRules?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    matchContexts?: string[];
    matchPriority?: number;
  } = {};
  let nameChange: { from: string; to: string } | null = null;

  if (input.matchRules !== undefined) {
    // `null` clears the rules; Prisma needs DbNull rather than a JS null to
    // write a JSON column back to SQL NULL.
    const normalized = normalizeMatchRules(input.matchRules);
    // The cast is the standard Prisma JSON-column dance: `MatchRules` is a
    // named interface, and `InputJsonObject` wants an index signature.
    data.matchRules = normalized === null
      ? Prisma.DbNull
      : (normalized as unknown as Prisma.InputJsonValue);
  }
  if (input.matchContexts !== undefined) data.matchContexts = input.matchContexts;
  if (input.matchPriority !== undefined) data.matchPriority = input.matchPriority;

  if (typeof input.name === "string" && input.name !== current.name) {
    const next = normalizeAssetTypeName(input.name);
    const err = validateAssetTypeName(input.name);
    if (err) throw new AppError(400, err);
    const collision = await prisma.assetTypeDef.findUnique({ where: { name: next } });
    if (collision && collision.id !== id) throw new AppError(409, `Asset type "${next}" already exists`);
    data.name = next;
    nameChange = { from: current.name, to: next };
  }

  if (typeof input.label === "string") {
    const err = validateAssetTypeLabel(input.label);
    if (err) throw new AppError(400, err);
    data.label = input.label.trim();
  }

  if (input.description !== undefined) {
    const desc = input.description?.trim() ?? "";
    data.description = desc ? desc : null;
  }

  if (Object.keys(data).length === 0) {
    return toRow(current);
  }

  // The raw Prisma row — `toRow` narrows `matchRules` on the way out.
  let row: Omit<AssetTypeRow, "matchRules"> & { matchRules: unknown };
  if (nameChange) {
    // Rename in a single transaction: rewrite every Asset row holding the old
    // name to the new name FIRST, then update the registry row. If the Asset
    // rewrite fails for any reason the registry stays unchanged and the
    // cache stays consistent.
    [, row] = await prisma.$transaction([
      prisma.asset.updateMany({
        where: { assetType: nameChange.from },
        data: { assetType: nameChange.to },
      }),
      prisma.assetTypeDef.update({ where: { id }, data }),
    ]);
  } else {
    row = await prisma.assetTypeDef.update({ where: { id }, data });
  }
  await refreshCache();
  return toRow(row);
}

export async function deleteAssetType(id: string): Promise<void> {
  const current = await prisma.assetTypeDef.findUnique({ where: { id } });
  if (!current) throw new AppError(404, "Asset type not found");
  if (current.isProtected) {
    throw new AppError(403, "Built-in asset types cannot be deleted.");
  }
  const inUse = await prisma.asset.count({ where: { assetType: current.name } });
  if (inUse > 0) {
    throw new AppError(409, `Cannot delete asset type "${current.name}" — ${inUse} asset(s) still reference it. Reassign or delete those assets first.`);
  }
  await prisma.assetTypeDef.delete({ where: { id } });
  await refreshCache();
}

// ─── Cache + lifecycle ─────────────────────────────────────────────────────

/**
 * Reload the in-memory cache from the DB. Called at boot (after the
 * registry migration has had a chance to seed) and after every CRUD
 * mutation. Synchronous validation in src/utils/assetTypes.ts reads this
 * cache; the Prisma extension in db.ts uses it to reject Asset.assetType
 * writes pointing at a non-existent registry name.
 */
export async function refreshCache(): Promise<void> {
  const rows = await prisma.assetTypeDef.findMany({
    select: {
      name: true, label: true, isBuiltIn: true,
      matchRules: true, matchContexts: true, matchPriority: true,
    },
  });
  setAssetTypeRegistry(rows);
  // The matching half rides the SAME refresh, deliberately. A rule edit that
  // reached the DB but not the resolver would leave discovery typing devices
  // by the previous rules with no surface saying so — the two caches must
  // never be separately warm.
  setAssetTypeMatchRegistry(
    rows.map((r) => ({
      name: r.name,
      matchRules: normalizeMatchRules(r.matchRules),
      matchContexts: r.matchContexts,
      matchPriority: r.matchPriority,
    })),
  );
}

/**
 * Idempotent seed for the built-in types (eight historical + the vCenter
 * `hypervisor` type added by migration 20260709000000; its `virtual_machine`
 * sibling was retired by 20260722000000). The registry migrations are the
 * authoritative seed path; this helper exists so a manual
 * `npx prisma migrate reset` or a Docker volume nuke doesn't leave the
 * registry empty while the cache is being warmed. Safe to call on every
 * boot — existing rows are left untouched.
 */
const BUILT_IN_SEEDS: ReadonlyArray<{ name: string; label: string; description: string }> = [
  { name: "server",       label: "Server",       description: "Physical or virtual host running server workloads." },
  { name: "switch",       label: "Switch",       description: "Managed Layer-2/3 switch (FortiSwitch and other vendors)." },
  { name: "router",       label: "Router",       description: "Routing appliance (non-firewall)." },
  { name: "firewall",     label: "Firewall",     description: "Perimeter / branch firewall. FortiGates land here." },
  { name: "workstation",  label: "Workstation",  description: "Desktop / laptop endpoint." },
  { name: "printer",      label: "Printer",      description: "Network printer / multi-function device." },
  { name: "access_point", label: "Access Point", description: "Wireless access point (FortiAPs and other vendors)." },
  { name: "other",        label: "Other",        description: "Default bucket for assets that do not fit the built-in categories." },
  // vCenter VMs are typed "server" (the virtual_machine built-in was retired
  // by migration 20260722000000 — keep it out of this self-heal list or it
  // comes back on the next boot); only the ESXi host type remains.
  { name: "hypervisor",   label: "Hypervisor",   description: "Virtualization host (ESXi). Parents its VMs in the dependency tree; datastores render on its details view." },
  { name: "kubernetes_cluster", label: "Kubernetes Cluster", description: "Azure Arc-enabled Kubernetes cluster. Discovered as a single asset; it runs no Polaris Agent and reports no interfaces or storage." },
  { name: "container",    label: "Container",    description: "Docker container (Unraid) or App (TrueNAS SCALE). Parented by its host in the dependency tree; it runs no Polaris Agent." },
];

export async function seedBuiltInAssetTypes(): Promise<{ inserted: number }> {
  // Defense-in-depth in case the migration's INSERT was skipped (e.g. fresh
  // shadow database during prisma migrate dev or operator-restored backup).
  let inserted = 0;
  for (const seed of BUILT_IN_SEEDS) {
    if (!(BUILT_IN_ASSET_TYPES as readonly string[]).includes(seed.name)) continue;
    const existing = await prisma.assetTypeDef.findUnique({ where: { name: seed.name } });
    if (existing) continue;
    // Only a row this self-heal CREATES gets the shipped matching. An
    // existing row's rules are the operator's, even when they are empty —
    // re-stamping a default over a deliberately cleared rule set is how a
    // boot job silently un-does a configuration change.
    const matching = DEFAULT_TYPE_MATCHING[seed.name];
    await prisma.assetTypeDef.create({
      data: {
        name: seed.name,
        label: seed.label,
        description: seed.description,
        isBuiltIn: true,
        isProtected: true,
        ...(matching
          ? {
              matchRules: matching.rules as never,
              matchContexts: matching.contexts,
              matchPriority: matching.priority,
            }
          : {}),
      },
    });
    inserted++;
  }
  return { inserted };
}

// ─── Preview + apply against existing inventory ────────────────────────────
//
// Rules decide what discovery does NEXT time it sees a device. That is the
// right default — re-typing inventory behind an operator's back on every save
// would make an experiment expensive to undo — but it leaves an operator
// unable to tell whether the rule they just wrote does anything. Preview
// answers that; apply is the explicit second step.

/** One asset a preview would re-type, with the clause that claimed it. */
export interface MatchPreviewRow {
  id: string;
  hostname: string | null;
  os: string | null;
  manufacturer: string | null;
  model: string | null;
  currentType: string;
  matchedType: string;
  matchedClause: MatchClause | null;
}

export interface MatchPreviewResult {
  /** Assets examined — those sitting in `other`. */
  examined: number;
  /** How many a rule would claim. */
  matched: number;
  /** Per-target-type totals, for the summary line. */
  byType: { type: string; count: number }[];
  /** A bounded sample for the table. */
  sample: MatchPreviewRow[];
  /** True when `matched` exceeds what `sample` carries. */
  truncated: boolean;
}

const PREVIEW_SAMPLE_CAP = 100;

/** The registry, shaped for the resolver. */
async function loadMatchableTypes(): Promise<MatchableType[]> {
  const stored = await prisma.assetTypeDef.findMany({
    select: { name: true, matchRules: true, matchContexts: true, matchPriority: true },
  });
  return stored.map((r) => ({
    name: r.name,
    matchRules: normalizeMatchRules(r.matchRules),
    matchContexts: r.matchContexts,
    matchPriority: r.matchPriority,
  }));
}

/** The assets a rule is allowed to claim — see `previewMatchRules`. */
function eligibleAssets() {
  return prisma.asset.findMany({
    where: { assetType: "other" },
    // Every FACT a stored asset can supply, so a rule on any offered field
    // previews against the same input the resolver would get. `chassis` is
    // the one match field with no Asset column — it exists only on an
    // Entra/Intune record mid-sync — so a rule using it previews as no-match.
    select: {
      id: true, hostname: true, os: true, osVersion: true,
      manufacturer: true, model: true,
    },
  });
}

/** The facts a stored asset offers the resolver. One place, so preview and
 *  apply cannot disagree about what a rule was tested against. */
function factsOf(a: {
  hostname: string | null; os: string | null; osVersion: string | null;
  manufacturer: string | null; model: string | null;
}) {
  return {
    os: a.os, osVersion: a.osVersion, hostname: a.hostname,
    manufacturer: a.manufacturer, model: a.model,
  };
}

/**
 * Which assets a rule set would claim.
 *
 * Scoped to assets currently typed `other`, which is not a UI convenience —
 * it is the same guard the discovery engine has always applied before
 * re-typing an existing asset. A rule must never be able to move a device out
 * of a bucket an authoritative source or an operator put it in; keeping the
 * scope here means preview, apply and discovery cannot disagree about what is
 * eligible.
 *
 * Reads the `directory` context: these are stored assets with a projected OS
 * string, which is the question directory inference asks. A scan hit has no
 * Asset row yet, so the `scan` context has nothing to preview against.
 *
 * Scale: ONE findMany with a tight select over the `other` bucket, evaluated
 * in memory. At 2000 assets the eligible slice is a fraction of the fleet and
 * five columns wide.
 */
export async function previewMatchRules(
  draft?: { name: string; matchRules: MatchRulesInput | null; matchContexts: string[]; matchPriority: number },
): Promise<MatchPreviewResult> {
  let types = await loadMatchableTypes();

  // An unsaved draft is previewed by substituting it INTO the live registry
  // rather than being evaluated alone: a clause only matters relative to the
  // types that outrank it, so a draft judged in isolation over-reports every
  // device a higher-priority type would have claimed first.
  if (draft) {
    const err = validateMatchRules(draft.matchRules);
    if (err) throw new AppError(400, err);
    types = types.filter((t) => t.name !== draft.name).concat({
      name: draft.name,
      matchRules: normalizeMatchRules(draft.matchRules),
      matchContexts: draft.matchContexts,
      matchPriority: draft.matchPriority,
    });
  }

  const assets = await eligibleAssets();
  const byType = new Map<string, number>();
  const sample: MatchPreviewRow[] = [];
  let matched = 0;

  for (const a of assets) {
    const { type, clause } = explainAssetType(types, factsOf(a), "directory");
    if (!type || type === "other") continue;
    matched++;
    byType.set(type, (byType.get(type) ?? 0) + 1);
    if (sample.length < PREVIEW_SAMPLE_CAP) {
      sample.push({
        id: a.id,
        hostname: a.hostname,
        os: a.os,
        manufacturer: a.manufacturer,
        model: a.model,
        currentType: "other",
        matchedType: type,
        matchedClause: clause,
      });
    }
  }

  return {
    examined: assets.length,
    matched,
    byType: [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    sample,
    truncated: matched > sample.length,
  };
}

/**
 * Re-type the assets the rules claim.
 *
 * Deliberately an explicit operator action with its own Event rather than a
 * side effect of saving a rule, and bounded to the `other` bucket for the
 * reason `previewMatchRules` documents.
 *
 * Scale: one `updateMany` per TARGET TYPE inside a single transaction —
 * bounded by the size of the registry (~10-15 rows), not by the fleet. A
 * per-asset update loop here would be one round trip per device on a button
 * press.
 */
export async function applyMatchRules(): Promise<{
  updated: number;
  byType: { type: string; count: number }[];
}> {
  const types = await loadMatchableTypes();
  const assets = await eligibleAssets();

  const idsByType = new Map<string, string[]>();
  for (const a of assets) {
    const { type } = explainAssetType(types, factsOf(a), "directory");
    if (!type || type === "other") continue;
    const list = idsByType.get(type);
    if (list) list.push(a.id);
    else idsByType.set(type, [a.id]);
  }
  if (idsByType.size === 0) return { updated: 0, byType: [] };

  const targets = [...idsByType.entries()];
  const results = await prisma.$transaction(
    targets.map(([type, ids]) =>
      prisma.asset.updateMany({
        // Re-assert `assetType: "other"` in the WHERE, not just the id set:
        // the read and the write are not one transaction, so a discovery run
        // or another operator may have typed one of these rows in between.
        // The narrowed WHERE turns that race into a no-op instead of a
        // clobber, and the returned count then reports what actually moved.
        where: { id: { in: ids }, assetType: "other" },
        data: { assetType: type },
      }),
    ),
  );

  const byType = targets
    .map(([type], i) => ({ type, count: results[i]?.count ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return { updated: byType.reduce((sum, r) => sum + r.count, 0), byType };
}
