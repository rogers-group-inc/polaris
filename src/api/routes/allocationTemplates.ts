/**
 * src/api/routes/allocationTemplates.ts
 *
 * CRUD for saved multi-subnet allocation templates used by the
 * Networks "Auto-Allocate Next" modal.
 */

import { Router } from "express";
import { z } from "zod";
import * as templateService from "../../services/allocationTemplateService.js";
import { requirePermission } from "../middleware/permissions.js";
import { logEvent } from "./events.js";

const router = Router();

const EntrySchema = z.object({
  skip:         z.boolean().optional(),
  name:         z.string().optional(),
  prefixLength: z.number().int().min(8).max(32),
  vlan:         z.number().int().min(1).max(4094).nullable().optional(),
}).refine((e) => e.skip === true || (typeof e.name === "string" && e.name.trim().length > 0), {
  message: "Each entry needs a name unless it is marked as a skip row",
});

const SaveTemplateSchema = z.object({
  name:         z.string().min(1, "Template name is required"),
  entries:      z.array(EntrySchema).max(10_000).min(1, "Template must have at least one entry"),
  anchorPrefix: z.number().int().min(8).max(32).optional(),
});

// GET /allocation-templates — any authenticated caller can list templates
router.get("/", requirePermission("allocationTemplates", "read"), async (_req, res, next) => {
  try {
    res.json(await templateService.listTemplates());
  } catch (err) {
    next(err);
  }
});

// POST /allocation-templates
router.post("/", requirePermission("allocationTemplates", "write"), async (req, res, next) => {
  try {
    const input = SaveTemplateSchema.parse(req.body);
    const saved = await templateService.saveTemplate(input);
    logEvent({
      action: "allocation-template.created",
      resourceType: "allocation-template",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Allocation template "${saved.name}" created (${saved.entries.length} entries)`,
    });
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

// PUT /allocation-templates/:id
router.put("/:id", requirePermission("allocationTemplates", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = SaveTemplateSchema.parse(req.body);
    const saved = await templateService.saveTemplate({ id, ...input });
    logEvent({
      action: "allocation-template.updated",
      resourceType: "allocation-template",
      resourceId: saved.id,
      resourceName: saved.name,
      actor: req.session?.username,
      message: `Allocation template "${saved.name}" updated (${saved.entries.length} entries)`,
    });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

// DELETE /allocation-templates/:id
router.delete("/:id", requirePermission("allocationTemplates", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await templateService.deleteTemplate(id);
    logEvent({
      action: "allocation-template.deleted",
      resourceType: "allocation-template",
      resourceId: id,
      actor: req.session?.username,
      message: `Allocation template ${id} deleted`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
