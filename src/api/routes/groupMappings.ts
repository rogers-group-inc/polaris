/**
 * src/api/routes/groupMappings.ts — IdP group → role + tags mapping CRUD
 *
 * Gated on users=fullwrite at the mount (same privilege tier that assigns
 * roles to users); no dedicated function key. Thin wrappers over
 * groupMappingService — all validation + Events live there.
 */

import { Router } from "express";
import { z } from "zod";
import * as groupMappingService from "../../services/groupMappingService.js";
import { GROUP_MAPPING_PROVIDERS } from "../../services/groupMappingService.js";
import { assertGrantWithinCaller, assertNoPrivilegeEscalation } from "../middleware/permissions.js";
import type { Request } from "express";

const router = Router();

/**
 * Business rule 114(g) for IdP group mappings (2026-10-13 re-scan F5/F65): a
 * mapping hands its role to every member of an IdP group at their next SSO,
 * OIDC, LDAP or App Proxy login, so it is a grant like any other — the role
 * may not exceed the caller's own access. Checked whenever the mapping would
 * hand a role to a possibly different set of people: created, its role
 * changed, its group changed, or switched back on. Taking away a role the
 * caller could not have granted (removing, disabling or retargeting an
 * admin-equivalent mapping) needs an admin-equivalent caller too.
 */
async function assertMappingWithinCaller(req: Request, roleId: string | null | undefined): Promise<void> {
  const role = await groupMappingService.roleGrantFor(roleId);
  if (role) assertGrantWithinCaller(req, role.permissions, `the role "${role.name}" this group mapping grants`);
}

async function assertMayWithdrawMapping(req: Request, roleId: string | null | undefined): Promise<void> {
  const role = await groupMappingService.roleGrantFor(roleId);
  if (role) assertNoPrivilegeEscalation(req, role.permissions, `the group mapping's role "${role.name}"`);
}

const TagsSchema = z.array(z.string().max(64)).max(64);
const ProviderSchema = z.enum(GROUP_MAPPING_PROVIDERS as unknown as [string, ...string[]]);

const CreateSchema = z.object({
  provider: ProviderSchema,
  groupKey: z.string().min(1).max(512),
  roleId: z.string().uuid().optional().nullable(),
  regionTags: TagsSchema.optional(),
  otherTags: TagsSchema.optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const UpdateSchema = z.object({
  groupKey: z.string().min(1).max(512).optional(),
  roleId: z.string().uuid().optional().nullable(),
  regionTags: TagsSchema.optional(),
  otherTags: TagsSchema.optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional().nullable(),
});

const ListQuerySchema = z.object({ provider: ProviderSchema.optional() });

router.get("/", async (req, res, next) => {
  try {
    const { provider } = ListQuerySchema.parse(req.query);
    res.json(await groupMappingService.listGroupMappings(provider));
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    res.json(await groupMappingService.getGroupMapping(req.params.id as string));
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    // Checked even when created disabled: it is one toggle away from granting.
    await assertMappingWithinCaller(req, input.roleId);
    const created = await groupMappingService.createGroupMapping(input, req.session?.username);
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const input = UpdateSchema.parse(req.body);
    const before = await groupMappingService.mappingGrantState(req.params.id as string);
    if (before) {
      const nextRoleId = input.roleId === undefined ? before.roleId : input.roleId || null;
      const roleChanged = nextRoleId !== before.roleId;
      const groupChanged = input.groupKey !== undefined
        && input.groupKey.trim() !== (before.groupLabel || before.groupKey);
      const switchedOn = input.enabled === true && !before.enabled;
      if (roleChanged || groupChanged || switchedOn) await assertMappingWithinCaller(req, nextRoleId);
      const withdrawn = roleChanged || groupChanged || input.enabled === false;
      if (withdrawn) await assertMayWithdrawMapping(req, before.roleId);
    }
    const updated = await groupMappingService.updateGroupMapping(req.params.id as string, input, req.session?.username);
    res.json(updated);
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const doomed = await groupMappingService.mappingGrantState(req.params.id as string);
    if (doomed) await assertMayWithdrawMapping(req, doomed.roleId);
    await groupMappingService.deleteGroupMapping(req.params.id as string, req.session?.username);
    // 204 like every other router's DELETE (api.js request() maps it to null).
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
