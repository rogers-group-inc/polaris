/**
 * src/services/tagRenameCarryService.ts — a renamed tag is followed everywhere
 * its NAME is stored (business rule 169).
 *
 * A tag is referenced by name, not by id. `tagRegistryService.updateTag`
 * already rewrote the name where devices carry it (blocks, networks, assets,
 * interfaces, network inheritance). It did not rewrite the places that SELECT
 * by it, so after a rename:
 *
 *   - a user's or an SSO group mapping's tag scope (`otherTags`) still held the
 *     old name, and every Read-Write user scoped to that tag silently lost the
 *     devices they could change;
 *   - a device filter with a `tag` condition — an automation, an alert group,
 *     a quiet time, a path check, another tag's own filter, a contact, an
 *     Application Map rule — stopped matching;
 *   - an interface condition narrowed by `ifTag`, and a notify action routed
 *     by `recipientTags`, pointed at nothing.
 *
 * Nothing reported any of it. This carries the new name into all of them.
 *
 * Matching is case-insensitive and whole-name, which is how every reader
 * compares (`scopeConditions` lower-cases; `interfaceTagMatch` is whole and
 * case-insensitive), so a filter typed "Critical" for a tag named "critical"
 * follows the rename too.
 *
 * A DELETE needs none of this: deleting a registry tag leaves the string on
 * the devices that carry it by hand, so the references still mean what they
 * meant.
 *
 * Called after the rename has committed. Best-effort per holder: one that
 * fails is logged and the rest still run — the rename already happened.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { jsonEqual } from "../utils/jsonEqual.js";
import { getConfig as getAppMapConfig, saveConfig as saveAppMapConfig } from "./appMapDiscoveryService.js";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `node` with every stored reference to the tag `from` renamed to `to`. Pure;
 * returns the input unchanged (same reference) when nothing names the tag.
 * Three shapes, wherever they sit in the tree:
 *   - a condition row `{ field: "tag", value: "<name>" }`;
 *   - a `recipientTags: string[]` list on a notify action;
 *   - `dimensionFilter.ifTag`, a "|"-joined list of tag names.
 */
export function rewriteTagRefs<T>(node: T, from: string, to: string, depth = 0): T {
  if (node === null || typeof node !== "object" || depth > 24) return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((n) => {
      const r = rewriteTagRefs(n, from, to, depth + 1);
      if (r !== n) changed = true;
      return r;
    });
    return (changed ? out : node) as T;
  }
  const o = node as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const set = (k: string, v: unknown) => { (out ??= { ...o })[k] = v; };

  if (o.field === "tag" && typeof o.value === "string" && same(o.value, from)) set("value", to);
  for (const [k, v] of Object.entries(o)) {
    if (k === "recipientTags" && Array.isArray(v)) {
      if (v.some((t) => typeof t === "string" && same(t, from))) {
        // Renaming onto a name already in the list must not list it twice.
        const next: unknown[] = [];
        for (const t of v) {
          const name = typeof t === "string" && same(t, from) ? to : t;
          if (!next.some((x) => typeof x === "string" && typeof name === "string" && same(x, name))) next.push(name);
        }
        set(k, next);
      }
      continue;
    }
    if (k === "ifTag" && typeof v === "string") {
      const terms = v.split("|");
      if (terms.some((t) => same(t, from))) set(k, terms.map((t) => (same(t, from) ? to : t)).join("|"));
      continue;
    }
    if (k === "value" && o.field === "tag") continue;
    const r = rewriteTagRefs(v, from, to, depth + 1);
    if (r !== v) set(k, r);
  }
  return (out ?? node) as T;
}

export interface TagRenameCarry {
  users: number;
  groupMappings: number;
  automations: number;
  alertGroups: number;
  quietTimes: number;
  pathChecks: number;
  tagFilters: number;
  contacts: number;
  appMapRules: number;
}

const RULE_COLUMNS = ["trigger", "scope", "reset", "actions", "escalation", "severityBands", "bandNotify", "resetActions", "targets", "quietTime"] as const;
const GROUP_COLUMNS = ["scope", "actions", "resetActions", "escalation"] as const;
const QUIET_COLUMNS = ["scope", "quiet"] as const;
const CHECK_COLUMNS = ["scope", "sourceFilter"] as const;
const CONDITION_COLUMN = ["assetCondition"] as const;

type Row = { id: string } & Record<string, unknown>;

/** The columns of `row` that name the tag, rewritten — or null when none does. */
function changedColumns(row: Row, columns: readonly string[], from: string, to: string): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const c of columns) {
    const before = row[c];
    if (before === null || before === undefined) continue;
    const after = rewriteTagRefs(before, from, to);
    if (after !== before && !jsonEqual(after, before)) data[c] = after;
  }
  return Object.keys(data).length > 0 ? data : null;
}

/** Rewrite one table's JSON columns; returns how many rows changed. */
async function carryTable(
  label: string,
  columns: readonly string[],
  load: () => Promise<Row[]>,
  save: (id: string, data: Record<string, unknown>) => Promise<unknown>,
  from: string,
  to: string,
): Promise<number> {
  try {
    const rows = await load();
    const writes: Promise<unknown>[] = [];
    for (const row of rows) {
      const data = changedColumns(row, columns, from, to);
      if (data) writes.push(save(row.id, data));
    }
    await Promise.all(writes);
    return writes.length;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), holder: label, from, to }, "tag rename: carrying the new name failed for one holder");
    return 0;
  }
}

const selectOf = (columns: readonly string[]) => Object.fromEntries([["id", true], ...columns.map((c) => [c, true])]);

/**
 * Carry a tag rename into everything that selects by the tag's name. The
 * tables are small configuration tables read once each; a rename is rare and
 * operator-driven, so this never runs on a tick.
 */
export async function carryTagRename(from: string, to: string): Promise<TagRenameCarry> {
  const out: TagRenameCarry = {
    users: 0, groupMappings: 0, automations: 0, alertGroups: 0, quietTimes: 0, pathChecks: 0, tagFilters: 0, contacts: 0, appMapRules: 0,
  };
  if (!from.trim() || !to.trim() || from === to) return out;

  // Tag scopes: plain string arrays. A row that already lists the new name
  // (in any spelling) drops the old one rather than list it twice.
  const scopeLists = async (label: string, load: () => Promise<Array<{ id: string; otherTags: string[] }>>, save: (id: string, otherTags: string[]) => Promise<unknown>) => {
    try {
      const rows = (await load()).filter((r) => r.otherTags.some((t) => same(t, from)));
      await Promise.all(rows.map((r) => {
        const next: string[] = [];
        for (const t of r.otherTags) {
          const name = same(t, from) ? to : t;
          if (!next.some((x) => same(x, name))) next.push(name);
        }
        return save(r.id, next);
      }));
      return rows.length;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), holder: label, from, to }, "tag rename: carrying the new name failed for one holder");
      return 0;
    }
  };
  // `isEmpty: false` keeps the read to rows that have a tag scope at all.
  const hasScope = { otherTags: { isEmpty: false } };

  [out.users, out.groupMappings, out.automations, out.alertGroups, out.quietTimes, out.pathChecks, out.tagFilters, out.contacts] = await Promise.all([
    scopeLists("users",
      () => prisma.user.findMany({ where: hasScope, select: { id: true, otherTags: true } }),
      (id, otherTags) => prisma.user.update({ where: { id }, data: { otherTags } })),
    scopeLists("group mappings",
      () => prisma.groupMapping.findMany({ where: hasScope, select: { id: true, otherTags: true } }),
      (id, otherTags) => prisma.groupMapping.update({ where: { id }, data: { otherTags } })),
    carryTable("automations", RULE_COLUMNS,
      () => prisma.notificationRule.findMany({ select: selectOf(RULE_COLUMNS) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.notificationRule.update({ where: { id }, data: data as never }), from, to),
    carryTable("alert groups", GROUP_COLUMNS,
      () => prisma.alertGroup.findMany({ select: selectOf(GROUP_COLUMNS) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.alertGroup.update({ where: { id }, data: data as never }), from, to),
    carryTable("quiet times", QUIET_COLUMNS,
      () => prisma.quietTimeSchedule.findMany({ select: selectOf(QUIET_COLUMNS) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.quietTimeSchedule.update({ where: { id }, data: data as never }), from, to),
    carryTable("path checks", CHECK_COLUMNS,
      () => prisma.pathCheck.findMany({ select: selectOf(CHECK_COLUMNS) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.pathCheck.update({ where: { id }, data: data as never }), from, to),
    carryTable("tag filters", CONDITION_COLUMN,
      () => prisma.tag.findMany({ select: selectOf(CONDITION_COLUMN) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.tag.update({ where: { id }, data: data as never }), from, to),
    carryTable("contacts", CONDITION_COLUMN,
      () => prisma.contact.findMany({ select: selectOf(CONDITION_COLUMN) as never }) as unknown as Promise<Row[]>,
      (id, data) => prisma.contact.update({ where: { id }, data: data as never }), from, to),
  ]);

  // The Application Map's rules live in one Setting blob.
  try {
    const cfg = await getAppMapConfig();
    let touched = 0;
    const rules = cfg.rules.map((rule) => {
      const scope = rewriteTagRefs(rule.scope, from, to);
      if (scope === rule.scope) return rule;
      touched += 1;
      return { ...rule, scope };
    });
    if (touched > 0) await saveAppMapConfig({ ...cfg, rules });
    out.appMapRules = touched;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), holder: "application map rules", from, to }, "tag rename: carrying the new name failed for one holder");
  }
  return out;
}

/** "3 automations, 1 user" — for the rename's Event; "" when nothing followed. */
export function summarizeTagCarry(c: TagRenameCarry): string {
  const parts: Array<[number, string, string]> = [
    [c.users, "user", "users"], [c.groupMappings, "group mapping", "group mappings"],
    [c.automations, "automation", "automations"], [c.alertGroups, "alert group", "alert groups"],
    [c.quietTimes, "quiet time", "quiet times"], [c.pathChecks, "path check", "path checks"],
    [c.tagFilters, "tag filter", "tag filters"], [c.contacts, "contact", "contacts"],
    [c.appMapRules, "Application Map rule", "Application Map rules"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(", ");
}
