/**
 * src/api/routes/tags.ts — the tag registry.
 *
 * Mounted at /api/v1/server-settings/tags (the URL the pickers, the Users page
 * and Server Settings -> Identification have always called), BEFORE the
 * blanket `serverSettingsSystem=read` floor on /server-settings, so it rides
 * its own key: `tags` (migration 20261103170000_dangerous_act_keys).
 *
 *   GET  /                  tags:read   the registry, each row with its filter view
 *   POST /                  tags:write  create (name / category / colour / auto-assign filter)
 *   GET  /settings          tags:read   { enforce }
 *   PUT  /settings          tags:write
 *   GET  /filter-schema     tags:read   the condition builder's vocabulary
 *   PUT  /:id               tags:write  rename / recolour / move / filter — a rename is
 *                                       rewritten across blocks, subnets, assets, ports
 *   DELETE /:id             tags:write
 *   POST /preview-criteria  tags:read   dry-run a filter (sample hidden without assets:read)
 *
 * Why its own key, and why an administrator's: a tag on a record is write
 * reach for every user who holds that tag (business rule 141, release 2), so
 * whoever may put a tag on a device — or write a filter that puts it on every
 * matching device — is handing out access. Read is the floor for every
 * built-in: the pickers need the registry's names and colours. Assigning a
 * tag to a record is chained on this key at the record's own route
 * (assets, subnets, users, roles, group mappings).
 *
 * Lifted verbatim from serverSettings.ts on 2026-11-03; the helpers above the
 * routes guard the two reserved prefixes (`region:` is the Device Map's,
 * `azure:` is the Arc sync's) and the built-in Priority tags (rule 136).
 */

import { Router } from "express";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";
import {
  normalizeCriteria,
  reconcileTag,
  normalizeTagCondition,
  previewTagFilter,
  tagIsManaged,
  tagFilterView,
  stripTagAssignments,
  listAssetTags,
  type TagCriteria,
} from "../../services/tagAssignmentService.js";
import { REGION_TAG_CATEGORY } from "../../services/mapRegionService.js";
import { REGION_TAG_PREFIX, AZURE_TAG_PREFIX, isAzureTag, normalizeTagColor } from "../../utils/tagNormalize.js";
import {
  DEVICE_FILTER_FIELD_OPS,
  scopeConditionMeta,
  scopeConditionStats,
  type ScopeConditionGroup,
} from "../../services/notificationTypes.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { listAssetTypes } from "../../services/assetTypeService.js";

const router = Router();

const TAG_COLORS = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
function randomTagColor() { return TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)]; }


/**
 * The Map Regions category belongs to the Device Map, and only to it.
 *
 * Every tag in it is minted by a region save and kept in step by the region
 * reconcile through RegionTagAssignment provenance. A hand-created sibling would
 * be indistinguishable from one of those rows and owned by nothing — so the
 * registry refuses both creating a tag in the category and MOVING an existing
 * one into it, naming the Device Map as the way in. Editing a row already there
 * (colour, name) is untouched: those are the map's rows and this is not about
 * freezing them, it is about not adding to them from the side.
 */
function assertNotRegionCategory(category: string | null | undefined, verb: string): void {
  if ((category ?? "").trim() !== REGION_TAG_CATEGORY) return;
  throw new AppError(
    409,
    `The "${REGION_TAG_CATEGORY}" category is managed by the Device Map — draw or edit a region there to ${verb} its tag.`,
  );
}

/**
 * The `region:` prefix is reserved, in EVERY category.
 *
 * `assertNotRegionCategory` above guards the Map Regions *category*, and that
 * is not the same thing: a tag named `region:Nashville` filed under "General"
 * sails past it. Three consequences, in ascending order of nastiness.
 *
 * It renders in the asset edit modal's picker looking exactly like a real
 * region tag, so operators apply it, and what they get is a string that means
 * nothing and that nothing maintains. It is then indistinguishable from a tag
 * stranded by a half-applied rename, which is the ambiguity business rule 54
 * had to design around. And the auto-assign device-filter ban in
 * `readPostedTagFilter` is ALSO keyed on category, so filing under "General" is
 * a way to put a `TagAutoAssignment` filter on a `region:` name — precisely the
 * "two managed-sync reconcilers on one string" that ban exists to prevent. The
 * collision needs an ordering to land (names are unique, so the hand-made row
 * has to exist BEFORE a region takes that name, and `upsertTagRegistry`'s empty
 * `update` then leaves the filter in place), which is presumably why nobody has
 * hit it yet.
 *
 * Case-insensitive, because every other region-tag comparison in the codebase
 * is: `Region:Nashville` is the same reservation.
 */
function assertNotRegionPrefix(name: string, verb: string): void {
  if (!name.trim().toLowerCase().startsWith(REGION_TAG_PREFIX)) return;
  throw new AppError(
    409,
    `Tag names starting with "${REGION_TAG_PREFIX}" belong to the Device Map's regions — ` +
      `draw a region there to ${verb} its tag, or pick another name.`,
  );
}

/**
 * The `azure:` prefix belongs to the Azure Arc sync, in every category.
 *
 * Each Arc run strips every `azure:` tag off the assets it touches and
 * re-adds the set Azure currently reports, and syncAzureTagRegistry adds and
 * prunes the registry rows to match — a row goes away by itself once no asset
 * carries it. A hand-made `azure:` row would be pruned on the next run; one
 * carrying an auto-assign filter would put a second managed-sync reconciler on
 * a string the Arc sync already strips. So the registry refuses minting one by
 * create or by rename, and a mirrored row is read-only outright: no rename (the
 * next run would re-add the old name beside it), no colour / category / filter
 * edit, and no delete (the next run would re-add it while an asset still
 * carries it; once none does, the prune removes it).
 */
function assertNotAzurePrefix(name: string, verb: string): void {
  if (!isAzureTag(name.trim())) return;
  throw new AppError(
    409,
    `Tag names starting with "${AZURE_TAG_PREFIX}" are mirrored from Azure resource tags by the Azure Arc integration — ` +
      `set the tag in Azure to ${verb} it, or pick another name.`,
  );
}

/** A mirrored `azure:` registry row is read-only — see assertNotAzurePrefix. */
function assertNotMirroredAzureRow(name: string, verb: "edited" | "deleted"): void {
  if (!isAzureTag(name.trim())) return;
  throw new AppError(
    409,
    `"${name}" is mirrored from an Azure resource tag by the Azure Arc integration and cannot be ${verb} here — ` +
      `change the tag in Azure. Polaris removes it automatically once no asset carries it.`,
  );
}

/**
 * Business rule 136: a built-in Priority tag keeps its name, category and
 * colour whoever asks — no permission level unlocks them. A body that repeats
 * the stored values (the editor posts every field) passes; a body that changes
 * one is a 409, so a stale client can't half-apply an edit.
 */
function assertBuiltInFieldsUnchanged(
  existing: { name: string; category: string; color: string; builtIn: boolean },
  body: Record<string, unknown>,
): void {
  if (!existing.builtIn) return;
  const changed: string[] = [];
  if (body.name != null && String(body.name).trim() !== existing.name) changed.push("renamed");
  if (body.category != null && String(body.category) !== existing.category) changed.push("moved to another category");
  if (body.color != null && normalizeTagColor(body.color) !== existing.color) changed.push("recoloured");
  if (changed.length) {
    throw new AppError(
      409,
      `"${existing.name}" is a built-in Priority tag and cannot be ${changed.join(" or ")}. Only its device filter can be edited.`,
    );
  }
}

/**
 * How the audit Event describes the filter a write left on the tag. Counts
 * only — the tree itself is on the row, and an Event is shipped off-host by the
 * syslog / SFTP archivers.
 */
function describeTagFilter(
  condition: ScopeConditionGroup | null,
  criteria: TagCriteria | null,
): string {
  if (condition) {
    const { rules } = scopeConditionStats(condition);
    return ` with an auto-assign filter (${rules} condition${rules === 1 ? "" : "s"})`;
  }
  if (criteria) return ` with ${criteria.rules.length} auto-assign rule(s)`;
  return "";
}

/**
 * The device filter posted for a tag, validated. Absent key = leave as-is;
 * explicit null / an empty tree = clear (the tag becomes manual).
 *
 * A tag in the Map Regions category may not carry one at all: RegionTagAssignment
 * already manages those tag names, and layering TagAutoAssignment on the same
 * name would put two managed-sync reconcilers on one string, each stripping what
 * the other applied.
 */
function readPostedTagFilter(
  body: Record<string, unknown>,
  category: string | null | undefined,
): { provided: boolean; condition: ScopeConditionGroup | null; criteria: TagCriteria | null } {
  const hasCondition = Object.prototype.hasOwnProperty.call(body, "assetCondition");
  const hasCriteria = Object.prototype.hasOwnProperty.call(body, "criteria");
  if (!hasCondition && !hasCriteria) return { provided: false, condition: null, criteria: null };

  const condition = hasCondition ? normalizeTagCondition(body.assetCondition) : null;
  // A tree wins outright; the flat blob is only read when no tree was posted, so
  // a caller that sends both can't leave two live answers on the row.
  const criteria = condition ? null : normalizeCriteria(hasCriteria ? body.criteria : null);

  if ((condition || criteria) && (category ?? "").trim() === REGION_TAG_CATEGORY) {
    throw new AppError(
      409,
      `Tags in "${REGION_TAG_CATEGORY}" are auto-applied by the Device Map's regions — they cannot also carry a device filter.`,
    );
  }
  return { provided: true, condition, criteria };
}


router.get("/", async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
    // Each row carries the fold-forward alongside its stored columns, so the
    // editor opens a tag still on the legacy flat shape in the condition builder
    // with its rules intact. Without it such a tag would render as unfiltered
    // and the operator's next save would silently clear a live filter.
    res.json(tags.map((t) => ({ ...t, ...tagFilterView(t) })));
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) throw new AppError(400, "Tag name is required");

    const existing = await prisma.tag.findUnique({ where: { name } });
    if (existing) throw new AppError(409, `Tag "${name}" already exists`);

    const category = req.body.category || "General";
    assertNotRegionCategory(category, "add");
    assertNotRegionPrefix(name, "add");
    assertNotAzurePrefix(name, "add");

    // Validate + normalize the optional auto-assignment device filter
    // (neither shape set = an ordinary manual tag).
    const { condition, criteria } = readPostedTagFilter(req.body, category);

    const tag = await prisma.tag.create({
      data: {
        name,
        category,
        color: req.body.color ? normalizeTagColor(req.body.color) : randomTagColor(),
        assetCondition: condition ? (condition as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        criteria: criteria ? (criteria as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
    await logEvent({
      level: "info",
      action: "tag.created",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: `Tag created: "${tag.name}" (category ${tag.category})${describeTagFilter(condition, criteria)}`,
    });
    // Apply the filter immediately (best-effort; the periodic job is the safety net).
    if (condition || criteria) {
      reconcileTag(tag.id).catch((err) =>
        logger.warn({ err: err?.message ?? String(err), tagId: tag.id }, "tag create: reconcile failed"),
      );
    }
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

router.get("/settings", async (_req, res, next) => {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "tagSettings" } });
    res.json(row ? row.value : { enforce: false });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const value = { enforce: req.body.enforce === true };
    const row = await prisma.setting.upsert({
      where: { key: "tagSettings" },
      update: { value },
      create: { key: "tagSettings", value },
    });
    await logEvent({
      level: "info",
      action: "tag.settings.updated",
      resourceType: "setting",
      resourceName: "tagSettings",
      actor: req.session?.username,
      message: `Tag enforcement ${value.enforce ? "enabled" : "disabled"}`,
    });
    res.json(row.value);
  } catch (err) {
    next(err);
  }
});

// GET /server-settings/tags/filter-schema — the condition builder's vocabulary
// + value suggestions for a tag's auto-assign device filter. Its own route
// rather than /automations/schema or /contacts/filter-schema because those are
// gated automationManagement:read / contacts:read, and managing the tag registry
// must not require permission to edit automations or browse the address book
// (the /assets/pin-filter-schema precedent). Built from the same shared
// scopeConditionMeta so the vocabularies can't drift.
//
// The WIDE DEVICE_FILTER field set, matching the address book rather than the
// automations Devices step: that vocabulary was widened in the first place to
// cover what the flat tag criteria could already say (osVersion / department /
// location / fortigate, plus the wildcard operator), so anything narrower would
// make the shape cutover a regression.
//
// Declared before "/tags/:id" so the literal path can't be captured as an id.
router.get("/filter-schema", requirePermission("tags", "read"), async (_req, res, next) => {
  try {
    // assetTypes + tags ride this payload for the same reason they ride
    // /contacts/filter-schema: their own endpoints are gated `assets:read`,
    // which a caller managing the tag registry need not hold, and the value
    // pickers would silently degrade to free text.
    const [options, assetTypes, tags] = await Promise.all([
      listScopeOptions(),
      listAssetTypes(),
      listAssetTags(),
    ]);
    res.json({
      scopeCondition: scopeConditionMeta(DEVICE_FILTER_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
      regionCategory: REGION_TAG_CATEGORY,
    });
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Tag not found");
    assertNotMirroredAzureRow(existing.name, "edited");
    assertBuiltInFieldsUnchanged(existing, req.body);

    const name = (req.body.name ?? existing.name).trim();
    if (!name) throw new AppError(400, "Tag name is required");

    const renamed = name !== existing.name;
    if (renamed) {
      const dupe = await prisma.tag.findUnique({ where: { name } });
      if (dupe) throw new AppError(409, `Tag "${name}" already exists`);
      // Only a rename INTO the prefix is refused. A row already carrying it is
      // one of the map's own, and this route deliberately does not freeze those
      // (see assertNotRegionCategory) — and the guard must not fire on a
      // colour-only edit, where `name` falls back to the existing region name.
      if (!existing.name.trim().toLowerCase().startsWith(REGION_TAG_PREFIX)) {
        assertNotRegionPrefix(name, "rename");
      }
      // Into the prefix mints an orphan the next Arc run prunes (out of it is
      // refused above with every other edit of a mirrored row).
      assertNotAzurePrefix(name, "rename");
    }

    const category = req.body.category ?? existing.category;
    // Moving a tag INTO the map's category is the same act as creating one there.
    // A row already in it keeps its category with no complaint.
    if (category !== existing.category) assertNotRegionCategory(category, "add");

    // The filter only changes when a shape key is present in the body. Absent =
    // leave as-is; explicit null / an empty tree = clear (becomes a manual tag).
    const posted = readPostedTagFilter(req.body, category);
    const filterWrite = posted.provided
      ? {
          assetCondition: posted.condition
            ? (posted.condition as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          // Exactly one shape is ever live on a row, so writing either clears
          // the other — a criteria blob left behind a tree would be a second
          // answer to "which devices?".
          criteria: posted.criteria
            ? (posted.criteria as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        }
      : {};

    const tag = await prisma.tag.update({
      where: { id },
      data: {
        name,
        category,
        color: req.body.color != null ? normalizeTagColor(req.body.color) : existing.color,
        ...filterWrite,
      },
    });

    if (renamed) {
      const oldName = existing.name;
      await Promise.all([
        prisma.$executeRaw`UPDATE ip_blocks SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
        prisma.$executeRaw`UPDATE subnets SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
        prisma.$executeRaw`UPDATE assets SET tags = array_replace(tags, ${oldName}, ${name}) WHERE ${oldName} = ANY(tags)`,
        // Interface tags (business rule 133) are keyed by name, so a port that
        // already carries the new name (an unregistered hand-typed tag — a
        // registered one was refused above) keeps that row and drops the old.
        prisma.$transaction([
          prisma.$executeRaw`DELETE FROM asset_interface_tags a WHERE a.tag = ${oldName} AND EXISTS (
            SELECT 1 FROM asset_interface_tags b WHERE b."assetId" = a."assetId" AND b."ifName" = a."ifName" AND b.tag = ${name})`,
          prisma.$executeRaw`UPDATE asset_interface_tags SET tag = ${name} WHERE tag = ${oldName}`,
        ]),
        // Network-inheritance provenance (business rule 137) is keyed by name
        // too; it follows the string it vouches for in assets.tags.
        prisma.$transaction([
          prisma.$executeRaw`DELETE FROM network_tag_assignments a WHERE a.tag = ${oldName} AND EXISTS (
            SELECT 1 FROM network_tag_assignments b WHERE b."assetId" = a."assetId" AND b.tag = ${name})`,
          prisma.$executeRaw`UPDATE network_tag_assignments SET tag = ${name} WHERE tag = ${oldName}`,
        ]),
      ]);
    }

    await logEvent({
      level: "info",
      action: "tag.updated",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: renamed
        ? `Tag renamed: "${existing.name}" → "${tag.name}" (rewritten across blocks/subnets/assets/interfaces)`
        : `Tag updated: "${tag.name}"`,
    });

    // Re-run the managed-sync diff whenever the filter changed (or the tag was
    // renamed, since provenance is keyed by tagId but the applied string moved).
    if (posted.provided || renamed) {
      reconcileTag(tag.id).catch((err) =>
        logger.warn({ err: err?.message ?? String(err), tagId: tag.id }, "tag update: reconcile failed"),
      );
    }

    res.json(tag);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    const tagId = String(req.params.id);
    const tag = await prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) throw new AppError(404, "Tag not found");
    assertNotMirroredAzureRow(tag.name, "deleted");
    // Business rule 136: no one deletes a built-in Priority tag.
    if (tag.builtIn) {
      throw new AppError(409, `"${tag.name}" is a built-in Priority tag and cannot be deleted. Clear its device filter instead.`);
    }
    // Strip engine-applied copies (and their provenance) before deleting. Manual
    // copies on assets the engine never tagged are untouched — same as before.
    let stripped = 0;
    if (tagIsManaged(tag)) {
      stripped = await stripTagAssignments(tag.id, tag.name);
    }
    await prisma.tag.delete({ where: { id: tagId } });
    await logEvent({
      level: "warning",
      action: "tag.deleted",
      resourceType: "tag",
      resourceId: tag.id,
      resourceName: tag.name,
      actor: req.session?.username,
      message: `Tag deleted: "${tag.name}"${stripped ? ` (removed from ${stripped} auto-assigned asset(s))` : ""}`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Dry-run a tag's device filter: how many assets match, a sample, and (when
// tagId is given) the +add / -remove delta vs. that tag's current
// auto-assignments. Drives the live preview line under the builder. Takes
// EITHER shape — `assetCondition` (what the builder posts) or a legacy flat
// `criteria` blob — so one route serves the editor and any older caller.
router.post("/preview-criteria", async (req, res, next) => {
  try {
    const tagId = typeof req.body.tagId === "string" ? req.body.tagId : undefined;
    const preview = await previewTagFilter(
      { condition: req.body.assetCondition, criteria: req.body.criteria },
      tagId,
    );
    // The sample names devices (hostname, IP, type). This route is reachable
    // with Server Settings read alone, so a caller who may not list assets
    // gets the counts only — enough to build a filter (re-scan F78).
    if (!hasPermission(req, "assets", "read")) {
      res.json({ ...preview, sample: [], sampleHidden: true });
      return;
    }
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

export default router;
