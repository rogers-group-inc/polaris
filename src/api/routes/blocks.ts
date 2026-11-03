/**
 * src/api/routes/blocks.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as blockService from "../../services/blockService.js";
import { requirePermission, assertTagChangeAllowed } from "../middleware/permissions.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateBlockSchema = z.object({
  name:        z.string().min(1, "Name is required"),
  cidr:        z.string().min(1, "CIDR is required"),
  description: z.string().optional(),
  tags:        z.array(z.string()).optional(),
});

const UpdateBlockSchema = z.object({
  name:        z.string().min(1, "Name is required").optional(),
  description: z.string().optional(),
  tags:        z.array(z.string()).optional(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/", requirePermission("ipBlocks", "read"), async (req, res, next) => {
  try {
    const { ipVersion, tag } = req.query as Record<string, string>;
    res.json(await blockService.listBlocks({ ipVersion: ipVersion as any, tag }));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", requirePermission("ipBlocks", "read"), async (req, res, next) => {
  try {
    res.json(await blockService.getBlock(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("ipBlocks", "write"), async (req, res, next) => {
  try {
    const input = CreateBlockSchema.parse(req.body);
    assertTagChangeAllowed(req, [], input.tags);
    const block = await blockService.createBlock({ ...input, actor: req.session?.username });
    res.status(201).json(block);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", requirePermission("ipBlocks", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateBlockSchema.parse(req.body);
    if (input.tags !== undefined) {
      const before = await blockService.getBlock(id);
      assertTagChangeAllowed(req, before.tags, input.tags);
    }
    const block = await blockService.updateBlock(id, { ...input, actor: req.session?.username });
    res.json(block);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requirePermission("ipBlocks", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await blockService.deleteBlock(id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
