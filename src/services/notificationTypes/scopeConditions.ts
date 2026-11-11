/**
 * src/services/notificationTypes/scopeConditions.ts — the core rule vocabulary and the scope condition tree (CQ-B063, moved verbatim from
 * notificationTypes.ts): severities, event levels, comparators and aggregations, and the
 * nested AND / OR device filter — its fields, operators, schema and limits.
 */

import { z } from "zod";
import { isValidCidr, isValidIpAddress, ipInCidr, parseIpv4Range, ipInIpv4Range } from "../../utils/cidr.js";
import { compileWildcard } from "../../utils/wildcard.js";

// Notification severity (rule.severity → notification.severity). Ordered
// least → most severe. NOTE: distinct from EVENT_LEVELS below — that's the
// audit-Event level vocabulary the `event` trigger's minLevel filters against.
export const SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;

// Audit-Event levels (logEvent), used only by the event-trigger minLevel filter.
export const EVENT_LEVELS = ["info", "warning", "error"] as const;

/**
 * The asset Event the delivery drain writes for every alert email it sends
 * (notificationDeliveryService.emailSentEventsFor). Business rule 106: the
 * event tail never lets it fire or reset an automation — an event automation
 * matching `*` or `notification.*` with an email action would otherwise raise
 * itself once per email it sent, forever.
 */
export const ALERT_EMAIL_SENT_ACTION = "notification.email_sent";

/** Pure — rule 106's guard, shared by the event tail and its test. */
export function eventFeedsAutomations(action: string): boolean {
  return action !== ALERT_EMAIL_SENT_ACTION;
}

export const CLEAR_BEHAVIORS = ["manual", "auto", "timed"] as const;

export const COMPARATORS = [">", ">=", "<", "<=", "==", "!="] as const;

export const AGGREGATIONS = ["latest", "avg", "median", "min", "max"] as const;

export type Severity = (typeof SEVERITIES)[number];

export type Comparator = (typeof COMPARATORS)[number];

/** Rank of a severity (higher = more severe); -1 for an unknown string. */
export function severityRank(s: string): number {
  return (SEVERITIES as readonly string[]).indexOf(s);
}

// ─── Scope condition tree (nested AND/OR device filtering) ──────────────────
// `scope.condition` is a nested group of per-field rules — the wizard's
// SolarWinds-style builder. Group combinators:
//   and    = all children must be satisfied
//   or     = at least one child must be satisfied
//   none   = all children must NOT be satisfied      (¬or)
//   notAll = at least one child must NOT be satisfied (¬and)
// Rules are (field, operator, value) over asset identity columns; evaluation
// is the pure `evaluateScopeCondition` below — used by the in-memory matcher
// AND the engine's post-SQL filter, so the semantics can't drift.

export const SCOPE_GROUP_OPS = ["and", "or", "none", "notAll"] as const;

type ScopeGroupOp = (typeof SCOPE_GROUP_OPS)[number];

const STRING_OPS = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const;

/**
 * The three ways a `subnet` ("Subnet / IP") rule can name addresses, each with
 * its negation:
 *   - CIDR  (`inCidr`)        — "10.20.0.0/16", or a bare IP read as a /32;
 *   - Range (`inRange`)       — "10.20.0.10-10.20.0.50" (or "10.20.0.10-50"),
 *                               inclusive, IPv4;
 *   - Name  (`inSubnetNamed`) — a registry Subnet NAME, `*` / `?` wildcards,
 *                               case-insensitive: the address is inside ANY
 *                               non-deprecated Subnet whose name matches, so
 *                               "Plant-*" selects every plant subnet, including
 *                               ones created after the rule was saved.
 * CIDR and Range are pure over the asset row. Name needs the subnet registry,
 * so it is resolved like the relation-backed fields: `decorateRelationLeafHits`
 * (scopeRelationIndex.ts) stamps the verdict under `subnetNameLeafKey`, and an
 * undecorated row reads as "in no such subnet".
 */
const SUBNET_NAME_OPS = ["inSubnetNamed", "notInSubnetNamed"] as const;

const SUBNET_RANGE_OPS = ["inRange", "notInRange"] as const;

const SUBNET_OPS = ["inCidr", "notInCidr", ...SUBNET_RANGE_OPS, ...SUBNET_NAME_OPS] as const;

export const SCOPE_FIELD_OPS: Record<string, readonly string[]> = {
  assetType: ["equals", "notEquals"],
  manufacturer: STRING_OPS,
  model: STRING_OPS,
  hostname: STRING_OPS,
  os: STRING_OPS,
  tag: ["has", "notHas"],
  subnet: SUBNET_OPS,
  // "IP block" — the IPAM block an address falls inside, stored as the block's
  // CIDR and matched by exactly the `subnet` predicate below. A separate field
  // rather than more entries on the `subnet` picker because a block is the
  // level operators actually name ("everything in Corporate Core"), and one
  // rule then covers subnets nobody has defined yet — an address inside the
  // block's range but in no Subnet row still matches, which is the point.
  //
  // A block's CIDR is what is stored, not its id or name: the value has to
  // survive being read by the pure evaluator, which sees an asset row and
  // nothing else. The consequence to know is that RE-CIDRing a block does not
  // follow into saved rules (renaming one is free) — the same trade the
  // `subnet` field has always made.
  ipBlock: ["inCidr", "notInCidr"],
  // "Device interface" — matched against the device's CURRENT-STATE interface
  // inventory (AssetInterface.ifName), so a rule pairs naturally with a device
  // type ("switches that have a fortilink port"). Multi-valued like
  // `fortigate`: a positive operator is satisfied by ANY interface, a negative
  // one has to hold for every one of them.
  //
  // Deliberately NOT restricted to PINNED interfaces the way every interface
  // TRIGGER is: a trigger reads a metric, which only exists for a pinned
  // interface, whereas this asks what the device HAS. Note the consequence —
  // a device whose interface stream is never collected reports no interfaces
  // at all, so a positive rule never selects it.
  interfaceName: STRING_OPS,
  // "Broadcast SSID" — matched against the SSIDs the device is currently
  // broadcasting (AssetApVap.ssid), so it selects ACCESS POINTS: "every AP
  // carrying GUEST". The second relation-backed field, and it follows
  // interfaceName exactly — multi-valued (a positive operator is satisfied
  // by ANY SSID, a negative one must hold for every one), resolved in SQL by
  // scopeRelationIndex at fleet scale and by the joined relation on the
  // single-asset paths. Same consequence, too: an AP whose radios have not
  // been discovered reports no SSIDs, so a positive rule never selects it.
  ssid: STRING_OPS,
  // "Polaris Agent installed" — yes / no, from the asset's ManagedAgent row:
  // yes means an ACTIVE agent (installStatus "active"), the same test
  // requestScriptRun and path-check membership apply. The third
  // relation-backed field: fleet-scale loaders prefetch it through
  // scopeRelationIndex, the single-asset paths join `managedAgent`.
  agentInstalled: ["equals", "notEquals"],
  status: ["equals", "notEquals"],
  assetId: ["equals", "notEquals"],
};

const SCOPE_FIELDS = Object.keys(SCOPE_FIELD_OPS);

/**
 * Fields whose VALUE is a CIDR (or a bare IP, read as a host route) rather than
 * a string to compare. They validate together and match together — the set
 * exists so a third CIDR-shaped field cannot be taught to one half and
 * forgotten in the other.
 */
const CIDR_VALUED_FIELDS = new Set(["subnet", "ipBlock"]);

/**
 * Shell-style wildcard comparison ("PLV*-61F-?"), compiled by the shared
 * utils/wildcard.ts. Offered only in the DEVICE_FILTER vocabulary below: the
 * flat tag-criteria builder has always had it, so without it a stored contact
 * filter couldn't fold forward into a tree without losing a rule.
 */
export const WILDCARD_OP = "matches";

/** String ops plus the wildcard — the device-filter flavour of STRING_OPS. */
const STRING_OPS_WITH_WILDCARD = [...STRING_OPS, WILDCARD_OP] as const;

/**
 * The DEVICE-FILTER vocabulary: a strict SUPERSET of the automations scope
 * fields, used by the address book's "devices this contact is responsible for".
 *
 * Contacts share the automations tree — the same builder, the same evaluator,
 * the same stored shape — but they came from the flat `TagCriteria` builder,
 * which carried four fields and a wildcard operator the automations scope never
 * had. Dropping them in the swap would be a regression in exactly the dimension
 * device OWNERSHIP cares about ("whoever looks after the Ashfield switches"),
 * so the vocabulary widens rather than the feature narrowing.
 *
 * Why a second map instead of widening SCOPE_FIELD_OPS: `fortigate` reads the
 * sighting relation, and the notification engine's scope filter runs over the
 * whole fleet on every tick — putting that join on the hot path would cost far
 * more than the field is worth there. The three plain columns are withheld from
 * automations for the same reason the map exists at all: one surface asked for
 * them. `matchScopeRule` evaluates the superset, so a caller that validates
 * against SCOPE_FIELD_OPS simply can't produce the extra fields.
 */
export const DEVICE_FILTER_FIELD_OPS: Record<string, readonly string[]> = {
  ...Object.fromEntries(
    Object.entries(SCOPE_FIELD_OPS).map(([field, ops]) => [
      field,
      // Only the free-string fields take a wildcard; assetType / status / tag /
      // subnet are closed or CIDR-shaped, and the flat builder never offered a
      // pattern there either.
      ops.includes("contains") ? STRING_OPS_WITH_WILDCARD : ops,
    ]),
  ),
  osVersion: STRING_OPS_WITH_WILDCARD,
  department: STRING_OPS_WITH_WILDCARD,
  location: STRING_OPS_WITH_WILDCARD,
  // "Behind FortiGate" — matched against Asset.learnedLocation OR any
  // AssetFortigateSighting device name, so `contains` on a site prefix covers
  // every gate at the site. Mirrors the tagAssignmentService rule of the same
  // name; a negative operator means NONE of those names satisfy it.
  fortigate: STRING_OPS_WITH_WILDCARD,
  // "Native VLAN" — the untagged VLAN (PVID) of ANY of the device's ports
  // (AssetInterface.nativeVlan, every port, trunks included), so it selects
  // SWITCHES: "every switch with a port on VLAN 30". The fourth
  // relation-backed field, multi-valued exactly like interfaceName. A tag
  // carrying a positive leaf also tags the matching PORTS (business rule 133).
  // Device-filter only — the automations scope never asked for it.
  nativeVlan: ["equals", "notEquals"],
};

const DEVICE_FILTER_FIELDS = Object.keys(DEVICE_FILTER_FIELD_OPS);

/** Fields the extended vocabulary adds — the ones automations can't produce. */
export const DEVICE_FILTER_ONLY_FIELDS = DEVICE_FILTER_FIELDS.filter((f) => !SCOPE_FIELDS.includes(f));

export interface ScopeConditionRule {
  field: string;
  operator: string;
  value: string;
}

export interface ScopeConditionGroup {
  op: ScopeGroupOp;
  children: (ScopeConditionGroup | ScopeConditionRule)[];
}

/**
 * Build a condition-tree schema over one field vocabulary. Parameterized so the
 * automations scope and the wider device filter validate the SAME tree shape
 * against different field sets — the evaluator handles the superset, and which
 * fields a surface may actually store is decided here.
 */
function makeScopeConditionSchema(
  fieldOps: Record<string, readonly string[]>,
): z.ZodType<ScopeConditionGroup> {
  const ruleSchema = z
    .object({
      field: z.enum(Object.keys(fieldOps) as [string, ...string[]]),
      operator: z.string().min(1).max(30),
      value: z.string().min(1).max(200),
    })
    .strict()
    .superRefine((r, ctx) => {
      const ops = fieldOps[r.field] ?? [];
      if (!ops.includes(r.operator)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `operator "${r.operator}" is not valid for field "${r.field}"` });
      }
      if ((SUBNET_RANGE_OPS as readonly string[]).includes(r.operator)) {
        if (!parseIpv4Range(r.value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be an IPv4 range, first to last (e.g. 10.20.0.10-10.20.0.50)` });
        }
      } else if ((SUBNET_NAME_OPS as readonly string[]).includes(r.operator)) {
        try {
          compileWildcard(r.value.trim());
        } catch (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error)?.message || `"${r.value}" is not a valid subnet name pattern` });
        }
      } else if (CIDR_VALUED_FIELDS.has(r.field) && !isValidCidr(r.value) && !isValidIpAddress(r.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a CIDR (e.g. 10.20.0.0/16) or an IP address` });
      } else if (r.field === "nativeVlan" && parseVlanId(r.value) == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${r.value}" must be a VLAN number from 1 to 4094` });
      }
      // A malformed wildcard must be a 400 at save time, not a throw inside the
      // fire-time matcher — the same reason tag criteria compile theirs on write.
      if (r.operator === WILDCARD_OP) {
        try {
          compileWildcard(r.value);
        } catch (err) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error)?.message || `"${r.value}" is not a valid wildcard` });
        }
      }
    });

  const groupSchema: z.ZodType<ScopeConditionGroup> = z.lazy(() =>
    z
      .object({
        op: z.enum(SCOPE_GROUP_OPS),
        children: z.array(z.union([ruleSchema, groupSchema])).max(50),
      })
      .strict(),
  ) as z.ZodType<ScopeConditionGroup>;
  return groupSchema;
}

/** Automations `scope.condition` — the narrow vocabulary. */
export const scopeConditionSchema: z.ZodType<ScopeConditionGroup> = makeScopeConditionSchema(SCOPE_FIELD_OPS);

/** Contact device ownership — the same tree over DEVICE_FILTER_FIELD_OPS. */
export const deviceFilterConditionSchema: z.ZodType<ScopeConditionGroup> =
  makeScopeConditionSchema(DEVICE_FILTER_FIELD_OPS);

/**
 * Depth + rule caps for a condition tree. Exported because the published
 * builder catalog states them and the schema enforces them — two copies of the
 * number is how the builder comes to allow a nesting the server refuses.
 */
export const SCOPE_CONDITION_MAX_DEPTH = 5;

export const SCOPE_CONDITION_MAX_RULES = 100;

/** Depth/size guard for a condition tree (defense against pathological input). */
export function scopeConditionStats(cond: ScopeConditionGroup): { depth: number; rules: number } {
  let rules = 0;
  const depthOf = (g: ScopeConditionGroup): number =>
    1 + Math.max(0, ...g.children.map((c) => {
      if ("op" in c) return depthOf(c as ScopeConditionGroup);
      rules++;
      return 0;
    }));
  const depth = depthOf(cond);
  return { depth, rules };
}

/**
 * Every field a tree actually references. Lets a caller decide what to SELECT
 * before evaluating — the contact preview only joins the FortiGate sighting
 * relation when a rule asks about it (the 2000-asset rule; the flat
 * vocabulary's buildCandidateSelect does the same thing).
 */
export function conditionFields(cond: ScopeConditionGroup): Set<string> {
  const out = new Set<string>();
  const walk = (g: ScopeConditionGroup): void => {
    for (const c of g.children) {
      if ("op" in c) walk(c as ScopeConditionGroup);
      else out.add((c as ScopeConditionRule).field);
    }
  };
  walk(cond);
  return out;
}

/**
 * The condition fields backed by a RELATION rather than a column, mapped to
 * the Asset relation and column each one reads. Every loader decides its join
 * (or its prefetch) from this table instead of spelling field names itself —
 * which is what kept the fleet-scale SQL path and the single-asset in-memory
 * path answering the same question when the second such field arrived.
 */
export const RELATION_CONDITION_FIELDS: Record<string, { relation: "interfaces" | "apVaps" | "managedAgent"; column: "ifName" | "nativeVlan" | "ssid" | "installStatus" }> = {
  interfaceName:  { relation: "interfaces",   column: "ifName" },
  // An integer column, matched by number rather than as a string — see
  // parseVlanId, which both the SQL leaf and the in-memory path go through.
  nativeVlan:     { relation: "interfaces",   column: "nativeVlan" },
  ssid:           { relation: "apVaps",       column: "ssid" },
  // Not a string match like the other two: the prefetch answers "has an
  // ACTIVE agent" whatever the rule's value, and matchScopeRule compares that
  // with yes / no. See `agentInstalled` in SCOPE_FIELD_OPS.
  agentInstalled: { relation: "managedAgent", column: "installStatus" },
};

/** Does this tree ask about the interface inventory? */
export function conditionNeedsInterfaces(cond: ScopeConditionGroup | null | undefined): boolean {
  if (!cond) return false;
  const fields = conditionFields(cond);
  return fields.has("interfaceName") || fields.has("nativeVlan");
}

/**
 * A `nativeVlan` rule value as a VLAN id, or null when it is not one. The
 * value is stored as a string like every other leaf; "030" and "30" are the
 * same VLAN, so every comparison goes through this rather than the string.
 */
export function parseVlanId(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 4094 ? n : null;
}

/**
 * The VLANs whose ports a tag filter TAGS (business rule 133): every
 * `nativeVlan` leaf that asserts the VLAN is PRESENT — `equals` under an even
 * number of negating groups (`none` / `notAll`), or `notEquals` under an odd
 * number. A leaf asserting absence names a VLAN the matched device's ports are
 * NOT on, so it tags no port. Empty when the tree tags no ports at all, which
 * is the ordinary device-only tag.
 */
export function positiveNativeVlans(cond: ScopeConditionGroup | null | undefined): number[] {
  const out = new Set<number>();
  const walk = (g: ScopeConditionGroup, negated: boolean): void => {
    const flip = g.op === "none" || g.op === "notAll" ? !negated : negated;
    for (const c of g.children) {
      if ("op" in c) { walk(c as ScopeConditionGroup, flip); continue; }
      const rule = c as ScopeConditionRule;
      if (rule.field !== "nativeVlan") continue;
      const asserts = rule.operator === "equals" ? !flip : rule.operator === "notEquals" ? flip : false;
      const id = parseVlanId(rule.value);
      if (asserts && id != null) out.add(id);
    }
  };
  if (cond) walk(cond, false);
  return Array.from(out).sort((a, b) => a - b);
}

/** Does this tree ask about the broadcast-SSID inventory? */
export function conditionNeedsApVaps(cond: ScopeConditionGroup | null | undefined): boolean {
  return !!cond && conditionFields(cond).has("ssid");
}

/** Does this tree ask whether the Polaris Agent is installed? */
export function conditionNeedsManagedAgent(cond: ScopeConditionGroup | null | undefined): boolean {
  return !!cond && conditionFields(cond).has("agentInstalled");
}

/** The single-asset join `agentInstalled` reads (the fleet paths prefetch). */
export const MANAGED_AGENT_CONDITION_SELECT = { managedAgent: { select: { installStatus: true } } } as const;

/**
 * The asset fields the condition evaluator reads (matcher + engine select).
 *
 * The last four back DEVICE_FILTER_FIELD_OPS only, and are optional for a
 * reason: the notification engine never selects them, so an automations rule —
 * which can't carry those fields past its own schema — costs nothing for them
 * being here.
 */
export interface ScopeConditionAsset {
  id: string;
  assetType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  hostname?: string | null;
  os?: string | null;
  tags?: string[];
  ipAddress?: string | null;
  status?: string | null;
  osVersion?: string | null;
  department?: string | null;
  location?: string | null;
  learnedLocation?: string | null;
  fortigateSightings?: { fortigateDevice: string | null }[];
  /** Current-state interface inventory, for the `interfaceName` field. Joined
   *  ONLY when a tree actually references it (conditionNeedsInterfaces) — at
   *  2000 assets this relation is an order of magnitude larger than the row it
   *  hangs off, which is why only the SINGLE-asset paths read it this way. */
  interfaces?: { ifName: string; nativeVlan?: number | null }[];
  /** Current-state broadcast-SSID inventory, for the `ssid` field. Joined on
   *  the same terms as `interfaces` above — only when a tree asks for it,
   *  and only on the SINGLE-asset paths. */
  apVaps?: { ssid: string | null }[];
  /** The asset's Polaris Agent row, for `agentInstalled`. Same terms as the two
   *  relations above: joined only when a tree asks, on single-asset paths. */
  managedAgent?: { installStatus: string } | null;
  /** The fleet-scale alternative for EVERY relation-backed field:
   *  `relationLeafKey(leaf)` -> did this asset satisfy that leaf, resolved in
   *  SQL by decorateRelationLeafHits rather than by shipping the relation.
   *  Stamped onto the row so every existing call site (scopeMatchesAsset, the
   *  carve-out peer predicates, the contact preview) keeps working with no
   *  extra parameter to thread. A key that is ABSENT was never prefetched and
   *  means unknown, not false. */
  relationLeafHits?: ReadonlyMap<string, boolean>;
}

/** The asset value a string-op rule compares against, lower-cased. */
function scopeStringField(field: string, asset: ScopeConditionAsset): string {
  const raw =
    field === "manufacturer" ? asset.manufacturer
      : field === "model" ? asset.model
        : field === "hostname" ? asset.hostname
          : field === "os" ? asset.os
            : field === "osVersion" ? asset.osVersion
              : field === "department" ? asset.department
                : field === "location" ? asset.location
                  : null;
  return (raw ?? "").toLowerCase();
}

/**
 * Every name that could identify the FortiGate an asset sits behind: its
 * projected learnedLocation plus each recorded sighting. Mirrors the
 * tagAssignmentService `fortigate` rule — `contains` on a site prefix is meant
 * to cover every gate at that site.
 */
function fortigateNames(asset: ScopeConditionAsset): string[] {
  const out: string[] = [];
  if (asset.learnedLocation) out.push(asset.learnedLocation.toLowerCase());
  for (const s of asset.fortigateSightings ?? []) {
    if (s.fortigateDevice) out.push(s.fortigateDevice.toLowerCase());
  }
  return out;
}

/** Apply one string operator. `matches` is a shell-style wildcard. */
function compareString(operator: string, haystack: string, needle: string): boolean {
  switch (operator) {
    case "equals": return haystack === needle;
    case "notEquals": return haystack !== needle;
    case "contains": return haystack.includes(needle);
    case "notContains": return !haystack.includes(needle);
    case "startsWith": return haystack.startsWith(needle);
    case "endsWith": return haystack.endsWith(needle);
    case WILDCARD_OP: {
      // compileWildcard memoizes per pattern — this is reached per asset per
      // rule per engine tick via loadScopeAssets, not just the one-asset
      // contact path it was written for. A bad pattern was already refused at
      // save, so this can only throw on a row written before the operator was
      // validated — false, not an exception.
      try { return compileWildcard(needle).test(haystack); } catch { return false; }
    }
    default: return false;
  }
}

/** Is `operator` one that asserts ABSENCE? Those must hold for every candidate. */
function isNegativeStringOp(operator: string): boolean {
  return operator === "notEquals" || operator === "notContains";
}

/**
 * The POSITIVE form of a string operator. `notEquals` / `notContains` assert the
 * absence of a match, so both halves of a pair are answered by the same test —
 * which is what lets a prefetching loader ask the database once for "assets with
 * an interface equal to port9" and serve both.
 */
export function positiveStringOp(operator: string): string {
  return operator === "notEquals" ? "equals" : operator === "notContains" ? "contains" : operator;
}

/**
 * Prefetch/lookup key for one relation-backed leaf — the FIELD plus the
 * positive operator plus the value, so `equals port9` and `notEquals port9`
 * share one entry (both are answered by the same query, inverted) while
 * `interfaceName equals GUEST` and `ssid equals GUEST` never collide now that
 * two relations share one map. `scopeRelationIndex.ts` builds the map;
 * `matchScopeRule` reads it.
 */
export function relationLeafKey(rule: ScopeConditionRule): string {
  return rule.field + "|" + leafOpValueKey(rule);
}

/** Is this leaf a `subnet` rule matched by registry Subnet NAME? Those are
 *  the leaves `decorateRelationLeafHits` resolves besides the relation ones. */
export function isSubnetNameLeaf(rule: ScopeConditionRule): boolean {
  return rule.field === "subnet" && (SUBNET_NAME_OPS as readonly string[]).includes(rule.operator);
}

/** Prefetch key for a subnet-name leaf. Both halves of the pair share it — the
 *  negation is the same lookup, inverted — and the pattern is trimmed and
 *  lower-cased exactly as the resolver compares it. */
export function subnetNameLeafKey(rule: ScopeConditionRule): string {
  return "subnet|named\u0000" + rule.value.trim().toLowerCase();
}

/** The operator+value half of the key — the part both halves of a negative
 *  pair share. Separate only so the field can be prefixed above. */
function leafOpValueKey(rule: ScopeConditionRule): string {
  return positiveStringOp(rule.operator) + "\u0000" + rule.value.toLowerCase();
}

/**
 * One rule against SEVERAL values on the same asset — the shape both
 * multi-valued fields need (`fortigate`'s gate names, `interfaceName`'s
 * interface inventory).
 *
 * A positive operator is satisfied by ANY value; a negative one has to hold for
 * ALL of them, or "not behind CENTRALFMG1" would be true for a device sighted
 * behind it as soon as it was also sighted somewhere else, and "has no interface
 * named port9" would be true for a switch carrying both port9 and port10.
 *
 * With nothing known at all — no sightings, no interface inventory — a positive
 * claim fails and an absence claim holds, the same reading `notHas` gives an
 * untagged asset.
 */
function matchMultiValue(rule: ScopeConditionRule, values: string[], needle: string): boolean {
  if (values.length === 0) return isNegativeStringOp(rule.operator);
  return isNegativeStringOp(rule.operator)
    ? values.every((n) => compareString(rule.operator, n, needle))
    : values.some((n) => compareString(rule.operator, n, needle));
}

/** Every interface name the asset currently reports, lower-cased. */
function interfaceNames(asset: ScopeConditionAsset): string[] {
  const out: string[] = [];
  for (const i of asset.interfaces ?? []) {
    if (i.ifName) out.push(i.ifName.toLowerCase());
  }
  return out;
}

/** Every native VLAN the asset's ports carry, as canonical id strings. */
function nativeVlanIds(asset: ScopeConditionAsset): string[] {
  const out = new Set<string>();
  for (const i of asset.interfaces ?? []) {
    if (i.nativeVlan != null) out.add(String(i.nativeVlan));
  }
  return Array.from(out);
}

/** Every SSID the asset is currently broadcasting, lower-cased. One SSID is
 *  commonly broadcast by several VAPs (one per radio), so this deduplicates —
 *  otherwise a negative operator has to hold against the same name twice,
 *  which is harmless, and a positive one short-circuits anyway. */
function broadcastSsids(asset: ScopeConditionAsset): string[] {
  const out = new Set<string>();
  for (const v of asset.apVaps ?? []) {
    if (v.ssid) out.add(v.ssid.toLowerCase());
  }
  return Array.from(out);
}

function matchScopeRule(rule: ScopeConditionRule, asset: ScopeConditionAsset): boolean {
  const v = rule.value.toLowerCase();
  const str = (raw: string | null | undefined): string => (raw ?? "").toLowerCase();
  switch (rule.field) {
    case "assetType": {
      const eq = str(asset.assetType) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "status": {
      const eq = str(asset.status) === v;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "assetId": {
      const eq = (asset.id ?? "") === rule.value;
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "tag": {
      const has = (asset.tags ?? []).some((t) => t.toLowerCase() === v);
      return rule.operator === "notHas" ? !has : has;
    }
    case "subnet":
    case "ipBlock": {
      // One predicate for both CIDR-valued fields: an IP block is stored as its
      // own CIDR, so "inside the block" IS "inside that range". They stay
      // separate FIELDS because the pickers differ and the specificity ladder
      // ranks a block below a subnet — see SCOPE_RANK.
      const ip = asset.ipAddress ?? "";
      if ((SUBNET_NAME_OPS as readonly string[]).includes(rule.operator)) {
        // Resolved against the subnet registry by decorateRelationLeafHits; an
        // undecorated row is read as "in no such subnet" — the same answer an
        // asset with no address gets.
        const inside = asset.relationLeafHits?.get(subnetNameLeafKey(rule)) === true;
        return rule.operator === "notInSubnetNamed" ? !inside : inside;
      }
      if ((SUBNET_RANGE_OPS as readonly string[]).includes(rule.operator)) {
        const inside = !!ip && ipInIpv4Range(ip, rule.value);
        return rule.operator === "notInRange" ? !inside : inside;
      }
      let inside = false;
      if (ip) {
        try { inside = ipInCidr(ip, scopeCidrOf(rule.value)); } catch { inside = false; }
      }
      return rule.operator === "notInCidr" ? !inside : inside;
    }
    case "fortigate": return matchMultiValue(rule, fortigateNames(asset), v);
    case "agentInstalled": {
      // "Has an ACTIVE agent" — prefetched per leaf by scopeRelationIndex on
      // fleet paths (the verdict is value-independent), else read off the
      // joined row. An absent prefetch key is unknown, so fall through.
      const pre = asset.relationLeafHits;
      const key = relationLeafKey(rule);
      const has = pre && pre.has(key)
        ? pre.get(key) === true
        : asset.managedAgent?.installStatus === "active";
      const eq = has === (v === "yes" || v === "true");
      return rule.operator === "notEquals" ? !eq : eq;
    }
    case "interfaceName":
    case "ssid": {
      // Two ways in, one predicate, for both relation-backed fields. A
      // fleet-scale loader resolves each leaf in SQL and stamps the verdict
      // onto the row (decorateRelationLeafHits), so 2000 devices worth of port
      // names never reach this process; the single-asset paths join the
      // relation and compare it here. Both answer "does ANY value satisfy the
      // positive form", inverted for a negative operator, and both read an
      // empty inventory the same way.
      //
      // has() rather than get() is the load-bearing part: a leaf the decoration
      // did not prefetch is UNKNOWN, not false, and falls through to the
      // relation instead of silently answering no.
      const pre = asset.relationLeafHits;
      const key = relationLeafKey(rule);
      if (pre && pre.has(key)) {
        const hit = pre.get(key) === true;
        return isNegativeStringOp(rule.operator) ? !hit : hit;
      }
      const values = rule.field === "ssid" ? broadcastSsids(asset) : interfaceNames(asset);
      return matchMultiValue(rule, values, v);
    }
    case "nativeVlan": {
      // The interfaceName arm's two ways in, compared by NUMBER: the needle is
      // the canonical id, so "030" and "30" are one VLAN on both paths. A value
      // that is no VLAN id (only a row written past validation) matches no
      // port — a positive claim fails, an absence claim holds.
      const pre = asset.relationLeafHits;
      const key = relationLeafKey(rule);
      if (pre && pre.has(key)) {
        const hit = pre.get(key) === true;
        return isNegativeStringOp(rule.operator) ? !hit : hit;
      }
      const id = parseVlanId(rule.value);
      return matchMultiValue(rule, nativeVlanIds(asset), id == null ? "\u0000" : String(id));
    }
    default: { // manufacturer / model / hostname / os (+ the device-filter
      // extras: osVersion / department / location) — string ops
      return compareString(rule.operator, scopeStringField(rule.field, asset), v);
    }
  }
}

/**
 * Evaluate a condition tree against an asset. Empty-group semantics follow
 * boolean identities (and([])=true, or([])=false, none=¬or, notAll=¬and) —
 * the wizard converts an empty ROOT group to allAssets, so stored trees
 * always carry at least one rule.
 */
export function evaluateScopeCondition(cond: ScopeConditionGroup, asset: ScopeConditionAsset): boolean {
  const results = cond.children.map((c) =>
    "op" in c ? evaluateScopeCondition(c as ScopeConditionGroup, asset) : matchScopeRule(c as ScopeConditionRule, asset),
  );
  switch (cond.op) {
    case "and": return results.every(Boolean);
    case "or": return results.some(Boolean);
    case "none": return !results.some(Boolean);
    case "notAll": return !results.every(Boolean);
    default: return false;
  }
}

export const scopeSchema = z
  .object({
    allAssets: z.boolean().optional(),
    assetTypes: z.array(z.string().max(100)).max(100).optional(),
    tags: z.array(z.string().max(100)).max(200).optional(),
    assetIds: z.array(z.string().max(100)).max(2000).optional(),
    integrationIds: z.array(z.string().max(100)).max(200).optional(),
    // Case-insensitive CONTAINS match per entry ("Cisco" matches
    // "Cisco Systems, Inc."), OR within the list — same AND-across/OR-within
    // semantics as the other dimensions.
    manufacturers: z.array(z.string().min(1).max(100)).max(100).optional(),
    models: z.array(z.string().min(1).max(100)).max(100).optional(),
    // CIDRs (or bare IPs = /32, /128 for v6) the asset's primary IP must fall
    // inside. Validated at save; matched in memory (ipInCidr) after the SQL pass.
    subnetCidrs: z
      .array(
        z.string().min(1).max(100).refine((c) => isValidCidr(c) || isValidIpAddress(c), {
          message: "must be a CIDR (e.g. 10.20.0.0/16) or an IP address",
        }),
      )
      .max(100)
      .optional(),
    // Nested AND/OR condition tree (the wizard's device-filter builder).
    // Authoritative when present; the flat dimensions above remain for
    // API-written and pre-builder rules (both AND together if combined).
    condition: scopeConditionSchema.optional().nullable(),
  })
  .strict()
  .superRefine((sc, ctx) => {
    if (sc.condition) {
      const { depth, rules } = scopeConditionStats(sc.condition);
      if (depth > SCOPE_CONDITION_MAX_DEPTH) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: `condition groups nest at most ${SCOPE_CONDITION_MAX_DEPTH} deep` });
      if (rules > SCOPE_CONDITION_MAX_RULES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: `at most ${SCOPE_CONDITION_MAX_RULES} rules per condition tree` });
    }
  });

/** Bare IP → host CIDR so scope subnet entries accept either form. */
export function scopeCidrOf(entry: string): string {
  return isValidIpAddress(entry) ? entry + (entry.includes(":") ? "/128" : "/32") : entry;
}
