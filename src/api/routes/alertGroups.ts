/**
 * src/api/routes/alertGroups.ts — /api/v1/automations/groups
 *
 * CRUD for AlertGroup (business rule 75): a named set of automations whose
 * alerts about one device fold into a single alert, with the group owning
 * delivery — recipients, escalation, reminders, the acknowledge-note policy.
 *
 * MOUNTED ABOVE `/automations` in the router, like `/automations/scripts`, so
 * the literal path is never captured as a rule id.
 *
 * Gated on `automationManagement` exactly as the automations themselves are:
 * a group decides who gets paged about every one of its members, which is at
 * least as sensitive as editing one of them. Reads take `read`, writes take
 * `fullwrite` — the same ladder notificationRules.ts uses.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import {
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  groupRemovalImpact,
  listJoinableRules,
} from "../../services/alertGroupService.js";
import {
  escalatableActionSchema,
  actionSchema,
  emailCompositionSchema,
  escalationV2Schema,
  escalationSchema,
  repeatConfigSchema,
  scopeSchema,
} from "../../services/notificationTypes.js";

const alertGroupsRouter = Router();

/**
 * The group's DELIVERY half, validated with the automation's own schemas.
 *
 * Reusing them is the point: a group's notify action, escalation chain and
 * reminder config must be exactly the shapes `executeActions` and the
 * escalation sweep already know how to run, or a group would be a second
 * dialect of the same vocabulary — which is how the two drift.
 *
 * What is NOT here is as deliberate: no trigger, no severity bands, no reset
 * mode. Those are DETECTION and stay on the member automations.
 *
 * `scope` IS here, and is not an exception to that: it does not say what to
 * watch, it says which devices this group governs — where the fold applies and
 * therefore who delivers. A member still watches whatever its own scope says.
 */
const groupInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  // WHICH DEVICES this group governs. The automations' OWN scope schema, not a
  // second dialect: the tree is built by the same condition builder, stored in
  // the same shape and evaluated by the same `evaluateScopeCondition`, so a
  // field added to the vocabulary works here with no change at all.
  scope: scopeSchema.optional().nullable(),
  messageTemplate: z.string().max(2000).optional().nullable(),
  requireAckNote: z.boolean().optional(),
  emailComposition: emailCompositionSchema.optional().nullable(),
  actions: z.array(escalatableActionSchema).max(20).optional().nullable(),
  resetActions: z.array(actionSchema).max(20).optional().nullable(),
  escalation: z.union([escalationSchema, escalationV2Schema]).optional().nullable(),
  repeat: repeatConfigSchema.optional().nullable(),
  ruleIds: z.array(z.string().uuid()).max(50).optional(),
});

alertGroupsRouter.get("/", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try {
    res.json({ groups: await listGroups() });
  } catch (err) { next(err); }
});

/** The automation picker's source: every rule, each marked selectable or with
 *  the reason it cannot join. Ahead of `/:id` so the literal path wins. */
alertGroupsRouter.get("/joinable", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    const forGroupId = typeof req.query.groupId === "string" ? req.query.groupId : undefined;
    res.json({ rules: await listJoinableRules(forGroupId) });
  } catch (err) { next(err); }
});

alertGroupsRouter.get("/:id", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    res.json(await getGroup(req.params.id as string));
  } catch (err) { next(err); }
});

/** What deleting this group would change — live alerts, member automations,
 *  and which of them would go SILENT because the group was doing the telling. */
alertGroupsRouter.get("/:id/removal-impact", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try {
    res.json(await groupRemovalImpact(req.params.id as string));
  } catch (err) { next(err); }
});

alertGroupsRouter.post("/", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = groupInputSchema.parse(req.body);
    res.status(201).json(await createGroup(input, req.session?.username));
  } catch (err) { next(err); }
});

alertGroupsRouter.put("/:id", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    const input = groupInputSchema.parse(req.body);
    res.json(await updateGroup(req.params.id as string, input, req.session?.username));
  } catch (err) { next(err); }
});

alertGroupsRouter.delete("/:id", requirePermission("automationManagement", "fullwrite"), async (req, res, next) => {
  try {
    await deleteGroup(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default alertGroupsRouter;
