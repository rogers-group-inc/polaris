/**
 * src/services/notificationTypes/specificity.ts — automation precedence (CQ-B063, moved verbatim from notificationTypes.ts): the specificity ranking, the trigger
 * signature (the carve-out "same trigger" key) and the carve-out shared by the engine and
 * the asset Alerts tab.
 */

import { ipInCidr } from "../../utils/cidr.js";
import { type ScopeConditionRule, type ScopeConditionGroup, type ScopeConditionAsset, evaluateScopeCondition, scopeCidrOf } from "./scopeConditions.js";
import { type Trigger, type RuleScope } from "./triggers.js";
import { type ResetConfig } from "./actions.js";

// ─── Specificity ranking (automation precedence / carve-out) ────────────────
// A more-specific automation carves the assets it covers out of a less-specific
// one that watches the SAME trigger (triggerSignature). Specificity = the
// most-specific scope dimension an automation positively constrains, on this
// ladder (least → most). Lifecycle status + asset id are deliberately absent —
// status is a state qualifier, not an identity dimension, and asset id is no
// longer offered in the builder.
export const SCOPE_RANK = {
  allAssets: 0,
  assetType: 1,
  os: 2,
  manufacturer: 3,
  model: 4,
  tag: 5,
  region: 6,
  // An IP block CONTAINS subnets, so it targets less precisely than one — a
  // block rule loses the carve-out to a subnet rule over the same trigger.
  ipBlock: 7,
  subnet: 8,
  hostname: 9,
} as const;

/** Ladder for the wizard's "Specificity: …" indicator (least → most). */
export const SCOPE_RANK_LADDER: { key: keyof typeof SCOPE_RANK; label: string }[] = [
  { key: "allAssets", label: "All assets" },
  { key: "assetType", label: "Device type" },
  { key: "os", label: "Operating system" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "model", label: "Model" },
  { key: "tag", label: "Tag" },
  { key: "region", label: "Region" },
  { key: "ipBlock", label: "IP block" },
  { key: "subnet", label: "Subnet" },
  { key: "hostname", label: "Hostname" },
];

/** Human label for a numeric specificity rank (the ladder rung at or below it). */
export function scopeRankLabel(rank: number): string {
  let label = SCOPE_RANK_LADDER[0].label;
  for (const rung of SCOPE_RANK_LADDER) {
    if (SCOPE_RANK[rung.key] <= rank) label = rung.label;
  }
  return label;
}

// Condition-rule operators that POSITIVELY narrow to specific assets. Negative
// operators (notEquals/notHas/…) and none/notAll groups broaden rather than
// target, so they never raise specificity.
const POSITIVE_SCOPE_OPS = new Set(["equals", "contains", "startsWith", "endsWith", "has", "inCidr", "inRange", "inSubnetNamed"]);

function isRegionTagValue(v: string): boolean {
  return v.trim().toLowerCase().startsWith("region:");
}

function conditionRuleRank(rule: ScopeConditionRule): number {
  if (!POSITIVE_SCOPE_OPS.has(rule.operator)) return 0;
  switch (rule.field) {
    case "assetType": return SCOPE_RANK.assetType;
    case "os": return SCOPE_RANK.os;
    case "manufacturer": return SCOPE_RANK.manufacturer;
    case "model": return SCOPE_RANK.model;
    case "tag": return isRegionTagValue(rule.value) ? SCOPE_RANK.region : SCOPE_RANK.tag;
    case "ipBlock": return SCOPE_RANK.ipBlock;
    case "subnet": return SCOPE_RANK.subnet;
    case "hostname": return SCOPE_RANK.hostname;
    // status / assetId / interfaceName — not on the ladder. An interface is a
    // COMPONENT of a device, not a way of saying WHICH devices an automation is
    // about, so "switches with a fortilink port" is exactly as specific as
    // "switches" and the two tie rather than carving each other up.
    default: return 0;
  }
}

function conditionTreeRank(group: ScopeConditionGroup): number {
  // Only AND/OR subtrees positively target; none/notAll invert to "must NOT".
  if (group.op !== "and" && group.op !== "or") return 0;
  let rank = 0;
  for (const child of group.children) {
    rank = Math.max(
      rank,
      "op" in child ? conditionTreeRank(child as ScopeConditionGroup) : conditionRuleRank(child as ScopeConditionRule),
    );
  }
  return rank;
}

/**
 * Specificity rank of a scope = the most-specific dimension it positively
 * constrains, across BOTH the flat dimensions and the condition tree. 0 =
 * all-assets / unconstrained.
 */
export function scopeRank(scope: RuleScope): number {
  let rank = 0;
  if (scope.assetTypes?.length) rank = Math.max(rank, SCOPE_RANK.assetType);
  if (scope.manufacturers?.length) rank = Math.max(rank, SCOPE_RANK.manufacturer);
  if (scope.models?.length) rank = Math.max(rank, SCOPE_RANK.model);
  if (scope.subnetCidrs?.length) rank = Math.max(rank, SCOPE_RANK.subnet);
  for (const t of scope.tags ?? []) {
    rank = Math.max(rank, isRegionTagValue(t) ? SCOPE_RANK.region : SCOPE_RANK.tag);
  }
  if (scope.condition) rank = Math.max(rank, conditionTreeRank(scope.condition));
  return rank;
}

/**
 * Minimal asset shape needed to evaluate scope membership. Extends the
 * condition-evaluator's field vocabulary (notificationTypes.ScopeConditionAsset)
 * so the flat-scope matcher and the condition tree can never drift apart —
 * this layer just requires the dimensions the flat matcher always reads.
 */
export interface ScopeAsset extends ScopeConditionAsset {
  assetType: string | null;
  tags: string[];
  discoveredByIntegrationId: string | null;
}

/**
 * Does this scope narrow anything at all? `{allAssets:true}` says so outright;
 * a bare `{}` is the same answer arrived at differently — it is what the wizard
 * WROTE for every event automation before device filters reached that trigger
 * type (business rule 46), and what an API caller who omits `scope` gets. Both
 * mean "any device", so a caller that filters on scope must ask this FIRST:
 * `scopeMatchesAsset({}, …)` is false (it matches nothing), which is the right
 * answer for a builder-authored scope and exactly the wrong one for those rows.
 */
export function scopeIsUnconstrained(scope: RuleScope | null | undefined): boolean {
  if (!scope) return true;
  if (scope.allAssets) return true;
  const lists = [scope.assetTypes, scope.tags, scope.assetIds, scope.integrationIds, scope.manufacturers, scope.models, scope.subnetCidrs];
  if (lists.some((l) => l && l.length > 0)) return false;
  // An empty tree ANDs to true for every asset, so it selects nothing either.
  return !(scope.condition && scope.condition.children.length > 0);
}

/**
 * Does `scope` select `asset`? AND across the provided dimensions, OR within
 * each list. `allAssets` short-circuits true. A scope with no dimensions and
 * allAssets unset matches NOTHING (the builder requires an explicit selection).
 * KEEP IN LOCKSTEP with the engine's SQL `scopeWhere` + loadScopeAssets
 * subnet post-filter (notificationEngine.ts) — this is the in-memory twin.
 */
export function scopeMatchesAsset(scope: RuleScope, asset: ScopeAsset): boolean {
  if (scope.allAssets) return true;
  let anyDimension = false;

  if (scope.assetTypes && scope.assetTypes.length > 0) {
    anyDimension = true;
    if (!scope.assetTypes.includes(asset.assetType ?? "")) return false;
  }
  if (scope.tags && scope.tags.length > 0) {
    anyDimension = true;
    const set = new Set(asset.tags.map((t) => t.toLowerCase()));
    if (!scope.tags.some((t) => set.has(t.toLowerCase()))) return false;
  }
  if (scope.assetIds && scope.assetIds.length > 0) {
    anyDimension = true;
    if (!scope.assetIds.includes(asset.id)) return false;
  }
  if (scope.integrationIds && scope.integrationIds.length > 0) {
    anyDimension = true;
    if (!scope.integrationIds.includes(asset.discoveredByIntegrationId ?? "")) return false;
  }
  if (scope.manufacturers && scope.manufacturers.length > 0) {
    anyDimension = true;
    const mfr = (asset.manufacturer ?? "").toLowerCase();
    if (!mfr || !scope.manufacturers.some((m) => mfr.includes(m.toLowerCase()))) return false;
  }
  if (scope.models && scope.models.length > 0) {
    anyDimension = true;
    const model = (asset.model ?? "").toLowerCase();
    if (!model || !scope.models.some((m) => model.includes(m.toLowerCase()))) return false;
  }
  if (scope.subnetCidrs && scope.subnetCidrs.length > 0) {
    anyDimension = true;
    const ip = asset.ipAddress ?? "";
    if (!ip) return false;
    const inAny = scope.subnetCidrs.some((c) => {
      try { return ipInCidr(ip, scopeCidrOf(c)); } catch { return false; }
    });
    if (!inAny) return false;
  }
  // Nested condition tree (the wizard's builder). ANDs with any flat
  // dimensions above when both are present.
  if (scope.condition) {
    anyDimension = true;
    if (!evaluateScopeCondition(scope.condition, asset)) return false;
  }
  return anyDimension;
}

// ─── Trigger signature (carve-out "same trigger" key) ───────────────────────
// Two automations carve-out only when they watch the SAME thing. The signature
// is the metric/field + its dimension filter (strict: a sensor-class filter and
// no filter are different things and never shadow each other — erring toward an
// extra alert over a wrongly-silenced one). Returns null for triggers that
// don't participate in carve-out (host has no asset scope; composite watches
// many things; event/change are per-event, not per-asset thresholds).
function stableDimFilter(df: Record<string, unknown> | undefined | null): string {
  if (!df) return "";
  const keys = Object.keys(df).filter((k) => df[k] !== undefined && df[k] !== null && df[k] !== "").sort();
  return keys.map((k) => `${k}=${String(df[k])}`).join(",");
}

export function triggerSignature(trigger: Trigger): string | null {
  if (trigger.type === "asset_metric") return `am:${trigger.metric}:${stableDimFilter(trigger.dimensionFilter)}`;
  if (trigger.type === "asset_state") {
    // monitorStatus is the one state field that is a SINGLE per-asset column
    // with no reading dimensions of its own (neither FIELD_DIMENSIONS nor
    // STATE_FIELD_DIMENSIONS carries an entry for it), so the only
    // dimensionFilter it can legally hold is a DEVICE filter — one that narrows
    // the asset SET rather than the reading. Two automations watching
    // "monitorStatus == down" with different device filters are therefore still
    // watching the same one thing on overlapping devices, and must be able to
    // carve each other out; keying on the filter would put them in different
    // groups and let both claim authority over the same asset. Hence: filter
    // dropped, and the compared VALUE added in its place, because "== down" and
    // "== warning" genuinely ARE different things to watch — and only
    // "== down" carries down-detection authority (see downDetectionService).
    //
    // The device filter does NOT stop mattering; it moves to where coverage is
    // actually tested (isAssetShadowed / carveOutAggregate both AND
    // deviceFilterMatch into their scope test), so a filtered peer only shadows
    // the assets it can genuinely fire on.
    if (trigger.field === "monitorStatus") {
      return `as:monitorStatus:${trigger.operator}${String(trigger.value).toLowerCase()}`;
    }
    // Like monitorStatus, the compared value is part of what is being watched:
    // "tagged prod" and "tagged dev" are different things, so two automations on
    // them must not carve each other out.
    if (trigger.field === "tag") {
      return `as:tag:${trigger.operator}${String(trigger.value).toLowerCase()}:${stableDimFilter(trigger.dimensionFilter)}`;
    }
    return `as:${trigger.field}:${stableDimFilter(trigger.dimensionFilter)}`;
  }
  return null;
}

// ─── Specificity carve-out (shared by the engine and the asset Alerts tab) ──
// A more-specific automation carves the assets it covers out of a
// less-specific one watching the SAME triggerSignature. The engine builds the
// index once per tick; findRulesMatchingAsset builds it over the enabled rule
// set so the asset-details "automations that can trigger" list drops the ones
// the engine would never evaluate for that asset.

/** The rule fields the carve-out reads. */
export interface ShadowRule {
  id: string;
  trigger: Trigger;
  scope: RuleScope;
}

interface ShadowMember<R extends ShadowRule> {
  rule: R;
  rank: number;
}

export interface ShadowIndex<R extends ShadowRule = ShadowRule> {
  /** signature → participating rules (with precomputed scopeRank). */
  bySig: Map<string, ShadowMember<R>[]>;
  /** signature → highest rank present (skip the per-asset check for max-rank rules). */
  maxRankBySig: Map<string, number>;
}

export function buildShadowIndex<R extends ShadowRule>(rules: R[]): ShadowIndex<R> {
  const bySig = new Map<string, ShadowMember<R>[]>();
  const maxRankBySig = new Map<string, number>();
  for (const rule of rules) {
    const sig = triggerSignature(rule.trigger);
    if (!sig) continue;
    const rank = scopeRank(rule.scope);
    const arr = bySig.get(sig);
    if (arr) arr.push({ rule, rank });
    else bySig.set(sig, [{ rule, rank }]);
    maxRankBySig.set(sig, Math.max(maxRankBySig.get(sig) ?? 0, rank));
  }
  return { bySig, maxRankBySig };
}

/**
 * Does a peer rule genuinely COVER this asset — i.e. could it produce a reading
 * for it at all? Scope alone is not the whole answer: a trigger's device
 * filter (hostname / IP / MAC / manufacturer / model) narrows the asset set
 * just as scope does, so a peer scoped to all assets but filtered to
 * `hostname matches "core-"` covers only the core switches.
 *
 * This used to be scope-only, which was safe while `triggerSignature` pinned
 * the dimensionFilter — two differently-filtered rules were in different
 * signature groups and never compared. Now that monitorStatus rules group by
 * value instead (so down automations with different device filters CAN carve
 * each other out), the filter has to be tested here or a filtered peer would
 * shadow every asset in its scope, including ones it can never fire on.
 *
 * For asset_metric this is a no-op: peers in a signature group have identical
 * filters by construction, so the predicate short-circuits in applyDeviceFilters'
 * "no patterns set" check.
 */
function peerCoversAsset(peer: ShadowRule, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(peer.scope, asset)) return false;
  const df = (peer.trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] }).dimensionFilter;
  if (!df) return true;
  const rec = df as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return true;
  return deviceFilterMatch(df, asset);
}

/** Does a higher-rank same-signature rule also cover this asset? */
export function isAssetShadowed(index: ShadowIndex<ShadowRule>, rule: ShadowRule, sig: string, rank: number, asset: ScopeAsset): boolean {
  const group = index.bySig.get(sig);
  if (!group) return false;
  for (const other of group) {
    if (other.rule.id === rule.id) continue;
    if (other.rank > rank && peerCoversAsset(other.rule, asset)) return true;
  }
  return false;
}

/**
 * The missed-poll count applied to a device governed by a down-detection
 * automation that carries no explicit count — the pre-cutover baseline row, or
 * a body from a client older than the field.
 *
 * MUST track `HARDCODED_FLOOR.failureThreshold` in monitoringService: it is the
 * same number, and the point of the default is that such a rule keeps behaving
 * exactly as it did before the count became operator-visible. Defined here
 * rather than in downDetectionService because the schema catalog needs it and
 * importing the service would close a cycle.
 */
export const DEFAULT_MISSED_POLLS = 3;

/**
 * Does this trigger DEFINE what "down" means for the devices it covers?
 *
 * A `monitorStatus == down` automation is no longer just a reader of the column
 * — its `missedPolls` count is what `recordProbeResult` compares
 * consecutiveFailures against for every asset it governs (most-specific-wins,
 * business rule 18's ladder). An asset covered by no such automation is never
 * judged at all: it reads `passive`.
 *
 * Lives here rather than in downDetectionService because the schema layer
 * (validateRuleV2) needs it and importing the service would close a cycle.
 */
export function isDownDetectionTrigger(trigger: Trigger): boolean {
  return (
    trigger.type === "asset_state" &&
    trigger.field === "monitorStatus" &&
    trigger.operator === "==" &&
    String(trigger.value).toLowerCase() === "down"
  );
}

/**
 * Does this down automation speak for its devices while they are dependency-
 * suppressed (business rule 78)?
 *
 * The ONE reader of `trigger.alertWhenDependencyDown`. Gated on
 * `isDownDetectionTrigger` rather than on the key alone so a key that survived
 * on a trigger edited away from "monitor status is down" (a pre-validation
 * import, a hand-written body) can never turn a CPU automation into one that
 * fires about silenced devices. The engine's gate (`assetCanTrigger`) is
 * otherwise unchanged: maintenance still silences, and every other automation
 * still drops a suppressed asset.
 */
export function ruleAlertsWhenDependencyDown(trigger: Trigger): boolean {
  return isDownDetectionTrigger(trigger) && (trigger as { alertWhenDependencyDown?: boolean }).alertWhenDependencyDown === true;
}

/**
 * The reset sustain, in seconds, when it is a RECOVERY COUNT and not merely the
 * alert's clock — i.e. an automatic reset that asks the recovery to hold.
 *
 * On a down-detection automation the wizard's reset step already asks the
 * question in polls ("N received polls before reset"), and rule 36 made the
 * automation the authority on what `down` means. The two together mean the
 * count has to reach the STATE MACHINE, not just the alert row: an operator who
 * writes "down after 3 missed, reset after 5 received" is describing the pill,
 * and a device that went green at 3 while the alert sat firing for another 5
 * was Polaris disagreeing with itself in the one place an operator watches
 * probe by probe (the asset's intermittency strip).
 *
 * Null for every other reset mode. `manual` / `timed` / `condition` / `event`
 * say nothing about how many probes must answer, and a `condition` tree in
 * particular is its own recovery authority (business rule 32a) — layering a
 * poll count under it would give one alert two clocks that disagree.
 *
 * Takes `unknown` so the down-detection index can hand it a raw Prisma JSON
 * column without parsing the whole rule first; it is on the index BUILD path
 * (once per TTL), never the per-probe path.
 */
export function downRecoverySustainSec(reset: unknown): number | null {
  const r = reset as { mode?: unknown; sustainSec?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || r.mode !== "auto") return null;
  return typeof r.sustainSec === "number" && r.sustainSec > 0 ? r.sustainSec : null;
}

/**
 * The same recovery hold as the COUNT the operator actually stated
 * (`reset.sustainPolls`), which is what `recoveryPollsFor` should use when it
 * has one: dividing the seconds mirror by the asset's cadence returns their
 * number only when the cadence hasn't changed since they typed it, and rounds
 * to something else when it has. Null when the reset states only seconds — the
 * pre-count shape, and the one the division exists for.
 */
export function downRecoveryPolls(reset: unknown): number | null {
  const r = reset as { mode?: unknown; sustainPolls?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || r.mode !== "auto") return null;
  return typeof r.sustainPolls === "number" && r.sustainPolls > 0 ? Math.round(r.sustainPolls) : null;
}

/**
 * Has this rule's reset sustain been CONSUMED by the monitor state machine?
 *
 * True exactly when a down-detection trigger carries an auto reset with a hold:
 * `recordProbeResult` is holding the asset in `recovering` until the count is
 * met, so the engine must not charge the same wait a second time — and it must
 * not treat `recovering` as recovered, or the alert would clear on the FIRST
 * answered packet, which is earlier than it cleared before this existed.
 * `notificationEngine.recoveredMeets` is the single reader.
 */
export function downRecoveryConsumesSustain(trigger: Trigger, reset: ResetConfig): boolean {
  // Either spelling counts: a reset that states only a COUNT is still a hold
  // the monitor state machine is serving, and missing that would let the engine
  // charge the wait a second time.
  return isDownDetectionTrigger(trigger) && (downRecoverySustainSec(reset) !== null || downRecoveryPolls(reset) !== null);
}

/**
 * The monitor states a `monitorStatus == down` alert stays FIRING through when
 * its sustain is consumed by the state machine. `down` is the obvious one;
 * `recovering` is the corridor the asset climbs on its way back, and the whole
 * point of the count is that the corridor is not yet a recovery. `warning`
 * belongs here too — a device that answered once and then missed again is
 * further from recovered than one that is climbing, and letting it clear the
 * alert would reward flapping.
 */
export const DOWN_ALERT_HOLDING_STATES: readonly string[] = ["down", "recovering", "warning"];

// Which dimensionFilter inputs are relevant per asset_metric metric, so the
// builder only shows the applicable ones.
/** Case-insensitive substring test used by every `*Pattern` dimension filter.
 *  An unset needle matches everything (the filter is optional). */
export function dimensionSubstringMatch(haystack: string | null | undefined, needle?: string | null): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

// ── Device-identifier dimensions ─────────────────────────────────────────────
// Applicable to EVERY asset_metric and asset_state trigger (never host_metric —
// there is no asset). They filter the ASSET SET before any sample query runs
// (notificationEngine.applyDeviceFilters); the wizard authors them as filter
// rows in the condition tree. See the dimensionFilterSchema note above.
export const DEVICE_FILTER_DIMENSIONS = [
  "hostnamePattern", "ipPattern", "macPattern", "manufacturerPattern", "modelPattern",
] as const;

/**
 * IP dimension matcher. Substring over dotted quads lies ("10.1.1.5" is inside
 * "110.1.1.55"), so the pattern is: a CIDR ("/" present) → containment; a
 * trailing-dot prefix ("10.4.1.") → startsWith; otherwise exact address OR an
 * octet-boundary prefix ("10.4" matches 10.4.x.x, never 10.40.x.x). MIRRORED
 * client-side by the wizard's match cue — keep the two in lockstep.
 */
export function ipDimensionMatch(ip: string | null | undefined, pattern?: string | null): boolean {
  if (!pattern) return true;
  const value = (ip ?? "").trim();
  if (!value) return false;
  const p = pattern.trim();
  if (!p) return true;
  if (p.includes("/")) {
    try { return ipInCidr(value, p); } catch { return false; }
  }
  if (p.endsWith(".")) return value.startsWith(p);
  return value === p || value.startsWith(p + ".");
}

/**
 * MAC dimension matcher: separator-insensitive substring — "aa-bb-cc",
 * "aabb.cc" and "AA:BB:CC" all select the same devices, because operators
 * paste MACs in whatever shape their last tool printed. MIRRORED client-side
 * by the wizard's match cue — keep the two in lockstep.
 */
export function macDimensionMatch(mac: string | null | undefined, pattern?: string | null): boolean {
  if (!pattern) return true;
  const strip = (v: string) => v.toLowerCase().replace(/[^0-9a-f]/g, "");
  const needle = strip(pattern);
  if (!needle) return true;
  return strip(mac ?? "").includes(needle);
}

/** The asset fields the device-identifier dimensions read. */
export interface DeviceFilterAsset {
  hostname?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  manufacturer?: string | null;
  model?: string | null;
}

/**
 * Does a trigger's dimensionFilter select this DEVICE? One predicate shared by
 * the engine's asset-set narrowing (applyDeviceFilters) and the chart-shading
 * lookup (getMetricSeverityTiers) — a second copy is how a chart comes to
 * shade with thresholds that can't fire on that asset. No filter = everything.
 */
export function deviceFilterMatch(
  df: { hostnamePattern?: string; ipPattern?: string; macPattern?: string; manufacturerPattern?: string; modelPattern?: string } | null | undefined,
  asset: DeviceFilterAsset,
): boolean {
  if (!df) return true;
  if (!dimensionSubstringMatch(asset.hostname, df.hostnamePattern)) return false;
  if (!ipDimensionMatch(asset.ipAddress, df.ipPattern)) return false;
  if (!macDimensionMatch(asset.macAddress, df.macPattern)) return false;
  if (!dimensionSubstringMatch(asset.manufacturer, df.manufacturerPattern)) return false;
  return dimensionSubstringMatch(asset.model, df.modelPattern);
}
