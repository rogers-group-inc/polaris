/**
 * src/api/routes/subnets.ts
 */

import { Router } from "express";
import { z } from "zod";
import * as subnetService from "../../services/subnetService.js";
import { refreshSubnet } from "../../services/subnetRefreshService.js";
import * as subnetArchiveService from "../../services/subnetArchiveService.js";
import * as subnetExclusionService from "../../services/subnetExclusionService.js";
import { requirePermission, requireOwnership, assertOwnership } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const CreateSubnetSchema = z.object({
  blockId:     z.string().uuid(),
  cidr:        z.string().min(1, "CIDR is required"),
  name:        z.string().min(1, "Subnet name is required"),
  purpose:     z.string().optional(),          // description / what it's for
  vlan:        z.number().int().min(1).max(4094).optional(),
  tags:        z.array(z.string()).optional(),
});

const AllocateNextSchema = z.object({
  blockId:      z.string().uuid(),
  prefixLength: z.number().int().min(8).max(32),
  name:         z.string().min(1, "Subnet name is required"),
  purpose:      z.string().optional(),
  vlan:         z.number().int().min(1).max(4094).optional(),
  tags:         z.array(z.string()).optional(),
});

const BulkEntrySchema = z.object({
  skip:         z.boolean().optional(),
  name:         z.string().optional(),
  prefixLength: z.number().int().min(8).max(32),
  vlan:         z.number().int().min(1).max(4094).nullable().optional(),
}).refine((e) => e.skip === true || (typeof e.name === "string" && e.name.trim().length > 0), {
  message: "Each entry needs a name unless it is marked as a skip row",
});

const BulkAllocateSchema = z.object({
  blockId: z.string().uuid(),
  prefix:  z.string().min(1, "Site/prefix name is required"),
  entries: z.array(BulkEntrySchema).min(1, "At least one entry is required"),
  tags:         z.array(z.string()).optional(),
  anchorPrefix: z.number().int().min(8).max(32).optional(),
});

// Subnet exclusions (business rule 42). Shape only — CIDR validity, IPv4-only
// and the already-excluded refusal live in subnetExclusionService, so an
// exclusion created by any caller passes exactly the same checks.
const CreateExclusionSchema = z.object({
  cidr:  z.string().min(1, "CIDR is required"),
  name:  z.string().min(1, "Exclusion name is required"),
  notes: z.string().nullish(),
});

// No `cidr` here on purpose — see the PUT's comment.
const UpdateExclusionSchema = z.object({
  name:  z.string().min(1, "Exclusion name is required").optional(),
  notes: z.string().nullish(),
});

const UpdateSubnetSchema = z.object({
  name:    z.string().min(1, "Name is required").optional(),
  purpose: z.string().optional(),
  status:  z.enum(["available", "reserved", "deprecated"]).optional(),
  vlan:    z.number().int().min(1).max(4094).nullable().optional(),
  tags:    z.array(z.string()).optional(),
  convertToManual: z.boolean().optional(),
  mergeIntegration: z.boolean().optional(),
});

const MoveSubnetSchema = z.object({
  blockId: z.string().uuid(),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /subnets?blockId=&status=&tag=&limit=&offset=
router.get("/", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    const { blockId, status, tag, createdBy } = req.query as Record<string, string>;
    const limit = parseInt(req.query.limit as string, 10) || undefined;
    const offset = parseInt(req.query.offset as string, 10) || undefined;
    const resolvedCreatedBy = createdBy === "me" ? (req.session?.username ?? undefined) : (createdBy || undefined);
    res.json(await subnetService.listSubnets({ blockId, status: status as any, tag, createdBy: resolvedCreatedBy, limit, offset }));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/next-available  (must come before /:id)
router.post("/next-available", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const { blockId, prefixLength, ...metadata } = AllocateNextSchema.parse(req.body);
    const subnet = await subnetService.allocateNextSubnet(blockId, prefixLength, {
      ...metadata,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// POST /subnets/bulk-allocate/preview  (must come before /:id)
// Lenient about missing names so the UI can show running totals while the
// user is still filling rows; the mutating /bulk-allocate endpoint enforces
// names via BulkEntrySchema.
const PreviewEntrySchema = z.object({
  skip:         z.boolean().optional(),
  name:         z.string().optional(),
  prefixLength: z.number().int().min(8).max(32),
  vlan:         z.number().int().min(1).max(4094).nullable().optional(),
});
router.post("/bulk-allocate/preview", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const schema = z.object({
      blockId:      z.string().uuid(),
      entries:      z.array(PreviewEntrySchema),
      anchorPrefix: z.number().int().min(8).max(32).optional(),
    });
    const input = schema.parse(req.body);
    res.json(await subnetService.previewBulkAllocate(input));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/bulk-allocate  (must come before /:id)
router.post("/bulk-allocate", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const input = BulkAllocateSchema.parse(req.body);
    const result = await subnetService.bulkAllocate({
      ...input,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Subnet exclusions (business rule 42) ────────────────────────────────────
//
// A CIDR the operator has declared out of scope for the networks list — the
// address space several sites serve identically, which Polaris' one-row-per-CIDR
// model can only record once and which since rule 41 raises a `chassis-replaced`
// conflict on every run because each site's gate answers with its own serial.
//
// These MUST stay declared before `/:id`, or `/subnets/exclusions` is captured
// as a subnet id. Reads are `subnets:read` (any operator who can see the list
// can see what is excluded from it); the three mutations are `fullwrite`, the
// archive's reasoning — an exclusion is fleet-wide and applies to discovered
// rows nobody owns, so the ownership-aware `write` tier could never be the
// right gate for it.

// GET /subnets/exclusions — every exclusion + the live networks each covers.
router.get("/exclusions", requirePermission("subnets", "read"), async (_req, res, next) => {
  try {
    res.json(await subnetExclusionService.listExclusions());
  } catch (err) {
    next(err);
  }
});

// POST /subnets/exclusions
router.post("/exclusions", requirePermission("subnets", "fullwrite"), async (req, res, next) => {
  try {
    const input = CreateExclusionSchema.parse(req.body);
    const created = await subnetExclusionService.createExclusion({
      ...input,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// PUT /subnets/exclusions/:id — name / notes only. The CIDR is the exclusion's
// identity: re-pointing one in place would silently un-exclude the space the
// operator excluded, so changing address space is a delete plus an add.
router.put("/exclusions/:id", requirePermission("subnets", "fullwrite"), async (req, res, next) => {
  try {
    const input = UpdateExclusionSchema.parse(req.body);
    const saved = await subnetExclusionService.updateExclusion(req.params.id as string, {
      ...input,
      actor: req.session?.username,
    });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/exclusions/:id
router.delete("/exclusions/:id", requirePermission("subnets", "fullwrite"), async (req, res, next) => {
  try {
    await subnetExclusionService.deleteExclusion(
      req.params.id as string,
      req.session?.username ?? undefined,
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Archived subnets (business rule 41) ─────────────────────────────────────
//
// A retired subnet lives in its own table rather than as a `deprecated` status,
// because a retired row still holds `@@unique([blockId, cidr])` and so blocks a
// replacement gate's identical address space from ever being recorded. These
// two reads are the review surface; they MUST stay declared before `/:id`, or
// `/subnets/archived` is captured as a subnet id.

// GET /subnets/archived?cidr=&blockId=&fortigateSerial=&limit=&offset=
router.get("/archived", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    const result = await subnetArchiveService.listArchivedSubnets({
      cidr: typeof req.query.cidr === "string" ? req.query.cidr : undefined,
      blockId: typeof req.query.blockId === "string" ? req.query.blockId : undefined,
      fortigateSerial:
        typeof req.query.fortigateSerial === "string" ? req.query.fortigateSerial : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/archived/:id — one retirement with every reservation it held.
router.get("/archived/:id", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    res.json(await subnetArchiveService.getArchivedSubnet(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/:id/archive — retire a subnet: snapshot it + its reservations
// into the archive, then delete the live row so its CIDR is free again.
//
// `fullwrite`, not the ownership-aware `write` every other mutation here uses:
// a discovered subnet carries `createdBy: null`, so an ownership-scoped caller
// could never archive one anyway, and retiring a site's address space is not an
// own-rows action. Deliberately NOT subject to business rule 4's active-
// reservation protection — that exists to stop accidental DESTRUCTION, and this
// preserves everything it moves.
router.post("/:id/archive", requirePermission("subnets", "fullwrite"), async (req, res, next) => {
  try {
    const result = await subnetArchiveService.archiveSubnet(req.params.id as string, {
      actor: req.session?.username ?? null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /subnets/:id/refresh — Per-subnet "refresh from device" action used by
// the IP panel's Refresh button. Queries the originating FortiGate for ONE
// DHCP scope (CMDB reservations + live leases), reconciles against Polaris's
// reservation rows for the same subnet, and bumps subnet.lastDiscoveredAt.
// Requires user-or-above so the same role that can reserve IPs can also kick
// a per-subnet refresh; full-fleet discovery still requires networkadmin via
// /integrations/:id/discover.
router.post("/:id/refresh", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await refreshSubnet(id, req.session?.username ?? null);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id/ips?page=&pageSize=
router.get("/:id/ips", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.min(65536, Math.max(1, parseInt(req.query.pageSize as string, 10) || 256));
    res.json(await subnetService.getSubnetIps(id, page, pageSize));
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id
router.get("/:id", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    res.json(await subnetService.getSubnet(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /subnets
router.post("/", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const input = CreateSubnetSchema.parse(req.body);
    const subnet = await subnetService.createSubnet({
      ...input,
      createdBy: req.session?.username ?? undefined,
      actor: req.session?.username,
    });
    res.status(201).json(subnet);
  } catch (err) {
    next(err);
  }
});

// PUT /subnets/:id
router.put("/:id", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const input = UpdateSubnetSchema.parse(req.body);
    const before = await subnetService.getSubnet(id);
    assertOwnership(req, before.createdBy, "edit networks");
    const subnet = await subnetService.updateSubnet(id, {
      ...input,
      vlan: input.vlan ?? undefined,
      actor: req.session?.username,
    });
    res.json(subnet);
  } catch (err) {
    next(err);
  }
});

// GET /subnets/:id/move-targets — blocks whose range can hold this network,
// each flagged with the sibling that would overlap (null = the move is allowed).
router.get("/:id/move-targets", requirePermission("subnets", "read"), async (req, res, next) => {
  try {
    res.json(await subnetService.listMoveTargets(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /subnets/:id/move — re-parent the network onto another block. Same
// gate as an edit: write-level callers move only networks they created.
router.post("/:id/move", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { blockId } = MoveSubnetSchema.parse(req.body);
    const before = await subnetService.getSubnet(id);
    assertOwnership(req, before.createdBy, "move networks");
    res.json(await subnetService.moveSubnet(id, blockId, req.session?.username));
  } catch (err) {
    next(err);
  }
});

// DELETE /subnets/:id
router.delete("/:id", requireOwnership("subnets"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    if (req.permissionLevel !== "fullwrite") {
      const existing = await subnetService.getSubnet(id);
      assertOwnership(req, existing.createdBy, "delete networks");
    }
    await subnetService.deleteSubnet(id, req.session?.username);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
