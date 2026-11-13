/**
 * src/services/actionReferenceService.ts
 *
 * "What still names this?" for the two things an automation action points at
 * by id: a notification channel and an automation script (business rule 167).
 *
 * Both are plain ids inside JSON columns — no foreign key — so deleting the
 * target left the reference behind, and the automation went quiet without a
 * word: a notify action whose channel is gone delivers nothing, a script
 * action whose script is gone runs nothing. The script delete did have a
 * guard, but it looked in two of the places an action can live.
 *
 * This walks ALL of them, through the one canonical walker
 * (`allRuleActionRefs`): a rule's actions, its rule-level and per-action
 * escalation tiers, each severity band's actions and tiers, the all-clear
 * list, and reset actions with their escalation-reset overrides — on
 * automations AND alert groups, which carry the same shapes. A new action
 * location added to that walker is covered here with no change.
 *
 * Read-only. Two small reads (rules, groups); only called on a delete.
 */

import { prisma } from "../db.js";
import {
  allRuleActionRefs,
  normalizeRuleToV2,
  notifyChannelIds,
  escalatableActionSchema,
  actionSchema,
  type AutomationAction,
  type EscalatableAction,
} from "./notificationTypes.js";

/** Human label of one referrer, ready for an error message. */
export type ActionReferrer = string;

function parseList<T>(raw: unknown, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success && r.data !== undefined) out.push(r.data);
  }
  return out;
}

/**
 * Every automation and alert group with an action, in ANY location, that
 * `match` accepts. Labels read `automation "Name"` / `alert group "Name"`.
 */
export async function findActionReferrers(match: (a: AutomationAction) => boolean): Promise<ActionReferrer[]> {
  const [rules, groups] = await Promise.all([
    prisma.notificationRule.findMany({
      select: {
        name: true, trigger: true, targets: true, emailComposition: true, escalation: true, clearBehavior: true,
        clearAfterSec: true, reset: true, actions: true, severityBands: true, bandNotify: true, resetActions: true, repeat: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.alertGroup.findMany({
      select: { name: true, actions: true, resetActions: true, escalation: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const out: ActionReferrer[] = [];
  for (const r of rules) {
    // normalizeRuleToV2 folds a pre-v2 row's legacy targets into actions, so a
    // rule that has never been re-saved is still walked.
    const v2 = normalizeRuleToV2(r);
    const refs = allRuleActionRefs({
      actions: v2.actions,
      escalation: v2.escalation ?? r.escalation,
      severityBands: v2.severityBands,
      bandNotify: v2.bandNotify,
      resetActions: v2.resetActions,
    });
    if (refs.some((ref) => match(ref.action))) out.push(`automation "${r.name}"`);
  }
  for (const g of groups) {
    const refs = allRuleActionRefs({
      actions: parseList<EscalatableAction>(g.actions, escalatableActionSchema),
      escalation: g.escalation,
      resetActions: parseList<AutomationAction>(g.resetActions, actionSchema),
    });
    if (refs.some((ref) => match(ref.action))) out.push(`alert group "${g.name}"`);
  }
  return out;
}

/** Automations and alert groups with a script action running this script. */
export function scriptReferrers(scriptId: string): Promise<ActionReferrer[]> {
  return findActionReferrers((a) => a.type === "script" && a.scriptId === scriptId);
}

/**
 * Everything that would send through this channel: automations and alert
 * groups (a notify action naming it), and firmware upgrades / reboots that are
 * still booked and list it for their notices.
 */
export async function channelReferrers(channelId: string): Promise<ActionReferrer[]> {
  const [actions, upgrades, reboots] = await Promise.all([
    findActionReferrers((a) => a.type === "notify" && notifyChannelIds(a).includes(channelId)),
    prisma.firmwareUpgradeSchedule.count({ where: { status: "pending", notifyChannelIds: { has: channelId } } }),
    prisma.rebootSchedule.count({ where: { status: "pending", notifyChannelIds: { has: channelId } } }),
  ]);
  const out = [...actions];
  if (upgrades > 0) out.push(`${upgrades} scheduled firmware upgrade${upgrades === 1 ? "" : "s"}`);
  if (reboots > 0) out.push(`${reboots} scheduled reboot${reboots === 1 ? "" : "s"}`);
  return out;
}

/** The `dimensionFilter` keys that hold the id of a deletable object. */
export type DimensionTargetField = "checkId" | "widgetId" | "stateProbeId";

function namesTarget(node: unknown, fields: readonly DimensionTargetField[], ids: ReadonlySet<string>, depth = 0): boolean {
  if (!node || typeof node !== "object" || depth > 16) return false;
  if (Array.isArray(node)) return node.some((n) => namesTarget(n, fields, ids, depth + 1));
  const o = node as Record<string, unknown>;
  const df = o.dimensionFilter;
  if (df && typeof df === "object") {
    for (const f of fields) {
      const v = (df as Record<string, unknown>)[f];
      if (typeof v === "string" && ids.has(v)) return true;
    }
  }
  return Object.values(o).some((v) => namesTarget(v, fields, ids, depth + 1));
}

/**
 * Automations with a condition narrowed to one of these objects (business
 * rule 167(a)): a path check (`checkId`), a numeric custom widget (`widgetId`)
 * or a state probe (`stateProbeId`). The stored trigger and reset are walked
 * as plain JSON, to any depth, rather than through a schema: a condition can
 * sit at the top, inside a composite tree or under a reset condition, and a
 * row that no longer parses still names what it names.
 */
export async function dimensionTargetReferrers(
  fields: readonly DimensionTargetField[],
  ids: readonly string[],
): Promise<ActionReferrer[]> {
  // A blank filter means "every check"; it names nothing.
  const want = new Set(ids.filter(Boolean));
  if (want.size === 0) return [];
  const rules = await prisma.notificationRule.findMany({
    select: { name: true, trigger: true, reset: true },
    orderBy: { name: "asc" },
  });
  return rules
    .filter((r) => namesTarget(r.trigger, fields, want) || namesTarget(r.reset, fields, want))
    .map((r) => `automation "${r.name}"`);
}

/** One thing an automation names that no longer exists (business rule 177). */
export interface BrokenReference {
  kind: "channel" | "script" | "pathCheck" | "widget" | "stateProbe";
  /** A sentence for the operator: where it is and what it means. */
  message: string;
}

type BrokenRuleRow = {
  id: string;
  trigger: unknown;
  reset: unknown;
  actions: unknown;
  escalation?: unknown;
  severityBands?: unknown;
  bandNotify?: unknown;
  resetActions?: unknown;
  targets?: unknown;
  emailComposition?: unknown;
  clearBehavior?: unknown;
  clearAfterSec?: unknown;
  repeat?: unknown;
};

const DIM_KINDS: Record<DimensionTargetField, "pathCheck" | "widget" | "stateProbe"> = {
  checkId: "pathCheck", widgetId: "widget", stateProbeId: "stateProbe",
};

/** Every id a condition is narrowed to, by field, anywhere in a stored tree. */
function collectDimensionIds(node: unknown, out: Map<DimensionTargetField, Set<string>>, depth = 0): void {
  if (!node || typeof node !== "object" || depth > 16) return;
  if (Array.isArray(node)) { for (const n of node) collectDimensionIds(n, out, depth + 1); return; }
  const o = node as Record<string, unknown>;
  const df = o.dimensionFilter;
  if (df && typeof df === "object") {
    for (const f of Object.keys(DIM_KINDS) as DimensionTargetField[]) {
      const v = (df as Record<string, unknown>)[f];
      if (typeof v === "string" && v) out.get(f)!.add(v);
    }
  }
  for (const v of Object.values(o)) collectDimensionIds(v, out, depth + 1);
}

/** "Action 1" / "Rule escalation tier 2" / "critical band action 1" → sentence case. */
function sentenceStart(label: string): string {
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "An action";
}

/**
 * Business rule 177: for each automation, what it names that no longer exists —
 * a delivery channel or automation script in ANY action location, or a path
 * check, custom widget or state probe a condition is narrowed to. The delete
 * guards (rule 167, 167(a)) stop new ones; this is how the ones made before
 * them, or in a way the guards cannot see (a restore, a SQL edit, an import),
 * are pointed out instead of doing nothing silently.
 *
 * Read-only, and only what the rows reference is looked up: one `IN` read per
 * kind of object, never per automation. Rows whose stored actions no longer
 * parse are walked as far as they parse.
 */
export async function brokenReferencesByRule(rules: readonly BrokenRuleRow[]): Promise<Map<string, BrokenReference[]>> {
  const out = new Map<string, BrokenReference[]>();
  if (rules.length === 0) return out;

  type Found = { label: string; id: string };
  const perRule = rules.map((r) => {
    const channels: Found[] = [];
    const scripts: Found[] = [];
    try {
      const v2 = normalizeRuleToV2(r as never);
      const refs = allRuleActionRefs({
        actions: v2.actions,
        escalation: v2.escalation ?? (r.escalation as never),
        severityBands: v2.severityBands,
        bandNotify: v2.bandNotify,
        resetActions: v2.resetActions,
      });
      for (const ref of refs) {
        const a = ref.action as AutomationAction;
        if (a.type === "notify") for (const id of notifyChannelIds(a)) channels.push({ label: ref.label, id });
        if (a.type === "script" && a.scriptId) scripts.push({ label: ref.label, id: a.scriptId });
      }
    } catch { /* a row that no longer normalizes: nothing to point at here */ }
    const dims = new Map<DimensionTargetField, Set<string>>(
      (Object.keys(DIM_KINDS) as DimensionTargetField[]).map((f) => [f, new Set<string>()]),
    );
    collectDimensionIds(r.trigger, dims);
    collectDimensionIds(r.reset, dims);
    return { id: r.id, channels, scripts, dims };
  });

  const all = <T>(pick: (p: (typeof perRule)[number]) => T[]) => [...new Set(perRule.flatMap(pick))];
  const channelIds = all((p) => p.channels.map((c) => c.id));
  const scriptIds = all((p) => p.scripts.map((c) => c.id));
  const checkIds = all((p) => [...p.dims.get("checkId")!]);
  const widgetIds = all((p) => [...p.dims.get("widgetId")!, ...p.dims.get("stateProbeId")!]);
  const ids = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
  const [liveChannels, liveScripts, liveChecks, liveWidgets] = await Promise.all([
    channelIds.length ? prisma.notificationChannel.findMany({ where: { id: { in: channelIds } }, select: { id: true } }).then(ids) : new Set<string>(),
    scriptIds.length ? prisma.automationScript.findMany({ where: { id: { in: scriptIds } }, select: { id: true } }).then(ids) : new Set<string>(),
    checkIds.length ? prisma.pathCheck.findMany({ where: { id: { in: checkIds } }, select: { id: true } }).then(ids) : new Set<string>(),
    widgetIds.length ? prisma.manufacturerCustomWidget.findMany({ where: { id: { in: widgetIds } }, select: { id: true } }).then(ids) : new Set<string>(),
  ]);

  for (const p of perRule) {
    const found: BrokenReference[] = [];
    const seen = new Set<string>();
    const add = (b: BrokenReference) => { if (!seen.has(b.message)) { seen.add(b.message); found.push(b); } };
    for (const c of p.channels) if (!liveChannels.has(c.id)) add({ kind: "channel", message: `${sentenceStart(c.label)} sends to a delivery channel that was deleted, so it sends nothing through it.` });
    for (const c of p.scripts) if (!liveScripts.has(c.id)) add({ kind: "script", message: `${sentenceStart(c.label)} runs an automation script that was deleted, so it runs nothing.` });
    for (const id of p.dims.get("checkId")!) if (!liveChecks.has(id)) add({ kind: "pathCheck", message: "A condition watches a path check that was deleted, so it matches nothing." });
    for (const id of p.dims.get("widgetId")!) if (!liveWidgets.has(id)) add({ kind: "widget", message: "A condition reads a custom widget that was deleted, so it matches nothing." });
    for (const id of p.dims.get("stateProbeId")!) if (!liveWidgets.has(id)) add({ kind: "stateProbe", message: "A condition reads a state probe that was deleted, so it matches nothing." });
    if (found.length) out.set(p.id, found);
  }
  return out;
}

/**
 * The automations list's rows, each carrying `brokenReferences` (empty when
 * nothing is broken). The list route's one call.
 */
export async function withBrokenReferences<T extends BrokenRuleRow>(rules: T[]): Promise<Array<T & { brokenReferences: BrokenReference[] }>> {
  const broken = await brokenReferencesByRule(rules);
  return rules.map((r) => ({ ...r, brokenReferences: broken.get(r.id) ?? [] }));
}

/** "a, b, c, … (+N more)" — the list an error message can carry. */
export function summarizeReferrers(refs: readonly ActionReferrer[], max = 5): string {
  const shown = refs.slice(0, max).join(", ");
  return refs.length > max ? `${shown}, … (+${refs.length - max} more)` : shown;
}
