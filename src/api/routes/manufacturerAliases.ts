/**
 * src/api/routes/manufacturerAliases.ts
 *
 * CRUD for the manufacturer alias map, gated on manufacturerProfiles — read to
 * list (the mount in router.ts carries that floor), write to change. An alias
 * decides which profile a device matches, so the two are one grant (business
 * rule 43(f)). Edits propagate to existing
 * Asset.manufacturer / MibFile.manufacturer rows on save (the service runs the
 * backfill in the background after each create/update).
 */

import { Router } from "express";
import { z } from "zod";
import * as aliasService from "../../services/manufacturerAliasService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";

const router = Router();

const CreateSchema = z.object({
  alias:     z.string().min(1),
  canonical: z.string().min(1),
});

const UpdateSchema = z.object({
  alias:     z.string().min(1).optional(),
  canonical: z.string().min(1).optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    res.json(await aliasService.listAliases());
  } catch (err) { next(err); }
});

router.post("/", requirePermission("manufacturerProfiles", "write"), async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const saved = await aliasService.createAlias(input);
    logEvent({
      action: "manufacturer_alias.created",
      resourceType: "manufacturer_alias",
      resourceId: saved.id,
      resourceName: saved.canonical,
      actor: req.session?.username,
      message: `Manufacturer alias "${saved.alias}" → "${saved.canonical}" created`,
    });
    res.status(201).json(saved);
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("manufacturerProfiles", "write"), async (req, res, next) => {
  try {
    const input = UpdateSchema.parse(req.body);
    const saved = await aliasService.updateAlias(req.params.id as string, input);
    logEvent({
      action: "manufacturer_alias.updated",
      resourceType: "manufacturer_alias",
      resourceId: saved.id,
      resourceName: saved.canonical,
      actor: req.session?.username,
      message: `Manufacturer alias "${saved.alias}" → "${saved.canonical}" updated`,
    });
    res.json(saved);
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("manufacturerProfiles", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const all = await aliasService.listAliases();
    const existing = all.find((a) => a.id === id);
    await aliasService.deleteAlias(id);
    logEvent({
      action: "manufacturer_alias.deleted",
      resourceType: "manufacturer_alias",
      resourceId: id,
      resourceName: existing?.canonical,
      actor: req.session?.username,
      message: existing
        ? `Manufacturer alias "${existing.alias}" → "${existing.canonical}" deleted`
        : "Manufacturer alias deleted",
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
