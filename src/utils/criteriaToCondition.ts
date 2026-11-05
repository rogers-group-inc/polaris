/**
 * src/utils/criteriaToCondition.ts
 *
 * Folds a flat `TagCriteria` blob forward into a nested condition tree, so a
 * contact whose device filter was written by the old builder opens in the new
 * one with its rules intact — the `normalizeRuleToV2` pattern, one shape
 * forward, every reader normalizing through it.
 *
 * The two vocabularies line up because the tree's DEVICE_FILTER field set was
 * widened to cover what criteria could say (osVersion / department / location /
 * fortigate, plus the wildcard operator). The ONE thing it can't express is
 * `integration` ("discovered by integration X"), which the address-book UI never
 * offered — only an API caller could have written it. That is reported rather
 * than dropped: a caller that can't convert every rule keeps the flat blob
 * instead of silently narrowing who a contact is responsible for.
 *
 * Semantics being preserved:
 *   - criteria rules are ANDed          → root group `and`
 *   - values WITHIN a rule are ORed     → an `or` subgroup (one leaf if single)
 *   - exact → equals, contains → contains, pattern → matches (wildcard)
 *   - subnet cidrs are ORed             → `inCidr` leaves
 *
 * Pure, dependency-free (its own minimal input shape, no service import) so it
 * can be unit-tested against both vocabularies without a DB.
 */

/** The subset of a stored TagCriteria rule this converter reads. */
interface FlatCriteriaRule {
  field: string;
  op?: string;
  values?: string[];
  cidrs?: string[];
}

interface FlatCriteria {
  rules?: FlatCriteriaRule[];
}

interface ConditionRule {
  field: string;
  operator: string;
  value: string;
}
interface ConditionGroup {
  op: "and" | "or" | "none" | "notAll";
  children: (ConditionGroup | ConditionRule)[];
}

export interface CriteriaConversion {
  /** The tree, or null when the criteria carried no usable rules. */
  condition: ConditionGroup | null;
  /**
   * Fields that have no equivalent in the tree vocabulary. Non-empty means the
   * conversion is LOSSY and the caller must keep the flat criteria.
   */
  unconvertible: string[];
}

/** Flat criteria operator → condition-tree operator. */
const OP_MAP: Record<string, string> = {
  exact: "equals",
  contains: "contains",
  pattern: "matches",
};

/** Fields with no tree equivalent (see the header note on `integration`). */
const UNCONVERTIBLE_FIELDS = new Set(["integration"]);

function leaf(field: string, operator: string, value: string): ConditionRule {
  return { field, operator, value };
}

/**
 * One criteria rule → one child of the root AND group. A rule's values are
 * alternatives, so several become an `or` subgroup; a single value stays a bare
 * leaf rather than a group of one (the builder would render an empty-looking
 * nest, and the tree means the same thing either way).
 */
function ruleToChild(rule: FlatCriteriaRule): ConditionGroup | ConditionRule | null {
  const isSubnet = rule.field === "subnet";
  const values = (isSubnet ? rule.cidrs : rule.values) ?? [];
  const clean = values.filter((v) => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  if (clean.length === 0) return null;

  const operator = isSubnet ? "inCidr" : OP_MAP[rule.op ?? "contains"];
  if (!operator) return null;

  const leaves = clean.map((v) => leaf(rule.field, operator, v));
  return leaves.length === 1 ? leaves[0]! : { op: "or", children: leaves };
}

/**
 * Convert a stored flat criteria blob into a condition tree. Returns
 * `{condition: null}` for a blob with nothing usable in it — the same "no
 * filter" state a null criteria column means.
 */
export function criteriaToCondition(raw: unknown): CriteriaConversion {
  const criteria = (raw ?? null) as FlatCriteria | null;
  const rules = Array.isArray(criteria?.rules) ? criteria!.rules! : [];
  if (rules.length === 0) return { condition: null, unconvertible: [] };

  const unconvertible: string[] = [];
  const children: (ConditionGroup | ConditionRule)[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule.field !== "string") continue;
    if (UNCONVERTIBLE_FIELDS.has(rule.field)) {
      if (!unconvertible.includes(rule.field)) unconvertible.push(rule.field);
      continue;
    }
    const child = ruleToChild(rule);
    if (child) children.push(child);
  }

  if (children.length === 0) return { condition: null, unconvertible };
  return { condition: { op: "and", children }, unconvertible };
}
