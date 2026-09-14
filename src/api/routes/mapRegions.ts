/**
 * src/api/routes/mapRegions.ts
 *
 * CRUD for operator-drawn map regions. /map/regions is mounted with the
 * `mapRegions=read` gate (router.ts), so any role with mapRegions read or
 * higher can list them; per-route writes below escalate to mapRegions=write.
 * The read-time access exists so callers that need to *consume* the region
 * registry (e.g. the user/role region-tag picker) can do so without holding
 * the write capability.
 *
 * The GET serves the DECORATED projection (each region plus its derived
 * `level` / `depth` / `parentId` / `childIds` / `ancestorIds`), which is purely
 * additive for existing consumers.
 *
 * Every write additionally records what the edit did to OTHER regions' levels
 * (`region.levels_shifted`). Levels are derived from nesting, so drawing one
 * polygon around two existing regions re-levels an ancestor chain and changes
 * who alert routing reaches for regions nobody touched — see `logLevelShifts`.
 */

import { Router } from "express";
import { z } from "zod";
import * as service from "../../services/mapRegionService.js";
import { logEvent } from "./events.js";
import {
  renameRegionInPrincipalScopes,
  principalsScopedToRegion,
  type PrincipalScopeMoves,
} from "../../services/regionScopeService.js";
// The rename rewrites User/Role/GroupMapping region tags, which is exactly the
// index notificationRecipientService caches for 30s — bumped from here because
// that module imports regionScopeService and could not import it back.
import { bumpRecipientIndex } from "../../services/notificationRecipientService.js";
import { requirePermission } from "../middleware/permissions.js";

const router = Router();

/**
 * "Nothing was touched" — the summary a rename reports when its tag half threw.
 * The Event still has to be written (that is the whole point of surviving the
 * throw), and it must not claim work that did not happen.
 */
function noTagsTouched(regionId: string): service.ReconcileSummary {
  return {
    regionId,
    added: 0,
    removed: 0,
    assetsTouched: 0,
    subnetsAdded: 0,
    subnetsRemoved: 0,
    subnetsTouched: 0,
  };
}

/** Error → a string safe to put in Event details. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One phrasing for the reconcile Event, shared by the create + update paths.
 * Region tags land on assets AND on the subnets an enclosed gate serves, so the
 * message has to name both — an edit can touch only networks.
 */
function reconcileMessage(summary: service.ReconcileSummary): string {
  const assets = `${summary.assetsTouched} asset${summary.assetsTouched === 1 ? "" : "s"}`;
  const nets = `${summary.subnetsTouched} network${summary.subnetsTouched === 1 ? "" : "s"}`;
  return (
    `Region tags reconciled: assets +${summary.added} / -${summary.removed} (${assets} touched), ` +
    `networks +${summary.subnetsAdded} / -${summary.subnetsRemoved} (${nets} touched)`
  );
}

/**
 * One line naming which principals a region-name change moved (or stranded).
 * Names, not just counts: "3 users" tells an admin nothing they can act on,
 * and region scope decides who sees which sites and who gets paged.
 */
function scopeMovesMessage(m: PrincipalScopeMoves): string {
  // Capped, because the message renders in the Events list and a fleet-wide
  // region can be on hundreds of accounts. The Event `details` carry the
  // complete lists.
  const NAMED = 10;
  const list = (label: string, names: string[]): string | null => {
    if (names.length === 0) return null;
    const shown = names.slice(0, NAMED).join(", ");
    const rest = names.length - NAMED;
    return `${label} ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
  };
  return [list("users", m.users), list("roles", m.roles), list("group mappings", m.groupMappings)]
    .filter(Boolean)
    .join("; ");
}

/** The derived nesting facts for one region, for an Event's `details`. */
async function levelDetails(regionId: string): Promise<{ level: number | null; depth: number | null; parentName: string | null }> {
  const { regions, hierarchy } = await service.getRegionHierarchy();
  const node = hierarchy.byId[regionId];
  if (!node) return { level: null, depth: null, parentName: null };
  const parent = node.parentId ? regions.find((r) => r.id === node.parentId) : null;
  return { level: node.level, depth: node.depth, parentName: parent?.name ?? null };
}

/**
 * Record every OTHER region whose derived level moved because of this edit.
 *
 * This is the most operationally important line in the levels feature: drawing
 * a polygon around two existing regions promotes it and can re-level an entire
 * ancestor chain, which changes who alert routing reaches for regions the
 * operator never touched. Without this Event that change leaves no trace.
 *
 * The edited region is excluded — its own level is already reported in its
 * region.created / region.updated / region.deleted details, and repeating it
 * here would read as collateral damage from its own edit.
 */
async function logLevelShifts(
  before: import("../../utils/regionHierarchy.js").RegionHierarchy,
  editedId: string,
  actor: string | undefined,
): Promise<void> {
  const { regions, hierarchy: after } = await service.getRegionHierarchy();
  const shifts = service.diffRegionLevels(before, after).filter((s) => s.regionId !== editedId);
  if (shifts.length === 0) return;
  const nameById = new Map(regions.map((r) => [r.id, r.name]));
  const described = shifts.map((s) => ({ ...s, name: nameById.get(s.regionId) ?? null }));
  logEvent({
    action: "region.levels_shifted",
    resourceType: "map-region",
    resourceId: editedId,
    actor,
    level: "info",
    message:
      `Nesting levels changed for ${shifts.length} other region${shifts.length === 1 ? "" : "s"}: ` +
      described
        .slice(0, 5)
        .map((s) => `${s.name ?? s.regionId} L${s.from ?? "-"}→L${s.to ?? "-"}`)
        .join(", ") +
      (shifts.length > 5 ? `, +${shifts.length - 5} more` : ""),
    details: { shifts: described },
  });
}

const PolygonSchema = z
  .array(z.tuple([z.number(), z.number()]))
  .min(3, "Polygon must have at least 3 vertices")
  .max(1000, "Polygon cannot have more than 1000 vertices");

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex string like "#4fc3f7"');

const CreateRegionSchema = z.object({
  name: z.string().min(1, "Region name is required").max(64),
  polygon: PolygonSchema,
  color: HexColorSchema.optional(),
});

const UpdateRegionSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  polygon: PolygonSchema.optional(),
  color: HexColorSchema.optional(),
});

// GET /map/regions
// Serves the DECORATED projection — each region additionally carries its
// derived `level` / `depth` / `parentId` / `childIds` / `ancestorIds`. Purely
// additive, so region-pills.js (name + color) and the map's edit mode (polygons)
// are unaffected.
router.get("/", async (_req, res, next) => {
  try {
    res.json(await service.listRegionsWithLevels());
  } catch (err) {
    next(err);
  }
});

// POST /map/regions
router.post("/", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const input = CreateRegionSchema.parse(req.body);
    // Captured BEFORE the write: a new polygon drawn around existing regions
    // promotes itself and re-levels everything above it.
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const created = await service.createRegion({
      name: input.name,
      polygon: input.polygon,
      color: input.color,
      actor: req.session?.username ?? null,
    });
    const summary = await service.applyOneRegion(created);
    const levels = await levelDetails(created.id);
    logEvent({
      action: "region.created",
      resourceType: "map-region",
      resourceId: created.id,
      resourceName: created.name,
      actor: req.session?.username,
      message:
        `Map region "${created.name}" created at level ${levels.level ?? 1} (${summary.added} asset${summary.added === 1 ? "" : "s"}, ` +
        `${summary.subnetsAdded} network${summary.subnetsAdded === 1 ? "" : "s"} tagged)`,
      details: {
        vertices: created.polygon.length,
        added: summary.added,
        subnetsAdded: summary.subnetsAdded,
        ...levels,
      },
    });
    await logLevelShifts(beforeLevels, created.id, req.session?.username);
    if (summary.added > 0 || summary.subnetsAdded > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: created.id,
        resourceName: created.name,
        message: reconcileMessage(summary),
        details: summary,
      });
    }
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// POST /map/regions/reconcile
// The Device Map's "Save Regions" review. Every save click — even one with no
// polygon edits — runs the full provenance-bounded reconcile over every region
// PLUS the geometry-authoritative gate pass: a pinned FortiGate loses any
// `region:<name>` tag whose polygon no longer contains it, provenance row or
// not (the only path that cleans gate tags predating the provenance table —
// see reviewRegionTagsForMapSave). Same write gate as the polygon saves it
// rides along with.
router.post("/reconcile", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const summary = await service.reviewRegionTagsForMapSave();
    if (summary.assetsTouched > 0 || summary.subnetsTouched > 0 || summary.firewallTagsStripped > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        actor: req.session?.username,
        message:
          `Map save review — ${reconcileMessage(summary)}` +
          (summary.firewallTagsStripped > 0
            ? `; ${summary.firewallTagsStripped} out-of-region gate tag${summary.firewallTagsStripped === 1 ? "" : "s"} stripped`
            : ""),
        details: summary,
      });
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// PUT /map/regions/:id
router.put("/:id", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateRegionSchema.parse(req.body);
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const result = await service.updateRegion(id, input);
    let summary: service.ReconcileSummary;
    // A rename carries the principal scope columns with it. Without this the
    // region tag on every scoped user, role and IdP group mapping keeps the OLD
    // name, matches no region, and silently stops scoping anything — see
    // `renameRegionInPrincipalScopes`.
    let scopeMoves: PrincipalScopeMoves | null = null;
    if (result.renamed) {
      // `updateRegion` has ALREADY committed the renamed blob inside its own
      // locked transaction, so everything from here down runs past the point of
      // no return: a throw leaves the region carrying its new name while assets,
      // subnets and the RBAC scope columns still read the old one — and, because
      // the route threw before ever reaching logEvent, with no record that it
      // happened. Prod hit exactly that twice in 2026-09 (1,492 asset tags and
      // 114 subnet tags stranded under two dead names, cleaned up by hand in
      // SQL). The tag mutators are chunked now so the original trigger is gone;
      // these two defences are for the next cause:
      //
      //   1. **The scope half goes first.** It is a handful of rows against the
      //      tag rotation's thousands, and it is the half with the access
      //      consequence — a User / Role / GroupMapping still naming the old
      //      region scopes NOTHING, and does it silently (see the mapRegionService
      //      entry in polaris-change-impact, invariant 31).
      //   2. **The halves are independent.** One failing must not skip the other,
      //      and whatever did not land is named in an Event before the error
      //      propagates, so the state is diagnosable without reading Postgres.
      let scopeErr: unknown = null;
      let tagErr: unknown = null;
      try {
        scopeMoves = await renameRegionInPrincipalScopes(result.previousName, result.region.name);
        if (scopeMoves.total > 0) bumpRecipientIndex();
      } catch (err) {
        scopeErr = err;
      }
      try {
        summary = await service.applyRename(result.region, result.previousName);
      } catch (err) {
        tagErr = err;
        summary = noTagsTouched(result.region.id);
      }
      if (scopeErr || tagErr) {
        const stranded = [
          tagErr ? `assets and networks may still carry "region:${result.previousName}"` : null,
          scopeErr ? `region scope assignments may still name "${result.previousName}"` : null,
        ].filter(Boolean);
        // AWAITED, unlike every other logEvent in this file: this one is the
        // only record that the rename half-applied, and it is written on the
        // path that is about to throw. `logEvent` swallows its own errors, so
        // awaiting it cannot turn a partial rename into a lost one.
        await logEvent({
          action: "region.rename_incomplete",
          resourceType: "map-region",
          resourceId: result.region.id,
          resourceName: result.region.name,
          actor: req.session?.username,
          level: "error",
          message:
            `Map region was renamed "${result.previousName}" → "${result.region.name}" but the rename did not finish: ` +
            stranded.join("; ") +
            ". A tag naming no current region is invisible to every reconcile — it needs cleaning up explicitly.",
          details: {
            previousName: result.previousName,
            newName: result.region.name,
            tagRotation: tagErr ? errorText(tagErr) : "ok",
            scopeRotation: scopeErr ? errorText(scopeErr) : "ok",
          },
        });
        throw tagErr ?? scopeErr;
      }
    } else {
      summary = await service.applyOneRegion(result.region);
    }
    logEvent({
      action: "region.updated",
      resourceType: "map-region",
      resourceId: result.region.id,
      resourceName: result.region.name,
      actor: req.session?.username,
      message: result.renamed
        ? `Map region renamed "${result.previousName}" → "${result.region.name}"`
        : `Map region "${result.region.name}" updated${result.polygonChanged ? " (polygon edited)" : ""}`,
      details: {
        previousName: result.previousName,
        renamed: result.renamed,
        polygonChanged: result.polygonChanged,
        vertices: result.region.polygon.length,
        ...(await levelDetails(result.region.id)),
        ...summary,
        ...(scopeMoves ? { scopedPrincipalsMoved: scopeMoves.total } : {}),
      },
    });
    if (scopeMoves && scopeMoves.total > 0) {
      // Its own Event because it is an ACCESS change, not a tagging one: these
      // rows decide which sites a scoped operator sees and who alerts route to.
      logEvent({
        action: "region.scope_tags_renamed",
        resourceType: "map-region",
        resourceId: result.region.id,
        resourceName: result.region.name,
        actor: req.session?.username,
        message:
          `Region scope assignments followed the rename "${result.previousName}" → "${result.region.name}": ` +
          scopeMovesMessage(scopeMoves),
        details: { previousName: result.previousName, ...scopeMoves },
      });
    }
    await logLevelShifts(beforeLevels, result.region.id, req.session?.username);
    if (summary.assetsTouched > 0 || summary.subnetsTouched > 0) {
      logEvent({
        action: "region.tags_reconciled",
        resourceType: "map-region",
        resourceId: result.region.id,
        resourceName: result.region.name,
        message: reconcileMessage(summary),
        details: summary,
      });
    }
    res.json(result.region);
  } catch (err) {
    next(err);
  }
});

// DELETE /map/regions/:id
router.delete("/:id", requirePermission("mapRegions", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    // Deleting a container demotes everything that was inside it.
    const { hierarchy: beforeLevels } = await service.getRegionHierarchy();
    const removed = await service.deleteRegion(id);
    const summary = await service.applyDelete(removed);
    // Deliberately a REPORT, not a strip: there is no new name to move these to,
    // and a region is often redrawn under the same name — so the assignment is
    // left in place (the Users page renders it as removable) and the operators
    // now holding a tag that matches no region are named here instead.
    const stranded = await principalsScopedToRegion(removed.name);
    logEvent({
      action: "region.deleted",
      resourceType: "map-region",
      resourceId: removed.id,
      resourceName: removed.name,
      actor: req.session?.username,
      message:
        `Map region "${removed.name}" deleted (${summary.removed} asset${summary.removed === 1 ? "" : "s"}, ` +
        `${summary.subnetsRemoved} network${summary.subnetsRemoved === 1 ? "" : "s"} untagged)`,
      details: { ...summary, scopedPrincipalsStranded: stranded.total },
    });
    if (stranded.total > 0) {
      logEvent({
        action: "region.scope_tags_stranded",
        resourceType: "map-region",
        resourceId: removed.id,
        resourceName: removed.name,
        actor: req.session?.username,
        level: "warning",
        message:
          `Region "${removed.name}" was deleted while still assigned as scope to ` +
          scopeMovesMessage(stranded) + " — those assignments now match no region",
        details: { ...stranded },
      });
    }
    await logLevelShifts(beforeLevels, removed.id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
