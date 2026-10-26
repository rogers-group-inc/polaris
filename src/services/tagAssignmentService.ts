/**
 * src/services/tagAssignmentService.ts
 *
 * Filter-based tag auto-assignment ("managed sync"). A Tag may carry a device
 * filter; when present, this service keeps the tag applied to exactly the set of
 * assets that match it — adding the tag to newly matching assets and removing it
 * from assets that have drifted out of match.
 *
 * FILTER SHAPE. `Tag.assetCondition` — the SAME nested AND/OR condition tree the
 * automations device filter and the address book store — superseded the flat
 * `Tag.criteria` blob, so operators are not asked "which devices?" in two
 * different languages. Both columns are still READ (a row written before the
 * cutover keeps matching through the flat predicate until it folds forward) but
 * only one is ever live on a row: a write of the condition nulls the criteria.
 * Readers go through `tagFilterOf`, `criteriaToCondition` is the fold-forward,
 * and the migrateTagFilterShape one-shot persists it. The Contact
 * assetCriteria -> assetCondition cutover is the precedent throughout.
 *
 * Two asymmetries with contacts, both load-bearing:
 *   - An EMPTY tree is NO FILTER here, never "all devices". A contact stores
 *     `and([])` deliberately, as the form of an explicit All-devices checkbox; a
 *     tag has no such control, so an empty tree could only arrive from a
 *     half-built form and reading it as "every asset" would tag the whole fleet
 *     on save. normalizeTagCondition collapses it to null.
 *   - A DECOMMISSIONED device is ineligible unless the filter mentions status.
 *     Carried over from the flat criteria's buildPrefilterWhere, where it was
 *     implicit; stated explicitly for the tree (tagEligibilityWhere) because an
 *     upgrade must not silently start tagging retired inventory.
 *
 * Collision defense (two layers, so manual operator tagging is never clobbered):
 *   1. Owned-tag allowlist — only tags whose `criteria` is non-null are ever
 *      touched. A purely manual tag is invisible to this engine.
 *   2. Per-asset provenance — `TagAutoAssignment` records every (tag, asset)
 *      pair the engine applied. The engine strips a tag from an asset ONLY when
 *      a provenance row exists. A hand-applied copy of the same tag name on an
 *      asset the engine never tagged (no provenance) is preserved forever.
 *
 * PORTS (business rule 133). A tag whose filter asserts a native VLAN
 * (`nativeVlan equals 30` — positiveNativeVlans) is also applied to the PORTS
 * of each matched device whose native VLAN is one of those, as `auto` rows in
 * AssetInterfaceTag with `tagId` as provenance. The device itself matches
 * through the same leaf, which is what "a switch with a port on VLAN 30
 * inherits the tag" means. Every reconciler below runs both halves; the port
 * half only ever adds or removes `auto` rows carrying its own tagId, and never
 * lands on a port already holding the tag by hand.
 *
 * Reconcile entry points:
 *   - reconcileTag(tagId)         — one tag, full diff (inline on tag create/edit)
 *   - reconcileAllTags()          — every managed tag (periodic job + discovery-end)
 *   - reconcileTagsForAsset(id)   — one asset vs. all managed tags (asset-write hook)
 *   - previewTagFilter(...)       — dry-run match count + diff for the editor UI
 *
 * Modeled on mapRegionService (add/remove tag primitives + diff-based
 * reconcile) and autoMonitorInterfacesService (resolver → preview →
 * batched apply, compileWildcard for patterns).
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { compileWildcard } from "./autoMonitorInterfacesService.js";
import { isValidCidr, isValidIpAddress } from "../utils/cidr.js";
import { isKnownAssetType, normalizeAssetTypeName } from "../utils/assetTypes.js";
import { criteriaToCondition } from "../utils/criteriaToCondition.js";
import {
  conditionFields,
  conditionNeedsInterfaces,
  deviceFilterConditionSchema,
  evaluateScopeCondition,
  positiveNativeVlans,
  scopeConditionStats,
  SCOPE_CONDITION_MAX_DEPTH,
  SCOPE_CONDITION_MAX_RULES,
  type ScopeConditionAsset,
  type ScopeConditionGroup,
} from "./notificationTypes.js";
import { deviceFilterSelect, resolveDeviceFilterAssetIds } from "./deviceFilterService.js";
import { decorateSubnetNameHits, type RelationDecoratable } from "./scopeRelationIndex.js";
import { randomTagColor } from "./mapRegionService.js";
import { AZURE_TAG_PREFIX, AZURE_TAG_CATEGORY } from "../utils/tagNormalize.js";

// ─── Criteria shape ──────────────────────────────────────────────────────────

/** Free-string asset columns; support exact / contains / pattern operators. */
const STRING_FIELDS = [
  "manufacturer",
  "model",
  "os",
  "osVersion",
  "hostname",
  "department",
  "location",
] as const;

/** Enum-ish columns; exact-only (validated against their domains). */
const ENUM_FIELDS = ["assetType", "status"] as const;

/**
 * Relation-backed fields — matched against discovery provenance rather than an
 * Asset column. `integration` (exact-only; values are Integration ids) matches
 * assets the integration discovered (`discoveredByIntegrationId` OR any
 * AssetSource row). `fortigate` (string ops) matches assets "behind" a
 * FortiGate by device name — `learnedLocation` OR any AssetFortigateSighting.
 */
const RELATION_FIELDS = ["integration", "fortigate"] as const;

const STRING_OPS = ["exact", "contains", "pattern"] as const;

const ASSET_STATUSES = [
  "active",
  "maintenance",
  "decommissioned",
  "storage",
  "disabled",
  "quarantined",
] as const;

type StringField = (typeof STRING_FIELDS)[number];
type EnumField = (typeof ENUM_FIELDS)[number];
type StringOp = (typeof STRING_OPS)[number];

export interface StringRule {
  field: StringField | EnumField;
  op: StringOp;
  values: string[];
}
export interface SubnetRule {
  field: "subnet";
  op: "inCidr";
  cidrs: string[];
}
/** Discovered-by integration; values are Integration ids. */
export interface IntegrationRule {
  field: "integration";
  op: "exact";
  values: string[];
}
/** "Behind FortiGate" by device name (learnedLocation + DHCP sightings). */
export interface FortigateRule {
  field: "fortigate";
  op: StringOp;
  values: string[];
}
export type CriteriaRule = StringRule | SubnetRule | IntegrationRule | FortigateRule;

export interface TagCriteria {
  version: 1;
  /** Rules are ANDed. "any" is reserved for a future change; not yet emitted. */
  match: "all";
  rules: CriteriaRule[];
}

function isSubnetRule(rule: CriteriaRule): rule is SubnetRule {
  return rule.field === "subnet";
}

const MAX_RULES = 25;
const MAX_VALUES_PER_RULE = 50;

/**
 * Validate + normalize an operator-supplied criteria blob. Returns a clean
 * TagCriteria, or null when there are no usable rules (treated as "no criteria"
 * — i.e. an ordinary manual tag). Throws AppError(400) on malformed input.
 */
export function normalizeCriteria(raw: unknown): TagCriteria | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(400, "criteria must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const rulesIn = Array.isArray(obj.rules) ? obj.rules : [];
  if (rulesIn.length > MAX_RULES) {
    throw new AppError(400, `criteria cannot have more than ${MAX_RULES} rules`);
  }

  const rules: CriteriaRule[] = [];
  for (const r of rulesIn) {
    if (!r || typeof r !== "object") throw new AppError(400, "Each rule must be an object");
    const rule = r as Record<string, unknown>;
    const field = String(rule.field ?? "").trim();

    if (field === "subnet") {
      const cidrsIn = Array.isArray(rule.cidrs) ? rule.cidrs : [];
      const cidrs = Array.from(
        new Set(cidrsIn.map((c) => String(c).trim()).filter((c) => c.length > 0)),
      );
      if (cidrs.length === 0) continue; // empty rule → drop
      if (cidrs.length > MAX_VALUES_PER_RULE) {
        throw new AppError(400, `A subnet rule cannot have more than ${MAX_VALUES_PER_RULE} CIDRs`);
      }
      for (const c of cidrs) {
        if (!isValidCidr(c)) throw new AppError(400, `Invalid CIDR "${c}"`);
      }
      rules.push({ field: "subnet", op: "inCidr", cidrs });
      continue;
    }

    const isString = (STRING_FIELDS as readonly string[]).includes(field);
    const isEnum = (ENUM_FIELDS as readonly string[]).includes(field);
    const isRelation = (RELATION_FIELDS as readonly string[]).includes(field);
    if (!isString && !isEnum && !isRelation) throw new AppError(400, `Unknown criteria field "${field}"`);

    const op = String(rule.op ?? "exact").trim();
    if ((isEnum || field === "integration") && op !== "exact") {
      throw new AppError(400, `Field "${field}" supports only the "exact" operator`);
    }
    if ((isString || field === "fortigate") && !(STRING_OPS as readonly string[]).includes(op)) {
      throw new AppError(400, `Unknown operator "${op}" for field "${field}"`);
    }

    const valuesIn = Array.isArray(rule.values) ? rule.values : [];
    let values = Array.from(
      new Set(valuesIn.map((v) => String(v).trim()).filter((v) => v.length > 0)),
    );
    if (values.length === 0) continue; // empty rule → drop
    if (values.length > MAX_VALUES_PER_RULE) {
      throw new AppError(400, `A rule cannot have more than ${MAX_VALUES_PER_RULE} values`);
    }

    if (field === "assetType") {
      for (const v of values) {
        if (!isKnownAssetType(v)) throw new AppError(400, `Unknown asset type "${v}"`);
      }
      values = values.map((v) => normalizeAssetTypeName(v));
    } else if (field === "status") {
      values = values.map((v) => v.toLowerCase());
      for (const v of values) {
        if (!(ASSET_STATUSES as readonly string[]).includes(v)) {
          throw new AppError(400, `Unknown status "${v}"`);
        }
      }
    } else if (op === "pattern") {
      // Validate each wildcard compiles (throws AppError(400) on bad pattern).
      for (const v of values) compileWildcard(v);
    }

    rules.push({ field, op, values } as StringRule | IntegrationRule | FortigateRule);
  }

  if (rules.length === 0) return null;
  return { version: 1, match: "all", rules };
}

// ─── Filter shape: condition tree (current) + flat criteria (legacy) ─────────

/**
 * The ONE filter a tag auto-assigns by. A stored condition wins; otherwise a
 * legacy flat blob is folded forward on the fly, so every consumer sees a tree
 * whether or not the row has been rewritten yet — and a blob the tree can't
 * express (an `integration` rule, which only an API caller could have written,
 * the builder having never offered it) keeps matching through the flat predicate
 * instead of being half-converted. `contactFilterOf` is the same function for
 * the address book.
 */
export interface TagFilter {
  condition: ScopeConditionGroup | null;
  criteria: TagCriteria | null;
}

export function tagFilterOf(tag: {
  assetCondition?: unknown;
  criteria?: unknown;
}): TagFilter {
  const stored = safeStoredCondition(tag.assetCondition);
  if (stored) return { condition: stored, criteria: null };
  const criteria = normalizeCriteria(tag.criteria ?? null);
  if (!criteria) return { condition: null, criteria: null };
  const { condition, unconvertible } = criteriaToCondition(criteria);
  return unconvertible.length > 0
    ? { condition: null, criteria }
    : { condition: condition as ScopeConditionGroup | null, criteria: null };
}

/**
 * One tag as the tag registry UI reads it. Beyond the stored columns it carries
 * the fold-forward, so the editor can open a tag still on the LEGACY flat shape
 * in the condition builder with its rules intact rather than showing it as
 * unfiltered (which is what "just send the columns" would have done, and the
 * operator's next save would then have silently cleared a live filter).
 */
export interface TagFilterView {
  /** The stored tree — null on a row that has not folded forward yet. */
  assetCondition: ScopeConditionGroup | null;
  /** What the builder should EDIT: the stored tree, else the fold of the flat
   *  blob. Null means the tag genuinely has no filter. */
  assetConditionEffective: ScopeConditionGroup | null;
  /** Non-empty when a legacy blob could NOT be folded (an `integration` rule).
   *  The filter still applies through the flat predicate; the editor says so and
   *  carries it through the save untouched. */
  assetFilterUnconvertible: string[];
}

export function tagFilterView(tag: { assetCondition?: unknown; criteria?: unknown }): TagFilterView {
  const stored = safeStoredCondition(tag.assetCondition);
  if (stored) {
    return { assetCondition: stored, assetConditionEffective: stored, assetFilterUnconvertible: [] };
  }
  const criteria = normalizeCriteria(tag.criteria ?? null);
  if (!criteria) {
    return { assetCondition: null, assetConditionEffective: null, assetFilterUnconvertible: [] };
  }
  const { condition, unconvertible } = criteriaToCondition(criteria);
  return {
    assetCondition: null,
    assetConditionEffective: unconvertible.length > 0 ? null : (condition as ScopeConditionGroup | null),
    assetFilterUnconvertible: unconvertible,
  };
}

/** Does this tag auto-assign at all? — the managed-tag allowlist (layer 1 of
 *  the collision defense in the header). A tag with neither column set is
 *  invisible to this engine. */
export function tagIsManaged(tag: { assetCondition?: unknown; criteria?: unknown }): boolean {
  return tag.assetCondition != null || tag.criteria != null;
}

/**
 * Validate a POSTED condition tree against the DEVICE_FILTER vocabulary (the
 * automations scope fields plus the four the flat builder carried, so nothing
 * the old builder could say is lost).
 *
 * An empty tree collapses to null — "no filter", i.e. an ordinary manual tag.
 * It is emphatically NOT "all assets": `and([])` is true for every asset by
 * boolean identity, so honoring it would apply the tag to the entire fleet, and
 * the only way to reach it through the UI is an Auto-assign toggle switched on
 * with nothing built underneath it.
 */
export function normalizeTagCondition(raw: unknown): ScopeConditionGroup | null {
  if (raw == null) return null;
  const parsed = deviceFilterConditionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AppError(400, `Device filter is invalid${first ? `: ${first.message}` : ""}`);
  }
  const cond = parsed.data;
  const { depth, rules } = scopeConditionStats(cond);
  if (depth > SCOPE_CONDITION_MAX_DEPTH) {
    throw new AppError(400, `Device filter groups nest at most ${SCOPE_CONDITION_MAX_DEPTH} deep`);
  }
  if (rules > SCOPE_CONDITION_MAX_RULES) {
    throw new AppError(400, `At most ${SCOPE_CONDITION_MAX_RULES} conditions per device filter`);
  }
  return rules === 0 ? null : cond;
}

/**
 * Re-validate a STORED tree on read. A shape written before a vocabulary change
 * would otherwise reach the matcher unvalidated; one that no longer validates
 * drops to null (the tag falls back to manual) rather than throwing, because a
 * single bad row must not 500 the tag list or wedge the reconcile job.
 */
function safeStoredCondition(raw: unknown): ScopeConditionGroup | null {
  if (raw == null) return null;
  const parsed = deviceFilterConditionSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issue: parsed.error.issues[0]?.message }, "tagAssignment: stored device filter no longer validates — treating the tag as manual");
    return null;
  }
  const { rules } = scopeConditionStats(parsed.data);
  return rules === 0 ? null : parsed.data;
}

/**
 * Which devices a tag filter may touch AT ALL, ANDed outside the filter itself.
 *
 * Decommissioned assets are excluded unless the filter explicitly mentions
 * status — the flat criteria's `buildPrefilterWhere` has always done this, and
 * the tree path has to state it or the shape cutover would quietly begin
 * auto-tagging retired inventory. Kept as an outer AND (rather than folded into
 * the tree) so it stays sound under `or` / `none` / `notAll` groups.
 */
function tagEligibilityWhere(cond: ScopeConditionGroup): Prisma.AssetWhereInput | undefined {
  return conditionFields(cond).has("status") ? undefined : { status: { not: "decommissioned" } };
}

/** Is this ONE asset eligible for auto-tagging by this filter? The single-asset
 *  counterpart of tagEligibilityWhere — same rule, tested in memory. */
function tagAssetIsEligible(cond: ScopeConditionGroup, status: string | null | undefined): boolean {
  if (conditionFields(cond).has("status")) return true;
  return String(status ?? "") !== "decommissioned";
}

/** Every asset id a tag filter currently covers, whichever shape it is in. */
export async function resolveTagFilterAssetIds(filter: TagFilter): Promise<Set<string>> {
  if (filter.condition) {
    return resolveDeviceFilterAssetIds(filter.condition, { where: tagEligibilityWhere(filter.condition) });
  }
  if (filter.criteria) return resolveMatchingAssetIds(filter.criteria);
  return new Set<string>();
}

// ─── DB-side prefilter (must be a SUPERSET of the in-memory predicate) ────────

/** Leading literal run of a wildcard, before the first `*`/`?`. "" if none. */
function literalPrefix(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*" || ch === "?") break;
    out += ch;
  }
  return out;
}

/**
 * Build a Prisma where-clause that returns a SUPERSET of matching assets, so we
 * never load the whole fleet when criteria are narrow. Critically it must never
 * be TIGHTER than the predicate — subnet rules and prefixless patterns are
 * predicate-only (contribute no DB narrowing). Decommissioned assets are
 * excluded unless the criteria explicitly target `status`.
 */
export function buildPrefilterWhere(criteria: TagCriteria): Prisma.AssetWhereInput {
  const ands: Prisma.AssetWhereInput[] = [];
  let hasStatusRule = false;

  for (const rule of criteria.rules) {
    if (isSubnetRule(rule)) continue; // predicate-only

    if (rule.field === "integration") {
      // Exact id match against either provenance surface — this IS the full
      // predicate, so it's trivially a safe superset.
      ands.push({
        OR: [
          { discoveredByIntegrationId: { in: rule.values } },
          { sources: { some: { integrationId: { in: rule.values } } } },
        ],
      });
      continue;
    }
    if (rule.field === "fortigate") {
      // Superset = OR across BOTH haystacks (learnedLocation + sighting rows)
      // for every value; narrowing on only one surface would drop rows the
      // predicate matches via the other.
      if (rule.op === "pattern") {
        const prefixes = rule.values.map(literalPrefix);
        if (prefixes.every((p) => p.length > 0)) {
          ands.push({
            OR: prefixes.flatMap((p) => [
              { learnedLocation: { startsWith: p, mode: "insensitive" } },
              { fortigateSightings: { some: { fortigateDevice: { startsWith: p, mode: "insensitive" } } } },
            ]),
          });
        }
      } else {
        const cmp = rule.op === "exact" ? "equals" : "contains";
        ands.push({
          OR: rule.values.flatMap((v) => [
            { learnedLocation: { [cmp]: v, mode: "insensitive" } } as Prisma.AssetWhereInput,
            { fortigateSightings: { some: { fortigateDevice: { [cmp]: v, mode: "insensitive" } } } } as Prisma.AssetWhereInput,
          ]),
        });
      }
      continue;
    }

    const col = rule.field;
    if (col === "status") hasStatusRule = true;

    const ors: Prisma.AssetWhereInput[] = [];

    if (col === "status") {
      // Enum column — exact only, no `mode`. Values pre-validated to enum domain.
      for (const v of rule.values) ors.push({ status: { equals: v as any } });
    } else if (rule.op === "exact") {
      for (const v of rule.values) ors.push({ [col]: { equals: v, mode: "insensitive" } } as any);
    } else if (rule.op === "contains") {
      for (const v of rule.values) ors.push({ [col]: { contains: v, mode: "insensitive" } } as any);
    } else if (rule.op === "pattern") {
      // A pattern OR is only a safe superset if EVERY value yields a literal
      // prefix. If any value is prefixless, the prefix-OR would drop rows that
      // value could match — so we skip DB narrowing for this rule entirely.
      const prefixes = rule.values.map(literalPrefix);
      if (prefixes.every((p) => p.length > 0)) {
        for (const p of prefixes) ors.push({ [col]: { startsWith: p, mode: "insensitive" } } as any);
      }
    }

    if (ors.length > 0) ands.push(ors.length === 1 ? ors[0]! : { OR: ors });
  }

  if (!hasStatusRule) ands.push({ status: { not: "decommissioned" } });
  return ands.length === 0 ? {} : { AND: ands };
}

// ─── Subnet/CIDR membership (inet containment, family-aware) ──────────────────

const CANDIDATE_SELECT = {
  id: true,
  ipAddress: true,
  manufacturer: true,
  model: true,
  os: true,
  osVersion: true,
  hostname: true,
  department: true,
  location: true,
  assetType: true,
  status: true,
} satisfies Prisma.AssetSelect;

// Relation-backed extras loaded only when the criteria reference them (see
// buildCandidateSelect) — optional on the type so scalar-only paths stay lean.
type CandidateAsset = Prisma.AssetGetPayload<{ select: typeof CANDIDATE_SELECT }> & {
  discoveredByIntegrationId?: string | null;
  sources?: Array<{ integrationId: string | null }>;
  learnedLocation?: string | null;
  fortigateSightings?: Array<{ fortigateDevice: string }>;
};

/**
 * CANDIDATE_SELECT plus EVERY relation extra — for single-asset predicate paths
 * (one asset vs. many criteria), where computing the union of each criteria's
 * field needs costs more than the joins do at n=1. Exported so other services
 * that evaluate criteria against one asset (contactService) select exactly what
 * the matcher reads instead of hand-maintaining a parallel list.
 */
export const SINGLE_ASSET_CANDIDATE_SELECT = {
  ...CANDIDATE_SELECT,
  discoveredByIntegrationId: true,
  sources: { select: { integrationId: true } },
  learnedLocation: true,
  fortigateSightings: { select: { fortigateDevice: true } },
} satisfies Prisma.AssetSelect;

/**
 * CANDIDATE_SELECT plus the relation extras the criteria actually need.
 * Conditional so the bulk reconcile path doesn't join sources/sightings for
 * every asset when no rule references them (2000-asset scale rule).
 */
function buildCandidateSelect(criteria: TagCriteria): Prisma.AssetSelect {
  const has = (f: string) => criteria.rules.some((r) => r.field === f);
  return {
    ...CANDIDATE_SELECT,
    ...(has("integration")
      ? { discoveredByIntegrationId: true, sources: { select: { integrationId: true } } }
      : {}),
    ...(has("fortigate")
      ? { learnedLocation: true, fortigateSightings: { select: { fortigateDevice: true } } }
      : {}),
  };
}

/**
 * For each given IP, the set of input CIDRs that contain it. One round-trip via
 * the Postgres inet `>>=` operator. JS pre-filters null/invalid IPs so the cast
 * can't throw; `>>=` across address families is simply false (no error), so v4
 * and v6 CIDRs can be mixed freely. Returned CIDR strings are the exact input
 * strings, so callers can match them against rule.cidrs without normalization.
 */
async function cidrContainmentMap(
  ips: Array<string | null>,
  cidrs: string[],
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const distinctIps = Array.from(
    new Set(ips.filter((ip): ip is string => !!ip && isValidIpAddress(ip))),
  );
  const validCidrs = Array.from(new Set(cidrs.filter((c) => isValidCidr(c))));
  if (distinctIps.length === 0 || validCidrs.length === 0) return out;

  const rows = await prisma.$queryRaw<Array<{ ip: string; cidr: string }>>`
    WITH input_ips(ip) AS (SELECT unnest(${distinctIps}::text[])),
         crit(cidr)    AS (SELECT unnest(${validCidrs}::text[]))
    SELECT i.ip AS ip, c.cidr AS cidr
    FROM input_ips i
    JOIN crit c ON c.cidr::cidr >>= i.ip::inet
  `;
  for (const r of rows) {
    let set = out.get(r.ip);
    if (!set) {
      set = new Set<string>();
      out.set(r.ip, set);
    }
    set.add(r.cidr);
  }
  return out;
}

/**
 * The subset of `cidrs` that contain `ip` — the `matchedCidrs` argument
 * `assetMatchesCriteria` expects. One inet round-trip, and none at all when the
 * criteria carry no subnet rules (the common case), so a single-asset match
 * costs zero extra queries unless someone actually filtered by subnet.
 */
export async function cidrsContainingIp(
  ip: string | null,
  cidrs: string[],
): Promise<Set<string>> {
  if (!ip || cidrs.length === 0) return new Set<string>();
  const map = await cidrContainmentMap([ip], cidrs);
  return map.get(ip) ?? new Set<string>();
}

/** Every CIDR referenced by the criteria's subnet rules. */
export function collectCidrs(criteria: TagCriteria): string[] {
  const cidrs: string[] = [];
  for (const rule of criteria.rules) if (isSubnetRule(rule)) cidrs.push(...rule.cidrs);
  return cidrs;
}

/**
 * Every distinct tag currently applied to an asset — the value list behind a
 * `tag` picker in either device-filter builder. Same computation the
 * `GET /assets/tags` route does inline; here so a route that isn't allowed to
 * assume `assets:read` (the address book's filter schema) doesn't have to reach
 * for a second gated endpoint or grow inline Prisma of its own.
 */
export async function listAssetTags(): Promise<string[]> {
  const rows = await prisma.asset.findMany({
    // MONITORED devices only — the same reasoning as listScopeOptions: a tag
    // that only unmonitored inventory carries is a filter value that can't
    // produce a metric alert. (`GET /assets/tags`, which feeds the assets-page
    // filter rather than a builder, deliberately keeps its own unfiltered read.)
    where: { monitored: true, NOT: { tags: { isEmpty: true } } },
    select: { tags: true },
  });
  const set = new Set<string>();
  for (const r of rows) for (const t of r.tags) set.add(t);
  return Array.from(set).sort();
}

// ─── Matcher (pure predicate) ─────────────────────────────────────────────────

type CidrMatch = (ip: string | null, cidrs: string[]) => boolean;

/**
 * Compile criteria into a predicate over a candidate asset. Wildcards compile
 * once (not per-asset). Subnet rules defer to the supplied `cidrMatch` so the
 * bulk and single-asset paths can each provide their own containment lookup.
 */
function buildMatcher(
  criteria: TagCriteria,
  cidrMatch: CidrMatch,
): (asset: CandidateAsset) => boolean {
  const checks = criteria.rules.map((rule): ((a: CandidateAsset) => boolean) => {
    if (isSubnetRule(rule)) {
      const cidrs = rule.cidrs;
      return (a) => cidrMatch(a.ipAddress, cidrs);
    }
    if (rule.field === "integration") {
      const ids = new Set(rule.values);
      return (a) =>
        (a.discoveredByIntegrationId != null && ids.has(a.discoveredByIntegrationId)) ||
        (a.sources ?? []).some((s) => s.integrationId != null && ids.has(s.integrationId));
    }
    if (rule.field === "fortigate") {
      const haystacks = (a: CandidateAsset): string[] => {
        const out: string[] = [];
        if (a.learnedLocation) out.push(a.learnedLocation.toLowerCase());
        for (const s of a.fortigateSightings ?? []) out.push(s.fortigateDevice.toLowerCase());
        return out;
      };
      if (rule.op === "pattern") {
        const regexes = rule.values.map((v) => compileWildcard(v.toLowerCase()));
        return (a) => haystacks(a).some((h) => regexes.some((rx) => rx.test(h)));
      }
      const needles = rule.values.map((v) => v.toLowerCase());
      if (rule.op === "contains") {
        return (a) => haystacks(a).some((h) => needles.some((n) => h.includes(n)));
      }
      return (a) => haystacks(a).some((h) => needles.some((n) => h === n));
    }
    const col = rule.field as keyof CandidateAsset;
    if (rule.op === "pattern") {
      const regexes = rule.values.map((v) => compileWildcard(v.toLowerCase()));
      return (a) => {
        const val = String((a as any)[col] ?? "").toLowerCase();
        return regexes.some((rx) => rx.test(val));
      };
    }
    const needles = rule.values.map((v) => v.toLowerCase());
    if (rule.op === "contains") {
      return (a) => {
        const val = String((a as any)[col] ?? "").toLowerCase();
        return needles.some((n) => val.includes(n));
      };
    }
    // exact
    return (a) => {
      const val = String((a as any)[col] ?? "").toLowerCase();
      return needles.some((n) => val === n);
    };
  });
  return (a) => checks.every((fn) => fn(a));
}

/**
 * Pure predicate over a single asset — for unit testing without a DB. Subnet
 * rules match when one of their CIDRs is in `matchedCidrs` (which a caller would
 * normally compute via the inet query). Mirrors exactly the predicate used by
 * the bulk + single-asset reconcile paths.
 */
export function assetMatchesCriteria(
  asset: Partial<CandidateAsset>,
  criteria: TagCriteria,
  matchedCidrs: Set<string> = new Set<string>(),
): boolean {
  const cidrMatch: CidrMatch = (_ip, ruleCidrs) => ruleCidrs.some((c) => matchedCidrs.has(c));
  return buildMatcher(criteria, cidrMatch)(asset as CandidateAsset);
}

/**
 * Resolve the full set of asset IDs currently matching the criteria. Prefilter
 * in the DB → compute subnet membership over the candidates → run the predicate.
 */
export async function resolveMatchingAssetIds(criteria: TagCriteria): Promise<Set<string>> {
  const candidates: CandidateAsset[] = await prisma.asset.findMany({
    where: buildPrefilterWhere(criteria),
    select: buildCandidateSelect(criteria),
  }) as CandidateAsset[];
  const cidrs = collectCidrs(criteria);
  const map = cidrs.length
    ? await cidrContainmentMap(candidates.map((c) => c.ipAddress), cidrs)
    : new Map<string, Set<string>>();
  const cidrMatch: CidrMatch = (ip, ruleCidrs) =>
    !!ip && ruleCidrs.some((c) => map.get(ip)?.has(c) ?? false);

  const matcher = buildMatcher(criteria, cidrMatch);
  const out = new Set<string>();
  for (const a of candidates) if (matcher(a)) out.add(a.id);
  return out;
}

// ─── Tag + provenance write primitives ────────────────────────────────────────

const BATCH = 50;

/**
 * Apply a tag-name add/remove delta to assets' `tags[]` arrays AND keep the
 * provenance table in lockstep. Idempotent: only writes assets whose array
 * actually changes; batches the updates in chunks of BATCH inside transactions.
 */
async function applyDelta(
  tagId: string,
  tagName: string,
  toAdd: string[],
  toRemove: string[],
): Promise<void> {
  const touched = Array.from(new Set([...toAdd, ...toRemove]));
  if (touched.length > 0) {
    const addSet = new Set(toAdd);
    const removeSet = new Set(toRemove);
    const rows = await prisma.asset.findMany({
      where: { id: { in: touched } },
      select: { id: true, tags: true },
    });
    const updates: { id: string; tags: string[] }[] = [];
    for (const row of rows) {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      if (addSet.has(row.id) && !tags.includes(tagName)) {
        updates.push({ id: row.id, tags: [...tags, tagName] });
      } else if (removeSet.has(row.id) && tags.includes(tagName)) {
        updates.push({ id: row.id, tags: tags.filter((t) => t !== tagName) });
      }
    }
    for (const chunk of chunkArray(updates, BATCH)) {
      await prisma.$transaction(
        chunk.map((u) => prisma.asset.update({ where: { id: u.id }, data: { tags: u.tags } })),
      );
    }
  }

  // Provenance: insert the engine-owned pairs we added, drop the ones we removed.
  if (toAdd.length > 0) {
    await prisma.tagAutoAssignment.createMany({
      data: toAdd.map((assetId) => ({ tagId, assetId })),
      skipDuplicates: true,
    });
  }
  if (toRemove.length > 0) {
    await prisma.tagAutoAssignment.deleteMany({
      where: { tagId, assetId: { in: toRemove } },
    });
  }
}

// ─── Port (interface) tag primitives — business rule 133 ─────────────────────

/** One port, as AssetInterfaceTag keys it. */
interface PortRef {
  assetId: string;
  ifName: string;
}

const portKey = (p: PortRef): string => p.assetId + "\u0000" + p.ifName;

/**
 * The ports a tag filter applies its tag to: every port on a VLAN the tree
 * asserts (positiveNativeVlans) of a device in `assetIds` — the devices the
 * same filter matched. Empty for a tree with no such leaf, which is every tag
 * that was a device-only tag before this rule.
 *
 * Queried by VLAN, not by device: a broad filter can match most of the fleet,
 * and an IN list of 2000 asset ids against the largest current-state table is
 * the shape to avoid. A handful of VLAN ids narrows it instead, and the device
 * set is applied here.
 */
async function expectedTaggedPorts(
  cond: ScopeConditionGroup | null,
  assetIds: ReadonlySet<string>,
): Promise<PortRef[]> {
  const vlans = positiveNativeVlans(cond);
  if (vlans.length === 0 || assetIds.size === 0) return [];
  const rows = await prisma.assetInterface.findMany({
    where: { nativeVlan: { in: vlans } },
    select: { assetId: true, ifName: true },
  });
  return rows.filter((r) => assetIds.has(r.assetId));
}

/** How many ports a tag filter would tag — the preview's second count. */
export async function countTaggedPorts(
  cond: ScopeConditionGroup | null,
  assetIds: ReadonlySet<string>,
): Promise<number> {
  return (await expectedTaggedPorts(cond, assetIds)).length;
}

/**
 * Diff one tag's ports against what is stored and write the difference.
 *
 * `rows` is every AssetInterfaceTag row carrying the tag's NAME within the
 * caller's scope (the whole fleet, or one asset). Ours are the `auto` rows with
 * this tagId; any other row — a manual one, or another tag's of the same name —
 * OCCUPIES its port, so we neither add there nor ever remove it. Idempotent:
 * no write when nothing differs.
 */
async function applyPortDelta(
  tagId: string,
  tagName: string,
  expected: PortRef[],
  rows: { assetId: string; ifName: string; source: string; tagId: string | null }[],
): Promise<{ added: number; removed: number }> {
  const ours = new Map<string, PortRef>();
  const occupied = new Set<string>();
  for (const r of rows) {
    occupied.add(portKey(r));
    if (r.source === "auto" && r.tagId === tagId) ours.set(portKey(r), r);
  }
  const want = new Set(expected.map(portKey));
  const toAdd = expected.filter((p) => !occupied.has(portKey(p)));
  const toRemove = [...ours.values()].filter((p) => !want.has(portKey(p)));

  if (toAdd.length > 0) {
    await prisma.assetInterfaceTag.createMany({
      data: toAdd.map((p) => ({ assetId: p.assetId, ifName: p.ifName, tag: tagName, source: "auto", tagId })),
      skipDuplicates: true,
    });
  }
  for (const chunk of chunkArray(toRemove, BATCH)) {
    await prisma.assetInterfaceTag.deleteMany({
      where: {
        tagId,
        source: "auto",
        OR: chunk.map((p) => ({ assetId: p.assetId, ifName: p.ifName })),
      },
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

// ─── Reconcilers ──────────────────────────────────────────────────────────────

export interface TagReconcileSummary extends Record<string, unknown> {
  tagId?: string;
  added: number;
  removed: number;
  /** Ports the tag was added to / removed from (business rule 133). */
  portsAdded?: number;
  portsRemoved?: number;
}

/**
 * Reconcile one tag. If it has no filter (manual tag, or the filter was just
 * cleared), strip every engine-owned copy and exit. Otherwise diff expected
 * vs. provenance and apply the add/remove delta.
 */
export async function reconcileTag(tagId: string): Promise<TagReconcileSummary> {
  const tag = await prisma.tag.findUnique({ where: { id: tagId } });
  if (!tag) return { tagId, added: 0, removed: 0 };

  const filter = tagFilterOf(tag);
  const provRows = await prisma.tagAutoAssignment.findMany({
    where: { tagId },
    select: { assetId: true },
  });
  const currentIds = new Set(provRows.map((p) => p.assetId));

  const expectedIds = await resolveTagFilterAssetIds(filter);

  const toAdd = [...expectedIds].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !expectedIds.has(id));

  if (toAdd.length > 0 || toRemove.length > 0) {
    await applyDelta(tagId, tag.name, toAdd, toRemove);
  }

  // The port half. The rows are read by NAME as well as by tagId: a port that
  // already holds the tag by hand is occupied, and an auto row is ours by tagId
  // even if a rename has not reached its `tag` column yet.
  const [expectedPorts, portRows] = await Promise.all([
    expectedTaggedPorts(filter.condition, expectedIds),
    prisma.assetInterfaceTag.findMany({
      where: { OR: [{ tag: tag.name }, { tagId }] },
      select: { assetId: true, ifName: true, source: true, tagId: true },
    }),
  ]);
  const ports = await applyPortDelta(tagId, tag.name, expectedPorts, portRows);

  return {
    tagId,
    added: toAdd.length,
    removed: toRemove.length,
    portsAdded: ports.added,
    portsRemoved: ports.removed,
  };
}

/** Reconcile every managed (filter-bearing) tag. Periodic + discovery-end. */
export async function reconcileAllTags(): Promise<TagReconcileSummary> {
  const tags = await prisma.tag.findMany({ select: { id: true, criteria: true, assetCondition: true } });
  const managed = tags.filter(tagIsManaged);
  let added = 0;
  let removed = 0;
  let portsAdded = 0;
  let portsRemoved = 0;
  for (const t of managed) {
    try {
      const s = await reconcileTag(t.id);
      added += s.added;
      removed += s.removed;
      portsAdded += s.portsAdded ?? 0;
      portsRemoved += s.portsRemoved ?? 0;
    } catch (err: any) {
      logger.debug(
        { err: err?.message ?? String(err), tagId: t.id },
        "tagAssignment: reconcileTag failed (non-fatal)",
      );
    }
  }
  // Auto port rows whose tag no longer auto-assigns (deleted, or its filter
  // cleared by a path that did not reconcile inline). Ours by provenance, so
  // removing them never touches a hand-applied port tag.
  try {
    const orphaned = await prisma.assetInterfaceTag.deleteMany({
      where: { source: "auto", NOT: { tagId: { in: managed.map((t) => t.id) } } },
    });
    portsRemoved += orphaned.count;
  } catch (err: any) {
    logger.debug({ err: err?.message ?? String(err) }, "tagAssignment: orphaned port-tag sweep failed (non-fatal)");
  }
  return { added, removed, portsAdded, portsRemoved };
}

/**
 * Fast path for asset-write hooks: evaluate ONE asset against every managed
 * tag, diff its provenance, and write once. O(#managed tags), one extra inet
 * round-trip for all subnet CIDRs across the tags still on the LEGACY shape
 * (a tree does its own CIDR math in memory, so a fleet that has folded forward
 * makes no extra query at all).
 */
export async function reconcileTagsForAsset(assetId: string): Promise<TagReconcileSummary> {
  const tags = await prisma.tag.findMany({
    select: { id: true, name: true, criteria: true, assetCondition: true },
  });
  const managed = tags
    .map((t) => ({ id: t.id, name: t.name, filter: tagFilterOf(t) }))
    .filter((t) => t.filter.condition != null || t.filter.criteria != null);
  if (managed.length === 0) return { added: 0, removed: 0 };

  // Single asset — always load the legacy matcher's relation extras rather than
  // computing the union of every tag's field needs (trivial cost at n=1). The
  // tree half adds `tags` (the condition vocabulary has a `tag` field, which the
  // flat one never had) and joins the interface inventory only when some filter
  // actually asks about it — this runs on every asset write.
  const conditions = managed.map((t) => t.filter.condition);
  const asset: CandidateAsset | null = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      ...SINGLE_ASSET_CANDIDATE_SELECT,
      ...deviceFilterSelect(conditions, {
        needsInterfaces: conditions.some((c) => conditionNeedsInterfaces(c)),
      }),
    },
  }) as CandidateAsset | null;
  if (!asset) return { added: 0, removed: 0 };
  // Subnet-NAME leaves read the registry; a no-op (no query) without one.
  await decorateSubnetNameHits([asset as unknown as RelationDecoratable], conditions);

  // One containment lookup for this asset's IP across every LEGACY tag's CIDRs.
  const allCidrs = managed.flatMap((t) => (t.filter.criteria ? collectCidrs(t.filter.criteria) : []));
  const map = allCidrs.length
    ? await cidrContainmentMap([asset.ipAddress], allCidrs)
    : new Map<string, Set<string>>();
  const cidrMatch: CidrMatch = (ip, ruleCidrs) =>
    !!ip && ruleCidrs.some((c) => map.get(ip)?.has(c) ?? false);

  const prov = await prisma.tagAutoAssignment.findMany({
    where: { assetId },
    select: { tagId: true },
  });
  const provSet = new Set(prov.map((p) => p.tagId));

  // Apply per-tag delta. Each tag touches at most this one asset, so a per-tag
  // applyDelta call is bounded and cheap (managed tag counts are small).
  let added = 0;
  let removed = 0;
  const matched = new Set<string>();
  for (const t of managed) {
    const matches = t.filter.condition
      ? tagAssetIsEligible(t.filter.condition, asset.status) &&
        evaluateScopeCondition(t.filter.condition, asset as unknown as ScopeConditionAsset)
      : buildMatcher(t.filter.criteria as TagCriteria, cidrMatch)(asset);
    if (matches) matched.add(t.id);
    if (matches && !provSet.has(t.id)) {
      await applyDelta(t.id, t.name, [assetId], []);
      added++;
    } else if (!matches && provSet.has(t.id)) {
      await applyDelta(t.id, t.name, [], [assetId]);
      removed++;
    }
  }

  const ports = await reconcilePortTagsForAsset(assetId, managed, matched);
  return { added, removed, portsAdded: ports.added, portsRemoved: ports.removed };
}

/**
 * The port half of reconcileTagsForAsset: this asset's ports against every
 * managed tag, given which of those tags the asset itself matched. No query at
 * all when no managed tag tags ports and the asset carries no auto port row —
 * the common case, and this runs on asset writes.
 */
async function reconcilePortTagsForAsset(
  assetId: string,
  managed: { id: string; name: string; filter: TagFilter }[],
  matched: ReadonlySet<string>,
): Promise<{ added: number; removed: number }> {
  const portTags = managed
    .map((t) => ({ ...t, vlans: positiveNativeVlans(t.filter.condition) }))
    .filter((t) => t.vlans.length > 0);
  const rows = await prisma.assetInterfaceTag.findMany({
    where: { assetId },
    select: { assetId: true, ifName: true, tag: true, source: true, tagId: true },
  });
  const managedIds = new Set(portTags.map((t) => t.id));
  const strayAuto = rows.filter((r) => r.source === "auto" && (!r.tagId || !managedIds.has(r.tagId)));
  if (portTags.length === 0 && strayAuto.length === 0) return { added: 0, removed: 0 };

  const ifaces = portTags.length > 0
    ? await prisma.assetInterface.findMany({
        where: { assetId, nativeVlan: { not: null } },
        select: { ifName: true, nativeVlan: true },
      })
    : [];

  let added = 0;
  let removed = 0;
  for (const t of portTags) {
    const vlans = new Set(t.vlans);
    const expected = matched.has(t.id)
      ? ifaces.filter((i) => i.nativeVlan != null && vlans.has(i.nativeVlan)).map((i) => ({ assetId, ifName: i.ifName }))
      : [];
    const d = await applyPortDelta(t.id, t.name, expected, rows.filter((r) => r.tag === t.name || r.tagId === t.id));
    added += d.added;
    removed += d.removed;
  }
  // An auto row whose tag no longer tags ports (its filter lost the VLAN leaf,
  // or the tag is gone): ours by provenance, so it goes.
  if (strayAuto.length > 0) {
    await prisma.assetInterfaceTag.deleteMany({
      where: {
        assetId,
        source: "auto",
        OR: strayAuto.map((r) => ({ ifName: r.ifName, tag: r.tag })),
      },
    });
    removed += strayAuto.length;
  }
  return { added, removed };
}

// ─── Preview (dry-run for the editor UI) ──────────────────────────────────────

export interface TagFilterPreview {
  matchCount: number;
  /** Ports the tag would land on — non-zero only for a filter asserting a
   *  native VLAN (business rule 133). */
  portCount: number;
  sample: Array<{ id: string; hostname: string | null; ipAddress: string | null; assetType: string }>;
  diff?: { add: number; remove: number };
}

/**
 * Dry-run: how many assets a device filter matches, a small sample, and (when a
 * tagId is given) the +add / -remove delta vs. that tag's current provenance.
 * Writes nothing. Accepts EITHER shape — the condition tree the builder posts,
 * or a flat criteria blob from an older caller — so the editor and any stored
 * row preview through one path.
 */
export async function previewTagFilter(
  input: { condition?: unknown; criteria?: unknown },
  tagId?: string,
): Promise<TagFilterPreview> {
  const condition = normalizeTagCondition(input.condition ?? null);
  const filter: TagFilter = condition
    ? { condition, criteria: null }
    : { condition: null, criteria: normalizeCriteria(input.criteria ?? null) };

  if (!filter.condition && !filter.criteria) {
    return { matchCount: 0, portCount: 0, sample: [], diff: tagId ? { add: 0, remove: 0 } : undefined };
  }

  const expected = await resolveTagFilterAssetIds(filter);
  const portCount = await countTaggedPorts(filter.condition, expected);
  const sampleIds = [...expected].slice(0, 25);
  const sample = sampleIds.length
    ? await prisma.asset.findMany({
        where: { id: { in: sampleIds } },
        select: { id: true, hostname: true, ipAddress: true, assetType: true },
        orderBy: { hostname: "asc" },
      })
    : [];

  let diff: { add: number; remove: number } | undefined;
  if (tagId) {
    const prov = await prisma.tagAutoAssignment.findMany({
      where: { tagId },
      select: { assetId: true },
    });
    const current = new Set(prov.map((p) => p.assetId));
    let add = 0;
    let remove = 0;
    for (const id of expected) if (!current.has(id)) add++;
    for (const id of current) if (!expected.has(id)) remove++;
    diff = { add, remove };
  }

  return { matchCount: expected.size, portCount, sample, diff };
}

/** Strip all engine-owned copies of a tag (used on tag delete) — assets AND
 *  ports. Returns the number of ASSETS it was removed from; hand-applied copies
 *  on either are untouched. */
export async function stripTagAssignments(tagId: string, tagName: string): Promise<number> {
  await prisma.assetInterfaceTag.deleteMany({ where: { tagId, source: "auto" } });
  const provRows = await prisma.tagAutoAssignment.findMany({
    where: { tagId },
    select: { assetId: true },
  });
  const ids = provRows.map((p) => p.assetId);
  if (ids.length === 0) return 0;
  await applyDelta(tagId, tagName, [], ids);
  return ids.length;
}

/**
 * The tag REGISTRY as a picker needs it — every row's name, category and
 * colour, plus the enforce flag that decides whether the picker may offer an
 * "add new tag" row at all.
 *
 * Its own function, and its own route above the `/server-settings` gate,
 * because the tag picker is rendered by every form that can tag something —
 * the asset edit form, blocks, subnets — and NONE of those roles need
 * `serverSettingsSystem`. Reading the catalogue through the registry's own
 * `GET /server-settings/tags` meant every non-admin role (`user`,
 * `assetsadmin`, `networkadmin`, `readonly` — all seeded
 * `serverSettingsSystem: "none"`) 403'd on it, and `_ensureTagCache` swallows
 * the failure, so the picker rendered "No tags defined yet" at an install with
 * a full registry and the operator's only way to tag a device was to type a
 * new tag (which then 403'd on create).
 *
 * Deliberately LEAN rather than the registry read with a lower gate: a Tag row
 * also carries `assetCondition` / `criteria`, the auto-assignment device
 * filter, which is registry-management detail and stays behind the
 * management gate. What a picker needs is what an asset row already shows
 * anyone holding `assets:read`.
 */
export async function listTagCatalog(): Promise<{
  enforce: boolean;
  tags: { id: string; name: string; category: string; color: string }[];
}> {
  const [tags, settings] = await Promise.all([
    prisma.tag.findMany({
      orderBy: [{ category: "asc" }, { name: "asc" }],
      select: { id: true, name: true, category: true, color: true },
    }),
    prisma.setting.findUnique({ where: { key: "tagSettings" } }),
  ]);
  const value = (settings?.value ?? null) as { enforce?: unknown } | null;
  return { enforce: value?.enforce === true, tags };
}

/**
 * Keep the Tag registry's `azure:` rows in step with Asset.tags, so the
 * mirrored tags show in the pickers and filters like any other tag, and a
 * row no asset carries any more disappears on its own.
 *
 * The registry is the Arc sync's alone: operators can neither edit nor delete
 * an `azure:` row (PUT / DELETE /server-settings/tags/:id refuse), so this is
 * the only remover. Read from the assets rather than from one run's machines,
 * because the registry is global and a second Arc integration may own other
 * `azure:` tags: a name is added when some asset carries it and removed when
 * none does. Called at the end of every Arc run, after an asset delete, and
 * on the periodic tag-reconcile tick (the catch for asset deletes by merge and
 * for an Arc integration that no longer runs). One DISTINCT unnest over
 * assets — trivial at 2000 rows. Best-effort: never throws.
 */
export async function syncAzureTagRegistry(): Promise<{ added: number; removed: number }> {
  try {
    const rows = await prisma.$queryRaw<{ t: string }[]>`
      SELECT DISTINCT t FROM assets, unnest(tags) AS t WHERE t LIKE ${AZURE_TAG_PREFIX + "%"}`;
    const names = rows.map((r) => r.t);
    let added = 0;
    if (names.length > 0) {
      const res = await prisma.tag.createMany({
        data: names.map((name) => ({ name, category: AZURE_TAG_CATEGORY, color: randomTagColor() })),
        skipDuplicates: true,
      });
      added = res.count;
    }
    const { count: removed } = await prisma.tag.deleteMany({
      where: { name: { startsWith: AZURE_TAG_PREFIX, notIn: names } },
    });
    return { added, removed };
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, "Azure tag registry sync failed (non-fatal)");
    return { added: 0, removed: 0 };
  }
}
