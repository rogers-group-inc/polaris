/**
 * src/services/scopeRelationIndex.ts — the SQL half of the condition tree's
 * RELATION-backed fields: `interfaceName` ("Device interface", AssetInterface)
 * and `ssid` ("Broadcast SSID", AssetApVap).
 *
 * The device-filter condition tree is evaluated in memory (an OR / NONE /
 * notAll group makes any narrowing WHERE unsound, so there is no safe superset
 * to ask the database for). Almost every field it reads is a scalar column that
 * rides the asset row for free. These two are the exceptions: `interfaceName`
 * reads AssetInterface, which at 2000 monitored devices is tens of thousands of
 * rows — an order of magnitude bigger than the fleet itself — and the
 * notification engine re-resolves every rule's scope on a 60s tick.
 *
 * So instead of joining the relation, a fleet-scale loader calls
 * `decorateRelationLeafHits(rows, trees)`: one GROUP BY per DISTINCT leaf, each
 * returning only the ids of the assets holding a matching value, then the
 * verdict is stamped onto each row as `relationLeafHits`. Port names and SSIDs
 * never reach this process, and because the answer rides the asset row there is
 * no context to thread through `scopeMatchesAsset` or the carve-out predicates.
 *
 * Both halves of a negative pair share one query: `notEquals port9` is answered
 * by "which assets HAVE an interface equal to port9", inverted — that is what
 * `positiveStringOp` / `relationLeafKey` exist for, and it is why the
 * prefetched and the in-memory paths in `matchScopeRule` cannot disagree.
 *
 * Which relation and column each field reads is declared ONCE, in
 * `RELATION_CONDITION_FIELDS` in notificationTypes.ts, so this module and the
 * single-asset joins cannot come to disagree about what `ssid` means.
 *
 * Callers: notificationEngine.loadScopeAssets (engine tick + the builder
 * preview + mass pinning, via loadScopeAssetIds) plus its carve-out pass,
 * contactService's condition preview, downDetectionService's index build. The
 * SINGLE-asset paths deliberately do not use this — they join the relation on
 * the one row instead, which is cheaper than a second round trip.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { compileWildcard } from "../utils/wildcard.js";
import {
  RELATION_CONDITION_FIELDS,
  relationLeafKey,
  positiveStringOp,
  type ScopeConditionGroup,
  type ScopeConditionRule,
} from "./notificationTypes.js";

/** The row shape decoration needs: an id to key on, and somewhere to stamp. */
export interface RelationDecoratable {
  id: string;
  relationLeafHits?: ReadonlyMap<string, boolean>;
}

type MaybeTree = ScopeConditionGroup | null | undefined;

/** Every relation-backed leaf across the given trees, deduped by prefetch key. */
function relationLeaves(trees: readonly MaybeTree[]): Map<string, ScopeConditionRule> {
  const out = new Map<string, ScopeConditionRule>();
  const walk = (g: ScopeConditionGroup): void => {
    for (const c of g.children) {
      if ("op" in c) walk(c as ScopeConditionGroup);
      else if (RELATION_CONDITION_FIELDS[(c as ScopeConditionRule).field]) {
        const rule = c as ScopeConditionRule;
        const key = relationLeafKey(rule);
        if (!out.has(key)) out.set(key, rule);
      }
    }
  };
  for (const t of trees) if (t) walk(t);
  return out;
}

/**
 * The string filter for one leaf, or null when the operator cannot be expressed
 * in SQL and the values have to be tested here.
 *
 * Only `matches` (shell wildcard) lands in the null branch, and only the wider
 * DEVICE_FILTER vocabulary offers it — an automations rule cannot produce one,
 * so the engine tick never takes that path. Even there the pattern's literal
 * prefix still narrows the read ("PLV*-61F-?" scans the PLV names, not the
 * table), which is the shape the flat criteria builder's patterns actually have.
 */
function valueWhere(rule: ScopeConditionRule): Prisma.StringFilter | null {
  const mode = "insensitive" as const;
  switch (positiveStringOp(rule.operator)) {
    case "equals": return { equals: rule.value, mode };
    case "contains": return { contains: rule.value, mode };
    case "startsWith": return { startsWith: rule.value, mode };
    case "endsWith": return { endsWith: rule.value, mode };
    default: return null;
  }
}

/** Literal head of a wildcard pattern — "" when it opens with a metacharacter. */
function wildcardPrefix(pattern: string): string {
  const cut = pattern.search(/[*?]/);
  return cut === -1 ? pattern : pattern.slice(0, cut);
}

/** The ids, among `assetIds`, of the assets satisfying one leaf positively. */
async function assetIdsForLeaf(rule: ScopeConditionRule, assetIds: string[]): Promise<Set<string>> {
  const spec = RELATION_CONDITION_FIELDS[rule.field];
  if (!spec) return new Set();
  const scope = { assetId: { in: assetIds } };

  // agentInstalled: the positive answer is "has an ACTIVE agent", whatever
  // the rule's value — matchScopeRule compares it with yes / no. One indexed
  // read of a 1:1 table (assetId @unique), at most fleet-sized.
  if (spec.relation === "managedAgent") {
    const rows = await prisma.managedAgent.findMany({
      where: { ...scope, installStatus: "active" },
      select: { assetId: true },
    });
    return new Set(rows.map((r) => r.assetId));
  }
  const where = valueWhere(rule);

  if (where) {
    // groupBy, not findMany+distinct: this has to be a real GROUP BY in the
    // database. A client-side dedupe would ship every matching row, which for a
    // broad leaf ("contains port") is the whole table — the exact cost this
    // module exists to avoid.
    const rows = spec.relation === "interfaces"
      ? await prisma.assetInterface.groupBy({ by: ["assetId"], where: { ...scope, ifName: where } })
      : await prisma.assetApVap.groupBy({ by: ["assetId"], where: { ...scope, ssid: where } });
    return new Set(rows.map((r) => r.assetId));
  }

  // Wildcard: narrow by the literal prefix, then test the compiled pattern. A
  // malformed pattern was refused at save time (makeScopeConditionSchema), so a
  // throw here can only come from a row written before that check existed —
  // match nothing rather than failing the whole preview.
  let re: RegExp;
  // Lower-cased on both sides exactly as compareString does it in the
  // evaluator — compileWildcard produces a case-SENSITIVE regex.
  try { re = compileWildcard(rule.value.toLowerCase()); } catch { return new Set(); }
  const prefix = wildcardPrefix(rule.value);
  const prefixWhere = prefix ? { startsWith: prefix, mode: "insensitive" as const } : undefined;
  const rows: { assetId: string; value: string | null }[] = spec.relation === "interfaces"
    ? (await prisma.assetInterface.findMany({
        where: { ...scope, ...(prefixWhere ? { ifName: prefixWhere } : {}) },
        select: { assetId: true, ifName: true },
      })).map((r) => ({ assetId: r.assetId, value: r.ifName }))
    : (await prisma.assetApVap.findMany({
        where: { ...scope, ...(prefixWhere ? { ssid: prefixWhere } : {}) },
        select: { assetId: true, ssid: true },
      })).map((r) => ({ assetId: r.assetId, value: r.ssid }));
  const out = new Set<string>();
  for (const r of rows) {
    if (r.value && re.test(r.value.toLowerCase())) out.add(r.assetId);
  }
  return out;
}

/**
 * Resolve the relation-backed leaves of `trees` for `rows` and stamp the
 * verdicts onto them. A no-op — no queries at all — when no tree asks about a
 * relation, so every caller can call it unconditionally.
 *
 * Decoration MERGES: the engine decorates a rule's own scope first and its
 * carve-out peers' scopes second, and the second pass must not drop the first
 * pass's answers.
 */
export async function decorateRelationLeafHits(
  rows: RelationDecoratable[],
  trees: readonly MaybeTree[],
): Promise<void> {
  if (rows.length === 0) return;
  const leaves = relationLeaves(trees);
  if (leaves.size === 0) return;

  const assetIds = rows.map((r) => r.id);
  // One query per distinct leaf, in parallel — a rule carries a handful at
  // most, and the per-leaf shape is what keeps each result at fleet size.
  const resolved = await Promise.all(
    Array.from(leaves, async ([key, rule]) => [key, await assetIdsForLeaf(rule, assetIds)] as const),
  );

  for (const row of rows) {
    const map = new Map<string, boolean>(row.relationLeafHits ?? []);
    for (const [key, ids] of resolved) map.set(key, ids.has(row.id));
    row.relationLeafHits = map;
  }
}
