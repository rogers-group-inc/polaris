/**
 * src/utils/assetTypeMatch.ts
 *
 * The device-type INFERENCE layer: which discovery-time facts land a device in
 * which `AssetTypeDef` bucket. Pure (no DB imports) so the discovery engine,
 * the Network Discovery adopter and the preview endpoint all run the same
 * decision, and so a unit test can exercise it without a database.
 *
 * The rules are a **nested AND/OR condition tree** — the same grammar the
 * automations device filter stores (`op` ∈ and/or/none/notAll over children
 * that are either a leaf or another group), edited in the same shared
 * `PolarisConditionBuilder` widget. It was a flat ANY-of clause list until
 * 2026-09: that was a faithful transcription of the `||` ladders this layer
 * replaced, but it meant an operator who wanted "a Windows box that is NOT a
 * server" had to express it as one regex, and it made Polaris carry two
 * condition dialects that looked alike and behaved differently in the same
 * settings page. The stored shape converges; the EVALUATOR does not, and
 * cannot — see "Why the evaluator stays separate" below.
 *
 * Two things this deliberately is NOT:
 *
 *  - **It is not how every device gets its type.** A FortiSwitch discovered
 *    from its controller's CMDB *is* a switch, and a vCenter host *is* a
 *    hypervisor — those are identity, read off an authoritative source, and
 *    they stay hardcoded. Rules only decide the cases where Polaris would
 *    otherwise be guessing from a text field. `AUTHORITATIVE_TYPE_SOURCES`
 *    below is the catalogue the Device Types card renders so an operator can
 *    see which buckets their rules cannot affect and why.
 *
 *  - **It is not retroactive.** The resolver answers about ONE device's facts
 *    at the moment discovery sees them. Re-typing existing inventory after a
 *    rule edit is a separate, explicit operator action (see
 *    `assetTypeService.applyMatchRules`), bounded to assets currently sitting
 *    in `other` — the same guard the discovery engine has always applied
 *    before re-typing an existing asset.
 *
 * Contexts exist because the two hardcoded predicates this replaces asked
 * different questions of different inputs. `inferAssetTypeFromOs` read an OS
 * string from a directory record and could only answer server / workstation /
 * other; `assetTypeForHit` read a scanned device's own self-description and
 * could answer firewall / switch / access_point / router / printer. Merging
 * them into one rule set would have silently started typing AD computers
 * "printer" off an OS string, so each type declares which contexts its rules
 * run in and the seed migration reproduces the old split exactly.
 *
 * ── Why the evaluator stays separate ──────────────────────────────────────
 *
 * `evaluateScopeCondition` (notificationTypes.ts) filters ASSET ROWS: stored
 * columns, tags, regions, CIDR containment, joined relations. These rules
 * match FACTS about a device that has no Asset row yet — a scan hit, a
 * directory record mid-sync — over a vocabulary of raw strings. Two
 * consequences that must not be smoothed over just because one widget now
 * edits both:
 *
 *  - The FIELD sets are disjoint on purpose. There is no `tag`, `subnet`,
 *    `status` or `assetType` at inference time; there is a `chassis` string
 *    and an `any`-of-the-facts pseudo-field that mean nothing to an Asset row.
 *
 *  - **An ABSENT fact never matches, either polarity.** In a device filter,
 *    `notContains "x"` on a NULL column is satisfied (the column plainly does
 *    not contain it). Here it is NOT: at discovery time a missing fact means
 *    *not yet known*, so letting absence satisfy a negation is how one silent
 *    field outage re-types a fleet. That is the one place an operator can read
 *    the same row in two builders and get two answers, so both the field
 *    labels and the card's own prose say it.
 */

import { clampRegexSubject } from "./regexSafety.js";
import { safeRegexProblem, tryCompileSafeRegex } from "./safeRegex.js";

/** Facts a source can offer the resolver. Every field is optional. */
export interface AssetTypeFacts {
  os?: string | null;
  osVersion?: string | null;
  hostname?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  /** Entra / Intune chassis type ("desktop", "laptop", "tablet", …). */
  chassis?: string | null;
  /**
   * The vendor's OWN words for what the device is — "Network Camera",
   * "Bullet Camera" — parsed out of a documented sysDescr format
   * (`utils/snmpDescrIdentity.ts`) and stored on `Asset.productType`.
   *
   * The precise field for typing equipment that a directory has never heard
   * of. Before it existed, the only place that phrase appeared was inside the
   * raw sysDescr in `os`, so a camera rule had to be a regex over the whole
   * self-description — which also reads `hostname`, and therefore typed an
   * NVR called CAMERA-NVR-01 as a camera.
   */
  productType?: string | null;
}

export const MATCH_FIELDS = [
  "any",
  "os",
  "osVersion",
  "hostname",
  "manufacturer",
  "model",
  "chassis",
  "productType",
] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

/**
 * Leaf operators. The six that overlap the device-filter vocabulary carry its
 * spelling and its labels (`startsWith`, not `starts_with`) — two identifiers
 * for one operator in one builder is how a copied rule stops behaving the same
 * — and the negative twins exist because negation has to live ON THE LEAF: a
 * `none` group around a leaf would let an absent fact satisfy the negation,
 * which is exactly what this layer refuses to do.
 *
 * `regex` / `notRegex` have no device-filter counterpart (that vocabulary has
 * `matches`, a shell-style wildcard, and a different compiler behind it), so
 * they keep their own names rather than colliding on a familiar one.
 *
 * The ORDER differs from the device filter's, deliberately: `contains` leads,
 * because the shared builder defaults a new row to the first operator offered
 * and every fact here is a free-text vendor string. "Windows Server 2019
 * Datacenter" never EQUALS "server", so an `equals` default would hand every
 * new rule an operator that silently matches nothing. Only the names and the
 * labels are a shared contract; the order is each vocabulary's own.
 */
export const MATCH_OPS = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
  "regex",
  "notRegex",
] as const;
export type MatchOp = (typeof MATCH_OPS)[number];

/**
 * Pre-2026-09 operator spellings, still present in every row the seed
 * migration wrote. Folded on READ (`normalizeMatchRules`), never migrated:
 * the fold is total and lossless, so a one-shot rewrite would buy nothing an
 * operator could observe. A row keeps the old spelling in the database until
 * the next save from the editor.
 */
const LEGACY_OP_ALIASES: Readonly<Record<string, MatchOp>> = {
  starts_with: "startsWith",
  ends_with: "endsWith",
};

/** The negative twin of each operator, and how to get back to the positive. */
const NEGATIVE_OF: Readonly<Record<string, MatchOp>> = {
  equals: "notEquals",
  contains: "notContains",
  startsWith: "notStartsWith",
  endsWith: "notEndsWith",
  regex: "notRegex",
};
const POSITIVE_OF: Readonly<Record<string, MatchOp>> = Object.fromEntries(
  Object.entries(NEGATIVE_OF).map(([pos, neg]) => [neg, pos as MatchOp]),
) as Record<string, MatchOp>;

/** Does this operator assert the ABSENCE of a match? */
export function isNegativeMatchOp(op: string): boolean {
  return Object.prototype.hasOwnProperty.call(POSITIVE_OF, op);
}

/** The positive form of an operator (itself, when already positive). */
export function positiveMatchOp(op: string): string {
  return POSITIVE_OF[op] ?? op;
}

/**
 * Group operators — the same four the device filter uses, with the same
 * boolean identities (`none` = ¬or, `notAll` = ¬and), so a nested tree reads
 * identically in both builders.
 */
export const MATCH_GROUP_OPS = ["and", "or", "none", "notAll"] as const;
export type MatchGroupOp = (typeof MATCH_GROUP_OPS)[number];

export const MATCH_CONTEXTS = ["directory", "scan"] as const;
export type MatchContext = (typeof MATCH_CONTEXTS)[number];

/**
 * One leaf. `operator`, not `op`, deliberately: it is the device filter's own
 * leaf key, so the shared builder renders and collects these rows with no
 * translation layer — and it keeps a leaf's operator distinguishable from a
 * GROUP's `op` in a tree where both kinds of node sit in one `children` array.
 * The pre-2026-09 rows spell it `op`; `normalizeMatchRules` folds them.
 */
export interface MatchClause {
  field: MatchField;
  operator: MatchOp;
  value: string;
}

export interface MatchGroup {
  op: MatchGroupOp;
  children: MatchNode[];
}

export type MatchNode = MatchClause | MatchGroup;

/**
 * A type's stored rules: one root group. The name is historical — the column
 * is `matchRules` and every caller says "rules" — but the shape is a tree.
 */
export type MatchRules = MatchGroup;

/**
 * The pre-2026-09 stored shape: a flat ANY-of list, optionally with `negate`
 * on a leaf. Still accepted on input (the seed migration wrote it, and an
 * unedited built-in round-trips through the editor) and folded to a tree by
 * `normalizeMatchRules`. Nothing READS this shape — write paths take
 * `MatchRulesInput`, everything downstream takes `MatchRules`.
 */
export interface LegacyMatchClause {
  field: MatchField;
  /** Pre-2026-09 leaf key. */
  op?: string;
  operator?: string;
  value: string;
  negate?: boolean;
}

export interface LegacyMatchClauseList {
  clauses: LegacyMatchClause[];
}

/** What a write path will accept for the `matchRules` column. */
export type MatchRulesInput = MatchRules | LegacyMatchClauseList;

/** Narrow a node. A group carries `children`; a leaf carries `field`. */
export function isMatchGroup(node: MatchNode): node is MatchGroup {
  return Array.isArray((node as MatchGroup).children);
}

/** One registry row, as much of it as the resolver needs. */
export interface MatchableType {
  name: string;
  matchRules: MatchRules | null;
  matchContexts: string[];
  matchPriority: number;
}

// ─── Validation ────────────────────────────────────────────────────────────

/** Leaf count cap. Was the clause cap; the tree keeps the same budget. */
const MAX_LEAVES = 64;
const MAX_VALUE_LEN = 200;
/** Nesting cap — the same number the device-filter tree enforces. */
export const MATCH_MAX_DEPTH = 5;
export const MATCH_MAX_LEAVES = MAX_LEAVES;

/**
 * Compile-check a regex the operator typed. Returns null when it is usable.
 *
 * A bad pattern has to be refused at WRITE time: the resolver runs inside the
 * discovery hot path, and a `new RegExp` throwing per device per run would
 * turn one typo into a failed discovery for the whole fleet.
 */
export function validateRegex(pattern: string): string | null {
  // RE2 (business rule 116): linear whatever the pattern, so the only thing to
  // refuse is one it cannot compile — also run by the match-preview endpoint,
  // which needs only `assets:read`.
  return safeRegexProblem(pattern, { ignoreCase: true });
}

/** Resolve a stored operator spelling to a current one, or null. */
function canonicalOp(raw: unknown): MatchOp | null {
  if (typeof raw !== "string") return null;
  if ((MATCH_OPS as readonly string[]).includes(raw)) return raw as MatchOp;
  return LEGACY_OP_ALIASES[raw] ?? null;
}

/** Validate one leaf. Returns an error message, or null. */
function validateClause(raw: unknown, at: string): string | null {
  const c = raw as LegacyMatchClause & { negate?: unknown };
  if (!c || typeof c !== "object") return `${at} is not an object.`;
  if (!(MATCH_FIELDS as readonly string[]).includes(c.field)) return `${at}: unknown field "${c.field}".`;
  const stated = c.operator ?? c.op;
  const op = canonicalOp(stated);
  if (!op) return `${at}: unknown operator "${String(stated)}".`;
  if (typeof c.value !== "string" || !c.value.trim()) return `${at}: value is required.`;
  if (c.value.length > MAX_VALUE_LEN) return `${at}: value is longer than ${MAX_VALUE_LEN} characters.`;
  if (c.negate !== undefined && typeof c.negate !== "boolean") return `${at}: negate must be true or false.`;
  if (positiveMatchOp(op) === "regex") {
    const err = validateRegex(c.value);
    if (err) return `${at}: ${err}`;
  }
  return null;
}

/**
 * Validate a rules blob. Returns an error message, or null when it is legal.
 *
 * Accepts BOTH shapes: the current tree (`{op, children}`) and the pre-2026-09
 * flat list (`{clauses:[…]}`, which is an ANY-of and folds to `{op:"or"}`).
 * Read-side normalization gates on this function, so refusing the legacy shape
 * here would silently blank the rules on every row the seed migration wrote.
 *
 * An EMPTY group is not an error — `normalizeMatchRules` prunes it. That is
 * deliberate rather than lenient: `and([])` is `true` by identity, so a root
 * group an operator emptied would otherwise claim the entire fleet, and a
 * structural prune can't be forgotten at a call site the way a check can.
 */
export function validateMatchRules(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "Match rules must be an object.";

  const legacy = (raw as { clauses?: unknown }).clauses;
  if (Array.isArray(legacy)) {
    if (legacy.length > MAX_LEAVES) return `At most ${MAX_LEAVES} conditions per type.`;
    for (const [i, c] of legacy.entries()) {
      const err = validateClause(c, `Condition ${i + 1}`);
      if (err) return err;
    }
    return null;
  }

  const root = raw as MatchGroup;
  if (!Array.isArray(root.children)) {
    return "Match rules must carry a `children` array.";
  }

  let leaves = 0;
  let problem: string | null = null;
  const walk = (group: MatchGroup, depth: number, path: string): void => {
    if (problem) return;
    if (!(MATCH_GROUP_OPS as readonly string[]).includes(group.op)) {
      problem = `${path}: unknown group operator "${String(group.op)}".`;
      return;
    }
    if (depth > MATCH_MAX_DEPTH) {
      problem = `Condition groups nest at most ${MATCH_MAX_DEPTH} deep.`;
      return;
    }
    if (!Array.isArray(group.children)) {
      problem = `${path}: children must be an array.`;
      return;
    }
    group.children.forEach((child, i) => {
      if (problem) return;
      if (child && typeof child === "object" && Array.isArray((child as MatchGroup).children)) {
        walk(child as MatchGroup, depth + 1, `${path} › group ${i + 1}`);
        return;
      }
      leaves++;
      if (leaves > MAX_LEAVES) {
        problem = `At most ${MAX_LEAVES} conditions per type.`;
        return;
      }
      problem = validateClause(child, `${path} › condition ${i + 1}`);
    });
  };
  walk(root, 1, "Conditions");
  return problem;
}

/** Validate a contexts array. Returns an error message, or null. */
export function validateMatchContexts(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return "Match contexts must be an array.";
  for (const c of raw) {
    if (!(MATCH_CONTEXTS as readonly string[]).includes(c)) return `Unknown match context "${c}".`;
  }
  return null;
}

/**
 * One leaf, folded to the current shape: `operator` (not `op`), a canonical
 * operator spelling, and no `negate`.
 */
function normalizeClause(raw: unknown): MatchClause | null {
  const c = raw as LegacyMatchClause & { negate?: boolean };
  const op = canonicalOp(c?.operator ?? c?.op);
  if (!op) return null;
  const value = typeof c.value === "string" ? c.value : "";
  if (!value.trim()) return null;
  // `negate: true` predates the negative operators and means exactly them.
  const effective = c.negate ? (NEGATIVE_OF[positiveMatchOp(op)] ?? op) : op;
  return { field: c.field, operator: effective, value };
}

/**
 * Coerce a stored JSON blob into a `MatchRules` tree, or null when it carries
 * no usable condition.
 *
* Folds four things forward, all losslessly, so nothing downstream — resolver,
 * preview, route, editor — has to know a legacy row from a current one:
 *   - `{clauses:[…]}`  → `{op:"or", children:[…]}` (ANY-of was already an OR)
 *   - a leaf's `op`    → `operator`, the device filter's leaf key
 *   - `starts_with` / `ends_with` → `startsWith` / `endsWith`
 *   - `negate: true`   → the operator's negative twin
 *
 * Then PRUNES: an unusable leaf is dropped, a group left with no children is
 * dropped, and a root with nothing left returns null (= "only ever assigned").
 * See `validateMatchRules` for why pruning rather than refusing.
 */
export function normalizeMatchRules(raw: unknown): MatchRules | null {
  if (validateMatchRules(raw) !== null) return null;
  if (raw === null || raw === undefined) return null;

  const legacy = (raw as { clauses?: unknown }).clauses;
  const root: MatchGroup = Array.isArray(legacy)
    ? { op: "or", children: legacy as MatchNode[] }
    : (raw as MatchGroup);

  const prune = (group: MatchGroup): MatchGroup | null => {
    const children: MatchNode[] = [];
    for (const child of group.children ?? []) {
      if (child && typeof child === "object" && Array.isArray((child as MatchGroup).children)) {
        const kept = prune(child as MatchGroup);
        if (kept) children.push(kept);
      } else {
        const leaf = normalizeClause(child);
        if (leaf) children.push(leaf);
      }
    }
    return children.length ? { op: group.op, children } : null;
  };
  return prune(root);
}

/** Every leaf in a tree, in walk order. */
export function matchClauses(rules: MatchRules | null | undefined): MatchClause[] {
  const out: MatchClause[] = [];
  const walk = (group: MatchGroup): void => {
    for (const child of group.children) {
      if (isMatchGroup(child)) walk(child);
      else out.push(child);
    }
  };
  if (rules) walk(rules);
  return out;
}

// ─── Evaluation ────────────────────────────────────────────────────────────

/**
 * The text a clause's `field` reads. `any` is the space-joined non-empty
 * facts, which is how `assetTypeForHit` matched (`os` + `hostname`) — pass the
 * resolver only the facts a source actually has and `any` means the same
 * thing it always did.
 */
function factText(facts: AssetTypeFacts, field: MatchField): string | null {
  if (field === "any") {
    const parts = [
      facts.os, facts.hostname, facts.manufacturer, facts.model, facts.chassis,
      // Widens `any` for every existing rule, deliberately: a device that
      // calls itself a "Network Switch" SHOULD land in the switch bucket, and
      // the seeded clauses look for exactly those words. Nothing the seeds
      // search for (fortigate / switch / router / printer) appears in an AXIS
      // product type, so no existing hit re-types on this alone.
      facts.productType,
    ]
      .map((v) => (v ?? "").trim())
      .filter(Boolean);
    return parts.length ? parts.join(" ") : null;
  }
  const v = facts[field as Exclude<MatchField, "any">];
  const s = (v ?? "").trim();
  return s ? s : null;
}

/**
 * Does one leaf match? Case-insensitive throughout — every pattern this
 * replaces lower-cased its haystack first.
 *
 * An ABSENT fact never matches, negated or not. "This device is not a Windows
 * box" must not be satisfied by a device that reported no OS at all: at
 * discovery time a missing fact means *not yet known*, and letting absence
 * satisfy a negation is how one silent field outage re-types a fleet. This is
 * the deliberate divergence from `evaluateScopeCondition`, where `notContains`
 * against a NULL column IS satisfied — that one filters stored rows, where a
 * null is an answer.
 */
export function clauseMatches(clause: MatchClause, facts: AssetTypeFacts): boolean {
  const text = factText(facts, clause.field);
  if (text === null) return false;
  const hay = text.toLowerCase();
  const needle = clause.value.trim().toLowerCase();

  let hit: boolean;
  switch (positiveMatchOp(clause.operator)) {
    case "contains":    hit = hay.includes(needle); break;
    case "equals":      hit = hay === needle; break;
    case "startsWith":  hit = hay.startsWith(needle); break;
    case "endsWith":    hit = hay.endsWith(needle); break;
    case "regex": {
      // Validated at write time; a stored pattern that still fails to compile
      // (hand-edited row, restored backup) is treated as no-match rather than
      // being allowed to throw into the discovery loop.
      // A pattern stored before the write-time guard existed can still be a
      // catastrophic one, and the subject is device-supplied, so both ends are
      // bounded here too: an unsafe stored pattern is a no-match, and nothing
      // is run against more than MAX_REGEX_SUBJECT characters.
      // On RE2 (business rule 116): a stored pattern it cannot compile is a
      // no-match, never a throw into the loop.
      hit = tryCompileSafeRegex(clause.value, { ignoreCase: true })?.test(clampRegexSubject(text)) ?? false;
      break;
    }
    default: hit = false;
  }
  return isNegativeMatchOp(clause.operator) ? !hit : hit;
}

/**
 * Evaluate a condition tree against a device's facts. Same four group
 * operators and same boolean identities as `evaluateScopeCondition`, so a
 * tree reads the same in both builders — normalization prunes empty groups
 * before this ever sees one, so the `and([]) === true` identity can't hand a
 * type the whole fleet.
 */
export function conditionMatches(group: MatchGroup, facts: AssetTypeFacts): boolean {
  const results = group.children.map((c) =>
    isMatchGroup(c) ? conditionMatches(c, facts) : clauseMatches(c, facts),
  );
  switch (group.op) {
    case "and":    return results.every(Boolean);
    case "or":     return results.some(Boolean);
    case "none":   return !results.some(Boolean);
    case "notAll": return !results.every(Boolean);
    default:       return false;
  }
}

/** Does this type claim the device? */
export function typeMatches(type: MatchableType, facts: AssetTypeFacts, context: MatchContext): boolean {
  if (!type.matchContexts.includes(context)) return false;
  const rules = type.matchRules;
  if (!rules || !rules.children.length) return false;
  return conditionMatches(rules, facts);
}

/**
 * Deterministic evaluation order: priority ascending, then name. Ties on
 * priority are broken by name rather than left to the database's row order,
 * so two installs with the same registry infer the same type.
 */
export function orderTypes(types: readonly MatchableType[]): MatchableType[] {
  return [...types].sort((a, b) =>
    a.matchPriority !== b.matchPriority ? a.matchPriority - b.matchPriority : a.name.localeCompare(b.name),
  );
}

/**
 * Resolve facts to a type name. Returns null when nothing claims the device —
 * callers decide their own default (`other` for discovery, `workstation` for
 * Entra/Intune, which has always assumed its records are endpoints).
 */
export function resolveAssetType(
  types: readonly MatchableType[],
  facts: AssetTypeFacts,
  context: MatchContext,
): string | null {
  for (const t of orderTypes(types)) {
    if (typeMatches(t, facts, context)) return t.name;
  }
  return null;
}

/**
 * The same walk, but reporting WHICH condition decided — the preview surface
 * needs to show an operator why a device landed where it did, and a preview
 * that re-derived its own explanation could disagree with the resolver.
 */
export interface MatchExplanation {
  type: string | null;
  clause: MatchClause | null;
}

/**
 * One satisfied leaf from a matching tree, or null when none can honestly be
 * named. Descends only through `and` / `or` — under a `none` / `notAll` group
 * a leaf that tested TRUE is what *prevented* a match, so reporting it as the
 * reason would be exactly backwards. An `and` reports its first leaf, which is
 * true but partial; the editor shows the whole tree beside it.
 */
function decidingClause(group: MatchGroup, facts: AssetTypeFacts): MatchClause | null {
  if (group.op !== "and" && group.op !== "or") return null;
  for (const child of group.children) {
    if (isMatchGroup(child)) {
      const inner = decidingClause(child, facts);
      if (inner) return inner;
    } else if (clauseMatches(child, facts)) {
      return child;
    }
  }
  return null;
}

export function explainAssetType(
  types: readonly MatchableType[],
  facts: AssetTypeFacts,
  context: MatchContext,
): MatchExplanation {
  for (const t of orderTypes(types)) {
    if (!typeMatches(t, facts, context)) continue;
    return { type: t.name, clause: t.matchRules ? decidingClause(t.matchRules, facts) : null };
  }
  return { type: null, clause: null };
}

// ─── Builder catalog ───────────────────────────────────────────────────────

/**
 * The vocabulary the editor renders, in the SAME shape `scopeConditionMeta`
 * publishes for the device filter — so the shared `PolarisConditionBuilder`
 * consumes it unchanged and the page holds no field or operator list of its
 * own. Served by `GET /asset-types/match-schema`.
 */
export function matchConditionMeta() {
  const FIELD_LABELS: Record<MatchField, string> = {
    any: "Any field",
    os: "OS",
    osVersion: "OS version",
    hostname: "Hostname",
    manufacturer: "Manufacturer",
    model: "Model",
    chassis: "Chassis (Entra / Intune)",
    productType: "Product type (device self-report)",
  };
  return {
    groupOps: MATCH_GROUP_OPS,
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    // The six shared operators keep the device filter's wording verbatim.
    operatorLabels: {
      equals: "is equal to",
      notEquals: "is not equal to",
      contains: "contains",
      notContains: "does not contain",
      startsWith: "starts with",
      notStartsWith: "does not start with",
      endsWith: "ends with",
      notEndsWith: "does not end with",
      regex: "matches regex",
      notRegex: "does not match regex",
    },
    fields: MATCH_FIELDS.map((field) => ({
      field,
      label: FIELD_LABELS[field],
      ops: MATCH_OPS,
    })),
    maxDepth: MATCH_MAX_DEPTH,
    maxRules: MATCH_MAX_LEAVES,
  };
}

// ─── Registry cache ────────────────────────────────────────────────────────
//
// Mirrors the pattern in utils/assetTypes.ts: assetTypeService.refreshCache()
// installs the rows here at boot and after every mutation, so the discovery
// hot path resolves a type without a query per device.

/** null = never loaded in this process. Distinct from "loaded and empty". */
let _matchRegistry: MatchableType[] | null = null;

export function setAssetTypeMatchRegistry(types: readonly MatchableType[]): void {
  _matchRegistry = orderTypes(types);
}

/** Test seam — lets a suite return a process to the never-loaded state. */
export function resetAssetTypeMatchRegistry(): void {
  _matchRegistry = null;
}

/**
 * The rows the resolver will use. Before the cache is loaded this is the
 * SHIPPED matching rather than nothing, mirroring `isKnownAssetType`'s
 * fall-through to the built-in names in utils/assetTypes.ts.
 *
 * The distinction is load-bearing. An empty ARRAY is a real answer — an
 * operator can legitimately clear every rule — but a `null` cache means this
 * process has not asked yet, and answering "nothing matches" there would type
 * a whole discovery run `other` and look exactly like a fleet of unrecognized
 * devices. Warming is belt and braces on top: `startBackgroundJobs` loads it
 * on every role and `runDiscovery` re-reads it per run.
 */
function activeRegistry(): readonly MatchableType[] {
  if (_matchRegistry !== null) return _matchRegistry;
  return orderTypes(
    Object.entries(DEFAULT_TYPE_MATCHING).map(([name, m]) => ({
      name,
      matchRules: m.rules,
      matchContexts: m.contexts,
      matchPriority: m.priority,
    })),
  );
}

export function getAssetTypeMatchRegistry(): readonly MatchableType[] {
  return activeRegistry();
}

/** Resolve against the live cache. */
export function resolveAssetTypeCached(facts: AssetTypeFacts, context: MatchContext): string | null {
  return resolveAssetType(activeRegistry(), facts, context);
}

// ─── Shipped defaults ──────────────────────────────────────────────────────

/** An OR of `field contains value` leaves — the shape both old ladders had. */
function anyContains(field: MatchField, values: readonly string[]): MatchGroup {
  return {
    op: "or",
    children: values.map((value) => ({ field, operator: "contains" as const, value })),
  };
}

/**
 * The matching every built-in type ships with — a transcription of the two
 * hardcoded predicates this layer replaced, so a fresh install behaves exactly
 * as it did before rules existed.
 *
 * **Kept in lockstep with the seed migration**
 * (`20260901010000_asset_type_match_rules`), which is where EXISTING installs
 * get their rules; this constant only reaches rows that
 * `seedBuiltInAssetTypes` has to create from scratch (a `prisma migrate reset`
 * or a nuked volume). The two can't share source — one is SQL — and since
 * 2026-09 they don't even share a SHAPE: the migration wrote the flat
 * `{clauses:[…]}` list, which `normalizeMatchRules` folds to the same OR tree
 * these literals spell out. That is exactly why
 * `tests/unit/assetTypeMatch.test.ts` pins the behavior both must produce
 * rather than the text.
 *
 * A type absent from this table (`other`, `hypervisor`, `kubernetes_cluster`)
 * ships with no rules on purpose: `other` is the fallback rather than a match,
 * and the other two are only ever assigned by an authoritative source.
 */
export const DEFAULT_TYPE_MATCHING: Readonly<
  Record<string, { contexts: MatchContext[]; priority: number; rules: MatchRules }>
> = {
  server: {
    contexts: ["directory"],
    priority: 20,
    rules: anyContains("os", [
      "server", "centos", "red hat", "rhel", "rocky linux", "almalinux",
      "oracle linux", "freebsd", "openbsd", "netbsd", "esxi", "vmware",
    ]),
  },
  workstation: {
    contexts: ["directory"],
    priority: 30,
    rules: {
      op: "or",
      children: [
        { field: "os", operator: "regex", value: "windows\\s+(10|11|7|8|xp|vista)" },
        ...anyContains("os", [
          "macos", "mac os x", "os x", "linux mint", "ubuntu", "fedora", "debian",
          "arch linux", "manjaro", "pop!_os", "elementary os", "zorin os",
        ]).children,
      ],
    },
  },
  firewall: {
    contexts: ["scan"],
    priority: 10,
    rules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\b(fortigate|firewall|palo alto|sonicwall)\\b" }] },
  },
  switch: {
    contexts: ["scan"],
    priority: 12,
    rules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\b(fortiswitch|switch|catalyst|nexus)\\b" }] },
  },
  access_point: {
    contexts: ["scan"],
    priority: 14,
    rules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\bfortiap\\b|access point|\\bwlan\\b|\\bwireless\\b" }] },
  },
  router: {
    contexts: ["scan"],
    priority: 16,
    rules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\brouter\\b" }] },
  },
  printer: {
    contexts: ["scan"],
    priority: 18,
    rules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\bprinter\\b|laserjet|officejet" }] },
  },
};

// ─── The paths rules cannot reach ──────────────────────────────────────────

/**
 * Where a device's type comes from when it is READ rather than guessed.
 *
 * This is documentation with a consumer: the Device Types card renders it so
 * an operator editing rules can see that a FortiSwitch will keep being a
 * switch no matter what they write, and why. Keep it in step with the
 * hardcoded assignments in discoveryEngine / vcenterService / azureArcService
 * — a stale entry here is a card that lies about the system's behavior.
 */
export interface AuthoritativeTypeSource {
  /** Operator-facing name of the discovery path. */
  source: string;
  /** The type names it assigns outright. */
  assigns: string[];
  /** Why it outranks the rules. */
  reason: string;
}

export const AUTHORITATIVE_TYPE_SOURCES: readonly AuthoritativeTypeSource[] = [
  {
    source: "FortiManager / FortiGate discovery",
    assigns: ["firewall", "switch", "access_point"],
    reason:
      "The controller's own CMDB states the device's role. Dependency suppression, topology rendering and polling defaults branch on these three names, so they are read, never inferred.",
  },
  {
    source: "VMware vCenter discovery",
    assigns: ["hypervisor", "server"],
    reason:
      "An ESXi host and a VM are distinct objects in the vCenter inventory. VM identity lives in the asset's Virtualization blob, not in its type.",
  },
  {
    source: "Azure Arc discovery",
    assigns: ["kubernetes_cluster"],
    reason: "An Arc-enabled connected cluster is its own Azure resource type.",
  },
  {
    source: "Operator edit",
    assigns: [],
    reason:
      "A type set by hand is never overwritten. Discovery only re-types an existing asset that is still sitting in “Other”.",
  },
] as const;
