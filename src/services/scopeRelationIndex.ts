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
import { compileWildcard, type PatternMatcher } from "../utils/wildcard.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { buildCidrMatcher } from "../utils/cidr.js";
import {
  RELATION_CONDITION_FIELDS,
  relationLeafKey,
  isSubnetNameLeaf,
  subnetNameLeafKey,
  positiveStringOp,
  type ScopeConditionGroup,
  type ScopeConditionRule,
} from "./notificationTypes.js";

/** The row shape decoration needs: an id to key on, and somewhere to stamp. */
export interface RelationDecoratable {
  id: string;
  /** Read by the subnet-NAME leaves. Every fleet loader already selects it
   *  (the `subnet` CIDR test reads it too); a row without the key has it
   *  fetched, so a narrower select still answers correctly. */
  ipAddress?: string | null;
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
  let re: PatternMatcher;
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
  await decorateSubnetNameHits(rows, trees);
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

// ─── Subnet-NAME leaves ───────────────────────────────────────────────────────
//
// `subnet is in subnet named "Plant-*"` asks the subnet REGISTRY, which the
// pure evaluator never sees. It rides the same stamp as the relation leaves:
// the matching subnets' CIDRs are compiled once per leaf and each row's
// address is tested against them here, so the evaluator only reads a boolean.
//
// The registry read is cached for a few seconds. The engine resolves every
// rule's scope each 60s tick and the down-detection index rebuilds on its own
// clock; a few hundred rows read once per burst rather than once per rule is
// the difference, and a subnet renamed a few seconds ago reaching rules on the
// next tick instead of this one is not.

const SUBNET_REGISTRY_TTL_MS = 10_000;
const subnetRegistry = createTtlCache<{ name: string; cidr: string }[]>({ ttlMs: SUBNET_REGISTRY_TTL_MS, maxEntries: 1 });

function subnetNameLeaves(trees: readonly MaybeTree[]): Map<string, ScopeConditionRule> {
  const out = new Map<string, ScopeConditionRule>();
  const walk = (g: ScopeConditionGroup): void => {
    for (const c of g.children) {
      if ("op" in c) walk(c as ScopeConditionGroup);
      else if (isSubnetNameLeaf(c as ScopeConditionRule)) {
        const rule = c as ScopeConditionRule;
        const key = subnetNameLeafKey(rule);
        if (!out.has(key)) out.set(key, rule);
      }
    }
  };
  for (const t of trees) if (t) walk(t);
  return out;
}

/**
 * Stamp the subnet-NAME leaves of `trees` onto `rows`. A no-op with no query
 * when no tree has one. Called by `decorateRelationLeafHits`, so every fleet
 * loader gets it for free; the SINGLE-asset paths, which join relations
 * instead of decorating, call this directly.
 */
export async function decorateSubnetNameHits(
  rows: RelationDecoratable[],
  trees: readonly MaybeTree[],
): Promise<void> {
  if (rows.length === 0) return;
  const leaves = subnetNameLeaves(trees);
  if (leaves.size === 0) return;

  const registry = await subnetRegistry.getOrCompute("", () =>
    prisma.subnet.findMany({ where: { status: { not: "deprecated" } }, select: { name: true, cidr: true } }),
  );
  const matchers = Array.from(leaves, ([key, rule]) => {
    let re: PatternMatcher | null = null;
    // Lower-cased on both sides: compileWildcard is case-sensitive. A pattern
    // the save-time check would refuse matches nothing rather than throwing.
    try { re = compileWildcard(rule.value.trim().toLowerCase()); } catch { re = null; }
    const cidrs = re ? registry.filter((s) => re!.test(s.name.toLowerCase())).map((s) => s.cidr) : [];
    return { key, inside: buildCidrMatcher(cidrs) };
  });

  // A loader whose select left the address out still gets a right answer.
  const missing = rows.filter((r) => !("ipAddress" in r)).map((r) => r.id);
  const fetched = missing.length
    ? new Map((await prisma.asset.findMany({ where: { id: { in: missing } }, select: { id: true, ipAddress: true } }))
        .map((a) => [a.id, a.ipAddress]))
    : null;

  for (const row of rows) {
    const ip = ("ipAddress" in row ? row.ipAddress : fetched?.get(row.id)) ?? "";
    const map = new Map<string, boolean>(row.relationLeafHits ?? []);
    for (const m of matchers) map.set(m.key, !!ip && m.inside(ip) !== null);
    row.relationLeafHits = map;
  }
}

/** Drop the cached registry — for tests that create subnets mid-case. */
export function invalidateSubnetRegistryCache(): void {
  subnetRegistry.invalidate();
}
