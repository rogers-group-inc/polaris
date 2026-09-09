/**
 * src/api/routes/roles.ts — Dynamic role CRUD
 *
 * Gated per-route via requirePermission("roles", ...):
 *   GET /, GET /:id, GET /functions — "read"
 *   POST /, PUT /:id, DELETE /:id — "write"
 *
 * /functions exposes the matrix catalogue (key + label + description +
 * hasOwnershipDimension) so the frontend renders rows without hardcoding
 * the function-key list.
 */

import { Router } from "express";
import { z } from "zod";
import * as roleService from "../../services/roleService.js";
import {
  FUNCTION_KEYS,
  ACCESS_LEVELS,
  requirePermission,
  assertNoPrivilegeEscalation,
} from "../middleware/permissions.js";

const router = Router();

const AccessLevelSchema = z.enum(ACCESS_LEVELS as unknown as [string, ...string[]]);

// Permissions accepted as a partial map — anything missing defaults to "none"
// inside normalizePermissions. Unknown keys are dropped server-side.
const PermissionsSchema = z.record(z.string(), AccessLevelSchema);

const RegionTagsSchema = z.array(z.string().max(64)).max(64);

// `#rrggbb` hex string; empty string / null clears the color.
const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be a #rrggbb hex string");

const CreateRoleSchema = z.object({
  name:        z.string().min(2).max(32),
  description: z.string().max(200).optional().nullable(),
  permissions: PermissionsSchema,
  regionTags:  RegionTagsSchema.optional(),
  color:       ColorSchema.optional().nullable(),
});

const UpdateRoleSchema = z.object({
  name:        z.string().min(2).max(32).optional(),
  description: z.string().max(200).optional().nullable(),
  permissions: PermissionsSchema.optional(),
  regionTags:  RegionTagsSchema.optional(),
  color:       ColorSchema.optional().nullable(),
});

// ─── Function-key catalogue (static; no DB hit) ──────────────────────

router.get("/functions", requirePermission("roles", "read"), (_req, res) => {
  res.json({
    accessLevels: ACCESS_LEVELS,
    functions: FUNCTION_KEYS,
  });
});

// ─── Role CRUD ───────────────────────────────────────────────────────

router.get("/", requirePermission("roles", "read"), async (_req, res, next) => {
  try {
    res.json(await roleService.listRoles());
  } catch (err) { next(err); }
});

router.get("/:id", requirePermission("roles", "read"), async (req, res, next) => {
  try {
    res.json(await roleService.getRole(req.params.id as string));
  } catch (err) { next(err); }
});

router.post("/", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    const input = CreateRoleSchema.parse(req.body);
    // Rule 48: roles:write must not be able to mint an admin-equivalent role.
    assertNoPrivilegeEscalation(req, input.permissions, `the role "${input.name}"`);
    const created = await roleService.createRole(
      {
        name:        input.name,
        description: input.description ?? null,
        permissions: input.permissions as Parameters<typeof roleService.createRole>[0]["permissions"],
        ...(input.regionTags !== undefined && { regionTags: input.regionTags }),
        ...(input.color !== undefined && { color: input.color }),
      },
      req.session?.username,
    );
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    const input = UpdateRoleSchema.parse(req.body);
    // Rule 48: nor to promote an existing role — including the caller's own —
    // into one. A partial update that leaves `permissions` alone is untouched.
    if (input.permissions !== undefined) {
      assertNoPrivilegeEscalation(req, input.permissions, "this permission set");
    }
    const updated = await roleService.updateRole(
      req.params.id as string,
      {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.permissions !== undefined && {
          permissions: input.permissions as Parameters<typeof roleService.updateRole>[1]["permissions"],
        }),
        ...(input.regionTags !== undefined && { regionTags: input.regionTags }),
        ...(input.color !== undefined && { color: input.color }),
      },
      req.session?.username,
    );
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("roles", "write"), async (req, res, next) => {
  try {
    await roleService.deleteRole(req.params.id as string, req.session?.username);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
