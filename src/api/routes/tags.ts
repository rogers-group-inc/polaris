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
 * Lifted verbatim from serverSettings.ts on 2026-11-03. Since 2026-11-06
 * (CQ-B044) the registry logic — every Prisma call, the guards on the two
 * reserved prefixes (`region:` is the Device Map's, `azure:` is the Arc
 * sync's) and the built-in Priority tags (rule 136), the rename rewrite and
 * the audit Events — lives in services/tagRegistryService.ts; this file is
 * the gates and the HTTP shape.
 */

import { Router } from "express";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { previewTagFilter, listAssetTags } from "../../services/tagAssignmentService.js";
import { REGION_TAG_CATEGORY } from "../../services/mapRegionService.js";
import { DEVICE_FILTER_FIELD_OPS, scopeConditionMeta } from "../../services/notificationTypes.js";
import { listScopeOptions } from "../../services/notificationRuleService.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import {
  listTagRegistry,
  createTag,
  getTagSettings,
  updateTagSettings,
  updateTag,
  deleteTag,
} from "../../services/tagRegistryService.js";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    res.json(await listTagRegistry());
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    res.status(201).json(await createTag(req.body ?? {}, req.session?.username));
  } catch (err) {
    next(err);
  }
});

router.get("/settings", async (_req, res, next) => {
  try {
    res.json(await getTagSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    res.json(await updateTagSettings(req.body?.enforce === true, req.session?.username));
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
    res.json(await updateTag(req.params.id as string, req.body ?? {}, req.session?.username));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requirePermission("tags", "write"), async (req, res, next) => {
  try {
    await deleteTag(String(req.params.id), req.session?.username);
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
