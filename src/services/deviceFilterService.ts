/**
 * src/services/deviceFilterService.ts
 *
 * Resolving a device-filter CONDITION TREE against inventory — the shared half
 * of the "which devices?" question, extracted so every surface that asks it
 * resolves it identically.
 *
 * Three surfaces store the same tree over the same vocabulary
 * (DEVICE_FILTER_FIELD_OPS): an automation's `scope.condition`, a contact's
 * `assetCondition`, and — since the tag-criteria cutover — a tag's
 * `assetCondition`. Automations resolve theirs inside the engine, where the
 * tree rides a scope that also carries flat dimensions and the read is shaped
 * by the tick's own select. The other two want the plain answer: the SET of
 * asset ids this tree currently covers. That answer lived privately in
 * contactService until tags needed the identical thing, at which point a second
 * copy would have been two places for the relation-join decisions below to
 * drift apart.
 *
 * Deliberately NO SQL prefilter for the tree itself. An `or` / `none` /
 * `notAll` group makes any narrowing WHERE unsound, and unlike the flat
 * criteria — whose rules are always ANDed, which is what lets
 * tagAssignmentService.buildPrefilterWhere exist — there is no safe superset to
 * ask the DB for. The cost is one findMany of scalar columns, operator- or
 * reconcile-triggered rather than per tick.
 *
 * Both relation-backed fields are conditional, which is the whole reason this
 * is a function rather than a constant select:
 *   - `fortigate` joins the sighting relation, the expensive half at 2000
 *     assets, and only when a rule actually asks about the gate.
 *   - `interfaceName` is resolved in SQL to per-asset verdicts by
 *     scopeInterfaceIndex rather than joined at all — the interface inventory
 *     dwarfs the fleet. No interface leaf ⇒ no query.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import {
  conditionFields,
  evaluateScopeCondition,
  type ScopeConditionAsset,
  type ScopeConditionGroup,
} from "./notificationTypes.js";
import { decorateRelationLeafHits } from "./scopeRelationIndex.js";

/**
 * The scalar columns the condition evaluator reads. Covers the DEVICE_FILTER
 * superset (osVersion / department / location on top of the automations scope
 * fields) — a caller validating against the narrower SCOPE_FIELD_OPS simply
 * can't produce trees that read the extras, so there is nothing to gate.
 */
const DEVICE_FILTER_SCALAR_SELECT = {
  id: true,
  assetType: true,
  manufacturer: true,
  model: true,
  hostname: true,
  os: true,
  osVersion: true,
  department: true,
  location: true,
  status: true,
  ipAddress: true,
  tags: true,
} satisfies Prisma.AssetSelect;

/**
 * DEVICE_FILTER_SCALAR_SELECT plus whichever relations the given trees ask
 * about. `interfaceName` is absent on purpose — it is prefetched in SQL by
 * `decorateRelationLeafHits`, not joined (see the header).
 *
 * Exported because the SINGLE-asset paths (a tag or contact tested against one
 * triggering / just-written asset) select the same fields and must not
 * hand-maintain a parallel list. At n=1 the interface relation IS worth
 * joining, which is what `needsInterfaces` is for — a second round trip would
 * cost more than the rows do.
 */
export function deviceFilterSelect(
  conditions: Array<ScopeConditionGroup | null | undefined>,
  opts?: { needsInterfaces?: boolean },
): Prisma.AssetSelect {
  const fields = new Set<string>();
  for (const cond of conditions) {
    if (!cond) continue;
    for (const f of conditionFields(cond)) fields.add(f);
  }
  return {
    ...DEVICE_FILTER_SCALAR_SELECT,
    ...(fields.has("fortigate")
      ? { learnedLocation: true, fortigateSightings: { select: { fortigateDevice: true } } }
      : {}),
    ...(opts?.needsInterfaces ? { interfaces: { select: { ifName: true } } } : {}),
    // The second relation-backed field. Derived from the tree rather than
    // from an opts flag the way `interfaces` is: every caller that reaches
    // here already handed us the conditions, and one more hand-passed flag is
    // one more place for a caller to forget it and get a silently
    // never-matching filter.
    ...(fields.has("ssid") ? { apVaps: { select: { ssid: true } } } : {}),
    // The third relation-backed field, derived from the tree the same way.
    ...(fields.has("agentInstalled") ? { managedAgent: { select: { installStatus: true } } } : {}),
  };
}

export interface ResolveDeviceFilterOptions {
  /**
   * An extra WHERE ANDed OUTSIDE the tree — for a caller-owned rule about which
   * devices are eligible at all, never for narrowing derived from the tree
   * (which would be unsound; see the header).
   *
   * The one caller today is tag auto-assignment, which excludes decommissioned
   * devices unless the filter mentions status — carried over from the flat
   * criteria's `buildPrefilterWhere`, because an upgrade must not silently start
   * tagging retired inventory.
   */
  where?: Prisma.AssetWhereInput;
}

/**
 * The asset ids a condition tree covers right now.
 *
 * An EMPTY tree is the caller's problem, not this function's: `and([])` is true
 * for every asset by boolean identity, so it resolves to the whole (eligible)
 * fleet. Contacts mean exactly that by it — it is the stored form of their
 * All-devices checkbox. Tags must never store it, and `normalizeTagCondition`
 * is what guarantees they can't.
 */
export async function resolveDeviceFilterAssetIds(
  cond: ScopeConditionGroup,
  opts?: ResolveDeviceFilterOptions,
): Promise<Set<string>> {
  const rows = await prisma.asset.findMany({
    ...(opts?.where ? { where: opts.where } : {}),
    select: deviceFilterSelect([cond]),
  });
  await decorateRelationLeafHits(rows, [cond]);
  const out = new Set<string>();
  for (const row of rows) {
    if (evaluateScopeCondition(cond, row as ScopeConditionAsset)) out.add(row.id);
  }
  return out;
}
