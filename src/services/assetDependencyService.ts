/**
 * src/services/assetDependencyService.ts — The asset Dependencies tab's server half: the dependency view (effective /
 * computed / override parents, children with grandchildren under caps, the HA
 * peer, active-alert summaries), setting and clearing an operator parent
 * override (self-reference, unknown-parent and cycle refusals; one transaction;
 * propagation), and the Dependency Test simulation. Moved out of
 * routes/assets/dependencies.ts (CQ-B062 slice 2); the route keeps the Zod
 * bodies and the gates. The suppression engine itself is dependencyTreeService.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { propagateAfterStatusChange, FORTINET_INFRA_ASSET_TYPES } from "./dependencyTreeService.js";
import { activeAlertSummaryByAsset } from "./notificationService.js";

// ─── GET /:id/dependencies phases (split 2026-08 — the contract tests in
// tests/integration/assetDependenciesContract.test.ts pin the override-wins
// rule, the per-child binding filter, the grandchild layer, the ordering,
// and the HA-peer block). The child and grandchild blocks were near-duplicate
// inline copies of the same binding-rule walk; they now share
// loadBoundChildRows.

// Payload caps for the asset-details tree, which feeds a modal. Both layers of
// the downward view are infra-only, so these bound a controller FortiGate with
// hundreds of managed switches and APs — not the endpoint half, which is
// filtered out of the children read entirely.
const DEP_INFRA_CHILD_CAP = 300;

const DEP_GRANDCHILD_CAP = 500;

// Stable display order: type (firewall→switch→ap→other), then hostname.
const DEP_TYPE_ORDER: Record<string, number> = { firewall: 1, switch: 2, access_point: 3 };

function byDepTypeThenHostname(a: { assetType: string; hostname: string | null }, b: { assetType: string; hostname: string | null }): number {
  const ta = DEP_TYPE_ORDER[a.assetType] ?? 99;
  const tb = DEP_TYPE_ORDER[b.assetType] ?? 99;
  if (ta !== tb) return ta - tb;
  return (a.hostname || "").localeCompare(b.hostname || "");
}

interface BoundChildRow {
  parentAssetId: string;
  id: string;
  hostname: string | null;
  // Serial + address ride every tree node so the renderer can tell two
  // same-named switches apart (business rule 91) — the hostname alone is not
  // an identity on a FortiLink fleet that names its switch-ids per site.
  serialNumber: string | null;
  ipAddress: string | null;
  assetType: string;
  dependencyLayer: number | null;
  monitorStatus: string | null;
  monitored: boolean;
  dependencySuppressed: boolean;
  dependencyTestUntil: Date | null;
  source: string;
  detectedVia: string | null;
}

/**
 * Every asset BOUND to one of `parentIds` as a dependency child. Binding
 * resolution per child: if the child has ANY override row, only its override
 * rows count; otherwise every NON-override row counts — the same rule
 * `loadEffectiveParents` applies in the reconciler. (It used to test
 * `source === "computed"` literally, which silently hid the two other
 * discovery-written sources from the tree: `vcenter` VM→host edges and, since
 * 2026-08, the `endpoint` half.) Rows come back in (source asc, createdAt asc)
 * order; callers own dedupe/grouping/sorting.
 *
 * `opts.assetTypes` narrows the child types and `opts.take` caps the read. Both
 * exist because the endpoint half made a FortiGate's child set fleet-sized — a
 * site gate is the last-seen device for every endpoint at the site, and the
 * asset-details tree is a summary of the infra chain, not a browsable inventory.
 * Note `take` applies BEFORE the per-child binding filter below, so a caller
 * wanting a specific slice must express it in the where.
 */
async function loadBoundChildRows(
  parentIds: string[],
  opts?: { assetTypes?: string[]; take?: number },
): Promise<BoundChildRow[]> {
  if (parentIds.length === 0) return [];
  const rows = await prisma.assetDependencyParent.findMany({
    where: {
      parentAssetId: { in: parentIds },
      ...(opts?.assetTypes ? { asset: { assetType: { in: opts.assetTypes } } } : {}),
    },
    ...(opts?.take ? { take: opts.take } : {}),
    include: {
      asset: {
        select: {
          id: true,
          hostname: true,
          serialNumber: true,
          ipAddress: true,
          assetType: true,
          dependencyLayer: true,
          monitorStatus: true,
          monitored: true,
          dependencySuppressed: true,
          dependencyTestUntil: true,
        },
      },
    },
    orderBy: [{ source: "asc" }, { createdAt: "asc" }],
  });
  const ids = [...new Set(rows.map((r) => r.assetId))];
  const overrideMap = new Map<string, boolean>();
  if (ids.length > 0) {
    const overrides = await prisma.assetDependencyParent.findMany({
      where: { assetId: { in: ids }, source: "override" },
      select: { assetId: true },
    });
    for (const r of overrides) overrideMap.set(r.assetId, true);
  }
  const out: BoundChildRow[] = [];
  for (const r of rows) {
    const childHasOverride = overrideMap.get(r.assetId) === true;
    const isBinding = childHasOverride ? r.source === "override" : r.source !== "override";
    if (!isBinding) continue;
    out.push({
      parentAssetId:        r.parentAssetId,
      id:                   r.asset.id,
      hostname:             r.asset.hostname,
      serialNumber:         r.asset.serialNumber,
      ipAddress:            r.asset.ipAddress,
      assetType:            r.asset.assetType,
      dependencyLayer:      r.asset.dependencyLayer,
      monitorStatus:        r.asset.monitorStatus,
      monitored:            r.asset.monitored,
      dependencySuppressed: r.asset.dependencySuppressed,
      dependencyTestUntil:  r.asset.dependencyTestUntil,
      source:               r.source,
      detectedVia:          r.detectedVia,
    });
  }
  return out;
}

/**
 * HA peer (firewalls only) — the other member of this asset's HA cluster,
 * resolved via the fortinetTopology.haPeerSerial stamp. The dependency DAG
 * deliberately has NO edge between HA members (both are layer-1 roots;
 * member↔member LLDP edges are same-layer and pruned), so without this the
 * tree panel can never show the cluster's second box. Display-only — it is
 * NOT a parent or child.
 */
async function loadDependencyHaPeer(asset: { assetType: string; fortinetTopology: unknown }) {
  const selfTopo = (asset.fortinetTopology as Record<string, unknown> | null) ?? null;
  const peerSerial = typeof selfTopo?.haPeerSerial === "string" ? selfTopo.haPeerSerial : null;
  if (asset.assetType !== "firewall" || !peerSerial) return null;
  const peer = await prisma.asset.findFirst({
    where: { serialNumber: { equals: peerSerial, mode: "insensitive" } },
    select: {
      id: true, hostname: true, serialNumber: true, ipAddress: true, assetType: true, dependencyLayer: true,
      monitorStatus: true, monitored: true, fortinetTopology: true,
    },
  });
  if (!peer) return null;
  const peerTopo = (peer.fortinetTopology as Record<string, unknown> | null) ?? null;
  return {
    id: peer.id,
    hostname: peer.hostname,
    serialNumber: peer.serialNumber,
    ipAddress: peer.ipAddress,
    assetType: peer.assetType,
    dependencyLayer: peer.dependencyLayer,
    monitorStatus: peer.monitorStatus,
    monitored: peer.monitored,
    haRole: typeof peerTopo?.haRole === "string" ? peerTopo.haRole : null,
  };
}

/**
 * GET /assets/:id/dependencies — the Dependencies tab: the asset, its effective /
 * computed / override parents, its children (with grandchildren, truncated),
 * child count, HA peer, each with its active-alert summary. 404 for an unknown asset.
 */
export async function getAssetDependencies(id: string) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: {
      id: true,
      hostname: true,
      serialNumber: true,
      ipAddress: true,
      assetType: true,
      monitorStatus: true,
      monitored: true,
      dependencyLayer: true,
      dependencySuppressed: true,
      dependencySuppressedAt: true,
      dependencyTestUntil: true,
      dependencyTestStartedBy: true,
      fortinetTopology: true,
    },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  const haPeer = await loadDependencyHaPeer(asset);

  const rows = await prisma.assetDependencyParent.findMany({
    where: { assetId: id },
    include: {
      parent: {
        select: {
          id: true,
          hostname: true,
          serialNumber: true,
          ipAddress: true,
          assetType: true,
          dependencyLayer: true,
          monitorStatus: true,
          monitored: true,
          dependencyTestUntil: true,
        },
      },
    },
    orderBy: [{ source: "asc" }, { createdAt: "asc" }],
  });

  function shape(r: (typeof rows)[number]) {
    return {
      id: r.id,
      parent: r.parent
        ? {
            id:                  r.parent.id,
            hostname:            r.parent.hostname,
            serialNumber:        r.parent.serialNumber,
            ipAddress:           r.parent.ipAddress,
            assetType:           r.parent.assetType,
            dependencyLayer:     r.parent.dependencyLayer,
            monitorStatus:       r.parent.monitorStatus,
            monitored:           r.parent.monitored,
            dependencyTestUntil: r.parent.dependencyTestUntil,
          }
        : null,
      source:      r.source,
      detectedVia: r.detectedVia,
    };
  }

  // Every non-override source is part of the computed set — `computed` (the
  // Fortinet infra half), `endpoint` (the leaf edge an endpoint hangs off its
  // last-seen switch / AP / FortiGate by) and `vcenter` (VM→ESXi placement).
  // Filtering on the literal "computed" hid the other two from the tree even
  // though the reconciler was suppressing on them.
  const computedParents = rows.filter(r => r.source !== "override").map(shape);
  const overrideParents = rows.filter(r => r.source === "override").map(shape);
  // When at least one override row exists, the override set is the effective
  // set (even if it ends up filtering down to the same parents as computed).
  const hasOverride = overrideParents.length > 0;
  const effectiveParents = hasOverride ? overrideParents : computedParents;

  // Direct children — every asset bound to THIS asset as an effective
  // parent (loadBoundChildRows applies the override-wins binding rule per
  // child). Dedupe by child id keeping the first binding row.
  //
  // **INFRA ONLY, both layers.** The endpoint half of the DAG made endpoints
  // children of the switch / AP / gate that last saw them, and briefly they
  // rendered here too — but the downward view exists to show the infra chain
  // (firewall → switch → AP), and a site gate is the last-seen device for
  // every workstation, printer and server at the site, so admitting them
  // buries the two or three rows an operator opened the tree to read. An
  // endpoint's dependency still shows on its OWN General tab, as the parent
  // above it, which is where the suppression it drives is worth explaining.
  // Type-filtered in SQL, not in memory: `take` applies before any in-memory
  // filter, so a gate with 300 switch children would otherwise fill the read
  // and report nothing.
  const boundInfraChildren = await loadBoundChildRows([id], {
    assetTypes: [...FORTINET_INFRA_ASSET_TYPES],
    take: DEP_INFRA_CHILD_CAP + 1,
  });
  const boundChildren = boundInfraChildren.slice(0, DEP_INFRA_CHILD_CAP);
  const childrenTruncated = boundInfraChildren.length > DEP_INFRA_CHILD_CAP;
  const seenChildIds = new Set<string>();
  const children: Array<Omit<BoundChildRow, "parentAssetId">> = [];
  for (const r of boundChildren) {
    if (seenChildIds.has(r.id)) continue; // dedupe if a child pins us via both computed AND override
    seenChildIds.add(r.id);
    const { parentAssetId: _p, ...child } = r;
    children.push(child);
  }
  children.sort(byDepTypeThenHostname);

  // One additional layer down (grandchildren) so the asset details modal can
  // render firewall → switch → AP without click-through. Same binding rule;
  // dedupe per (parentId, childId) so an MCLAG pair doesn't render twice
  // under one parent.
  //
  // INFRA-ONLY, which is exactly what this returned before the endpoint half
  // existed: a firewall's grandchildren are its switches' APs. Letting
  // endpoints in would multiply the payload by every endpoint on every switch
  // at the site for a row nobody reads two levels down.
  const grandchildrenByParent = new Map<string, Array<Omit<BoundChildRow, "parentAssetId">>>();
  const boundGrandchildren = await loadBoundChildRows(children.map(c => c.id), {
    assetTypes: [...FORTINET_INFRA_ASSET_TYPES],
    take: DEP_GRANDCHILD_CAP,
  });
  const seenGc = new Set<string>();
  for (const r of boundGrandchildren) {
    const dedupeKey = r.parentAssetId + "|" + r.id;
    if (seenGc.has(dedupeKey)) continue;
    seenGc.add(dedupeKey);
    const { parentAssetId, ...gc } = r;
    const list = grandchildrenByParent.get(parentAssetId) ?? [];
    list.push(gc);
    grandchildrenByParent.set(parentAssetId, list);
  }
  for (const list of grandchildrenByParent.values()) {
    list.sort(byDepTypeThenHostname);
  }

  // INFRA child count per rendered child + for this asset itself, so the tree
  // can say "+N more" instead of implying the capped list is everything.
  // Counting infra only is what keeps that hint consistent with what the tree
  // shows — a raw count would make "+312" on a switch row an endpoint tally,
  // which is precisely the noise the type filter above exists to remove.
  // Hence a findMany over the (indexed) parentAssetId with the relation type
  // filter rather than a groupBy, which can't filter on a relation field.
  const countScopeIds = [id, ...children.map(c => c.id)];
  const childCountRows = await prisma.assetDependencyParent.findMany({
    where: {
      parentAssetId: { in: countScopeIds },
      source: { not: "override" },
      asset: { assetType: { in: [...FORTINET_INFRA_ASSET_TYPES] } },
    },
    select: { parentAssetId: true, assetId: true },
  });
  const childCountByParent = new Map<string, number>();
  const countedPairs = new Set<string>();
  for (const r of childCountRows) {
    // A pair can carry rows under several sources; count the child once.
    const pair = r.parentAssetId + "|" + r.assetId;
    if (countedPairs.has(pair)) continue;
    countedPairs.add(pair);
    childCountByParent.set(r.parentAssetId, (childCountByParent.get(r.parentAssetId) ?? 0) + 1);
  }

  // Worst active alert per rendered node — the same {severity, count,
  // unacknowledged} summary the assets list's Name-column dot is built from,
  // so a device strobes the same colour in the tree as in the list. ONE query
  // over every id the tree shows (bounded by the two caps above, ~800 ids
  // worst case), not one per row.
  const treeIds = new Set<string>([id]);
  for (const p of effectiveParents) if (p.parent) treeIds.add(p.parent.id);
  if (haPeer) treeIds.add(haPeer.id);
  for (const c of children) treeIds.add(c.id);
  for (const list of grandchildrenByParent.values()) for (const gc of list) treeIds.add(gc.id);
  const alertSummaries = await activeAlertSummaryByAsset([...treeIds]);
  const alertOf = (assetId: string) => alertSummaries.get(assetId) ?? null;

  const childrenWithGrandchildren = children.map(c => ({
    ...c,
    activeAlert:   alertOf(c.id),
    grandchildren: (grandchildrenByParent.get(c.id) ?? []).map(gc => ({ ...gc, activeAlert: alertOf(gc.id) })),
    childCount:    childCountByParent.get(c.id) ?? 0,
  }));
  const withParentAlert = (p: ReturnType<typeof shape>) =>
    p.parent ? { ...p, parent: { ...p.parent, activeAlert: alertOf(p.parent.id) } } : p;

  return {
    asset: {
      id:                      asset.id,
      hostname:                asset.hostname,
      serialNumber:            asset.serialNumber,
      ipAddress:               asset.ipAddress,
      assetType:               asset.assetType,
      monitorStatus:           asset.monitorStatus,
      monitored:               asset.monitored,
      dependencyLayer:         asset.dependencyLayer,
      dependencySuppressed:    asset.dependencySuppressed,
      dependencySuppressedAt:  asset.dependencySuppressedAt,
      dependencyTestUntil:     asset.dependencyTestUntil,
      dependencyTestStartedBy: asset.dependencyTestStartedBy,
      activeAlert:             alertOf(asset.id),
    },
    effectiveParents: effectiveParents.map(withParentAlert),
    computedParents,
    overrideParents,
    hasOverride,
    children: childrenWithGrandchildren,
    childrenTruncated,
    childCount: childCountByParent.get(id) ?? 0,
    haPeer: haPeer ? { ...haPeer, activeAlert: alertOf(haPeer.id) } : null,
  };
}

/**
 * PUT /assets/:id/dependencies/override — replace the operator's parent set:
 * refuse self-reference, unknown parents and a cycle, then swap the override
 * edges in one transaction, propagate and log. 404 for an unknown asset.
 */
export async function setDependencyOverride(id: string, body: { parentAssetIds: string[] }) {
  const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
  if (!asset) throw new AppError(404, "Asset not found");

  const proposedParentIds = [...new Set(body.parentAssetIds)];

  // Reject self-reference up front.
  if (proposedParentIds.includes(id)) {
    throw new AppError(400, "An asset cannot be its own dependency parent");
  }

  // Validate every proposed parent exists and is a Fortinet infra asset
  // (firewall / switch / access_point) — anything else doesn't belong in the
  // dependency tree.
  if (proposedParentIds.length > 0) {
    const proposed = await prisma.asset.findMany({
      where: { id: { in: proposedParentIds } },
      select: { id: true, assetType: true, hostname: true },
    });
    if (proposed.length !== proposedParentIds.length) {
      throw new AppError(400, "One or more proposed parent assets not found");
    }
    const wrongType = proposed.filter(p => !["firewall", "switch", "access_point"].includes(p.assetType));
    if (wrongType.length > 0) {
      throw new AppError(
        400,
        `Dependency parents must be firewall/switch/access_point: ${wrongType.map(p => p.hostname || p.id).join(", ")}`,
      );
    }

    // Cycle check: from each proposed parent, walk UP through that parent's
    // existing effective parents. If we ever reach `id`, the override would
    // form a cycle.
    const allEdges = await prisma.assetDependencyParent.findMany({
      select: { assetId: true, parentAssetId: true, source: true },
    });
    // Bucket override vs computed; the asset whose parents we walk uses its
    // own override set when present, otherwise the computed set — same as
    // the runtime resolver.
    const overrideByChild = new Map<string, string[]>();
    const computedByChild = new Map<string, string[]>();
    for (const e of allEdges) {
      const m = e.source === "override" ? overrideByChild : computedByChild;
      const cur = m.get(e.assetId);
      if (cur) cur.push(e.parentAssetId);
      else m.set(e.assetId, [e.parentAssetId]);
    }
    function effectiveParentsOf(child: string): string[] {
      const o = overrideByChild.get(child);
      if (o) return o;
      return computedByChild.get(child) ?? [];
    }
    const visited = new Set<string>();
    const queue = [...proposedParentIds];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === id) {
        throw new AppError(400, "Proposed override would form a dependency cycle");
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      // Climb. NOTE: we walk current effective parents, treating this asset's
      // proposed override as not-yet-applied; since cur cannot equal `id`
      // (we just checked), we never need the proposed set itself in the walk.
      const climb = effectiveParentsOf(cur);
      for (const p of climb) queue.push(p);
    }
  }

  // Atomic replace: delete current override rows for this child, then insert
  // the new set. createMany skipDuplicates handles the case where one of the
  // proposed parents already shows up in the computed set.
  await prisma.$transaction(async (tx) => {
    await tx.assetDependencyParent.deleteMany({
      where: { assetId: id, source: "override" },
    });
    if (proposedParentIds.length > 0) {
      await tx.assetDependencyParent.createMany({
        data: proposedParentIds.map(parentId => ({
          assetId:       id,
          parentAssetId: parentId,
          source:        "override",
          detectedVia:   "manual",
        })),
        skipDuplicates: true,
      });
    }
  });

  logEvent({
    action:       "asset.dependency.override_set",
    resourceType: "asset",
    resourceId:   id,
    resourceName: asset.hostname || undefined,
    level:        "info",
    message:      `Dependency override set on ${asset.hostname || id} (${proposedParentIds.length} parent${proposedParentIds.length === 1 ? "" : "s"})`,
    details:      { parentAssetIds: proposedParentIds },
  });

  return { ok: true, parentAssetIds: proposedParentIds };
}

/** DELETE /assets/:id/dependencies/override — drop the override edges; computed parents apply again. */
export async function clearDependencyOverride(id: string) {
  const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
  if (!asset) throw new AppError(404, "Asset not found");

  const result = await prisma.assetDependencyParent.deleteMany({
    where: { assetId: id, source: "override" },
  });

  if (result.count > 0) {
    logEvent({
      action:       "asset.dependency.override_cleared",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      level:        "info",
      message:      `Dependency override cleared on ${asset.hostname || id} — computed parents now apply`,
      details:      { removed: result.count },
    });
  }

  return { ok: true, removed: result.count };
}

/**
 * POST /assets/:id/dependency-test — simulate this Fortinet infra asset down
 * for `durationMinutes` (400 for any other type), propagate and log.
 */
export async function startDependencyTest(id: string, durationMinutes: number, actor: string | undefined) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { id: true, hostname: true, assetType: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  // Only Fortinet infra assets sit in the dependency tree. Refusing the
  // call on workstations / printers / etc. surfaces the misconception
  // early instead of letting the operator wait for a no-op.
  if (!["firewall", "switch", "access_point"].includes(asset.assetType)) {
    throw new AppError(400, "Dependency Test only applies to firewall / switch / access_point assets");
  }

  const until = new Date(Date.now() + durationMinutes * 60_000);
  const startedBy = actor || "unknown";

  await prisma.asset.update({
    where: { id },
    data:  { dependencyTestUntil: until, dependencyTestStartedBy: startedBy },
  });

  // Fire the reconciler so children flip to dependencySuppressed within
  // this request rather than waiting up to 60 s for the next tick. Same
  // hook the probe-result path uses for genuine status changes.
  await propagateAfterStatusChange(id);

  logEvent({
    action:       "asset.dependency_test.started",
    resourceType: "asset",
    resourceId:   id,
    resourceName: asset.hostname || undefined,
    actor:        actor,
    level:        "info",
    message:      `Dependency Test started on ${asset.hostname || id} for ${durationMinutes} min (auto-expires ${until.toISOString()})`,
    details:      { durationMinutes, dependencyTestUntil: until },
  });

  return { ok: true, dependencyTestUntil: until, dependencyTestStartedBy: startedBy };
}

/** DELETE /assets/:id/dependency-test — end the simulation (idempotent), propagate and log. */
export async function clearDependencyTest(id: string, actor: string | undefined) {
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { id: true, hostname: true, dependencyTestUntil: true, dependencyTestStartedBy: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  if (!asset.dependencyTestUntil) {
    // Idempotent — already cleared. No event, no reconciler hit.
    return { ok: true, alreadyCleared: true };
  }

  await prisma.asset.update({
    where: { id },
    data:  { dependencyTestUntil: null, dependencyTestStartedBy: null },
  });
  await propagateAfterStatusChange(id);

  logEvent({
    action:       "asset.dependency_test.cleared",
    resourceType: "asset",
    resourceId:   id,
    resourceName: asset.hostname || undefined,
    actor:        actor,
    level:        "info",
    message:      `Dependency Test cleared on ${asset.hostname || id}`,
    details:      { startedBy: asset.dependencyTestStartedBy, scheduledUntil: asset.dependencyTestUntil },
  });

  return { ok: true };
}
