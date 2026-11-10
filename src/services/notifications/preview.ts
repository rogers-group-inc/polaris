/**
 * src/services/notifications/preview.ts — the automation builder's Test button (CQ-B063, moved verbatim from notificationEngine.ts): previewing which devices a
 * rule would fire on now, and why.
 */

import { prisma } from "../../db.js";
import { triggerSummary, triggerTokenParts } from "../../utils/triggerSummary.js";
import { chartTokensForAlert, chartTokenForMetric, CHART_TOKENS, type ChartToken } from "../alertChartService.js";
import { PATH_GRAPH_METRICS } from "../alertPathGraphService.js";
import { INTERFACE_DIMENSION_METRICS } from "../alertInterfaceService.js";
import { processRankingForMetric } from "../alertProcessService.js";
import { pathTriggerIncludesServer, scopeForTrigger, type Trigger, type RuleScope, type PreviewRuleInput, type CompositeTrigger, type SeverityBand, type Severity, severityForValue, dimensionNounOf, normalizeEscalationToV2, triggerSignature, scopeRank, scopeRankLabel, forecastLevelsSourceId, forecastLevelsOf, FORECAST_HORIZON_METRICS, DEVICE_FILTER_DIMENSIONS, deviceFilterMatch, scopeIsUnconstrained, ruleAlertsWhenDependencyDown } from "../notificationTypes.js";
import { scopeMatchesAsset, type ScopeAsset } from "../notificationRuleService.js";
import { decorateRelationLeafHits } from "../scopeRelationIndex.js";
import { buildComposedEmail } from "../notificationRecipientService.js";
import { buildTemplateContext, renderNotificationTemplate, notificationsPageUrl, TEMPLATE_VARIABLES, type TemplateContextParts, type TemplateVariableScope } from "../../utils/notificationTemplate.js";
import { DbRule, ScopeAssetRow, Reading, collectLeafRefs } from "./ruleModel.js";
import { ASSET_DETAIL_SELECT } from "./assetDetail.js";
import { loadScopeAssets } from "./scope.js";
import { resolveAssetMetricReadings, resolveAssetStateReadings, resolveHostMetricReading, readingMeets, recoveredMeets } from "./readings.js";
import { CompositeFireInfo, readingContextParts, renderMessage } from "./templating.js";
import { resolveLeafTruths, CompositeOutcome, compositeOutcomeForAsset, leafConditionLabel, compositeFireInfo, HOST_PSEUDO_ASSET, serverPathReadings } from "./evaluation.js";
import { applyLinkedForecastLevels } from "./eventTail.js";

// ─── Preview (builder Test button) ──────────────────────────────────────────

export interface PreviewMatch {
  assetId: string | null;
  hostname: string | null;
  /** Display label, e.g. "CPU ON-DIE Temperature (temperature)". */
  dimension: string;
  /** The RAW dimension key the engine keys state on (a bare sensor name, an
   *  interface, a mount) — usable as a query argument without parsing the
   *  label apart. */
  dimensionKey?: string;
  value: number | string | boolean | null;
  meets: boolean;
  /** Hysteresis view (only when the draft has reset.mode=auto + clearThreshold):
   *  would a firing alert on this reading clear? A reading that neither meets
   *  nor clears sits in the dead band. */
  wouldClear?: boolean;
  inDeadBand?: boolean;
  /** Composite drafts only — per-condition breakdown, one row per asset.
   *  leafId is the trigger-tree path ("0", "1.2") so the wizard can highlight
   *  its builder rows; noData marks "false because absent", not measured. */
  leaves?: Array<{
    leafId: string;
    label: string;
    met: boolean;
    value: number | string | boolean | null;
    dimension: string;
    noData: boolean;
  }>;
  /** Composite drafts only — "k of n conditions met". */
  conditionsSummary?: string;
  /** Severity bands: the severity this value lands in (null = below tier 0). */
  severity?: string | null;
  /** Precedence: a more-specific same-trigger automation already covers this
   *  asset, so the draft won't alert on it. */
  excludedBy?: { ruleId: string; ruleName: string };
}

/** Precedence carve-out summary for a draft (both authoring directions). */
export interface CarveOutSummary {
  /** Direction 1 — assets carved OUT of this (more-general) draft by existing
   *  higher-rank same-trigger automations. */
  carvedOut?: { count: number; byRule: { ruleId: string; ruleName: string; count: number }[] };
  /** Direction 2 — existing lower-rank same-trigger automations this (more-
   *  specific) draft will remove assets FROM. */
  carvesFrom?: { ruleId: string; ruleName: string; count: number; sampleHostnames: string[] }[];
}

export interface PreviewResult {
  supported: boolean;
  note?: string;
  totalEvaluated: number;
  /** DISTINCT devices behind `totalEvaluated`. A per-dimension metric yields one
   *  reading per sensor / interface / mount, so a fleet of 8 firewalls with 6
   *  temperature sensors each evaluates 48 readings across 8 devices — the
   *  wizard must not report that as "48 devices". Absent for host-only drafts
   *  (no asset scope) and for the unsupported event/change note. */
  totalAssets?: number;
  /** Scope matches that are NOT monitored — counted, never listed. The filter
   *  still SELECTS those devices (a scope is a device filter, not a monitoring
   *  decision), but no trigger fires about them, so the count is stated rather
   *  than hidden. Only the device-list preview sets it; a metric preview has
   *  no readings for them either way. */
  unmonitoredCount?: number;
  /** Readings that meet the trigger right now, counted over EVERY evaluated
   *  reading rather than the capped `matches` window — the wizard's "N of M
   *  currently match" line reported the capped number before, which undercounts
   *  as soon as the fleet is bigger than the cap. */
  meetsCount: number;
  /** What is left after precedence carve-out — the readings / DISTINCT devices
   *  this draft will actually alert on. Present only when something was carved
   *  out (absent = nothing was, so `totalEvaluated` / `totalAssets` already are
   *  the covered counts). The wizard lists these, not the carved-out remainder:
   *  "who will this alert on" is the question the Devices step asks. */
  coveredEvaluated?: number;
  coveredAssets?: number;
  matches: PreviewMatch[];
  /** Rendered sample of the composed email (first match), when the draft has emailComposition. */
  emailPreview?: { subject: string; text: string; html?: string };
  /** Precedence carve-out (present only for asset_metric/asset_state drafts). */
  carveOut?: CarveOutSummary;
  /** Draft scope specificity (asset-scoped drafts) — drives the wizard's
   *  "Specificity" indicator + explains carve-out ranking. */
  specificity?: { rank: number; label: string };
}

/** A same-signature peer rule for carve-out computation. */
export interface CarveOutPeer {
  id: string;
  name: string;
  scope: RuleScope;
  rank: number;
  /** The peer trigger's device filter, when it has one. Coverage is scope AND
   *  filter — see peerCoversAsset. Optional so existing callers/tests that
   *  build unfiltered peers stay valid. */
  dimensionFilter?: Parameters<typeof deviceFilterMatch>[0];
}

/** Coverage test for a carve-out peer — the CarveOutPeer twin of
 *  peerCoversAsset, kept beside it so the preview and the engine agree. */
function carveOutPeerCovers(peer: CarveOutPeer, asset: ScopeAsset): boolean {
  if (!scopeMatchesAsset(peer.scope, asset)) return false;
  if (!peer.dimensionFilter) return true;
  const rec = peer.dimensionFilter as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return true;
  return deviceFilterMatch(peer.dimensionFilter, asset);
}

/** Pure carve-out aggregation: given the draft's rank, the assets its scope
 *  matches, and the same-signature peer rules, compute per-asset excludedBy
 *  (direction 1) + the summary (dir 1 + dir 2). No DB access — unit-testable. */
export function carveOutAggregate(
  draftRank: number,
  scopeAssets: ScopeAsset[],
  peers: CarveOutPeer[],
): { excludedBy: Map<string, { ruleId: string; ruleName: string }>; summary: CarveOutSummary } {
  const excludedBy = new Map<string, { ruleId: string; ruleName: string }>();
  const higher = peers.filter((o) => o.rank > draftRank);
  const lower = peers.filter((o) => o.rank < draftRank);

  // Direction 1: assets a higher-rank same-signature rule already covers — the
  // draft won't alert on them. Attribute each to its highest-rank coverer.
  const byRule = new Map<string, { ruleName: string; count: number }>();
  for (const a of scopeAssets) {
    let best: CarveOutPeer | null = null;
    for (const o of higher) {
      if (carveOutPeerCovers(o, a) && (!best || o.rank > best.rank)) best = o;
    }
    if (best) {
      excludedBy.set(a.id, { ruleId: best.id, ruleName: best.name });
      const e = byRule.get(best.id) ?? { ruleName: best.name, count: 0 };
      e.count++;
      byRule.set(best.id, e);
    }
  }

  // Direction 2: lower-rank rules this (more-specific) draft will carve assets
  // from — the authoring warning "creating this removes N devices from X".
  const carvesFrom: NonNullable<CarveOutSummary["carvesFrom"]> = [];
  for (const o of lower) {
    const hit = scopeAssets.filter((a) => carveOutPeerCovers(o, a));
    if (hit.length) {
      carvesFrom.push({ ruleId: o.id, ruleName: o.name, count: hit.length, sampleHostnames: hit.slice(0, 5).map((a) => a.hostname ?? a.id) });
    }
  }

  const summary: CarveOutSummary = {};
  if (excludedBy.size) {
    summary.carvedOut = { count: excludedBy.size, byRule: Array.from(byRule.entries()).map(([ruleId, v]) => ({ ruleId, ruleName: v.ruleName, count: v.count })) };
  }
  if (carvesFrom.length) summary.carvesFrom = carvesFrom;
  return { excludedBy, summary };
}

/** Compute the precedence carve-out for a draft against the other enabled
 *  same-signature rules (both authoring directions): fetch peers, delegate to
 *  the pure carveOutAggregate. */
async function computeCarveOut(
  input: PreviewRuleInput,
  scopeAssets: ScopeAssetRow[],
): Promise<{ excludedBy: Map<string, { ruleId: string; ruleName: string }>; summary: CarveOutSummary }> {
  const sig = input.trigger ? triggerSignature(input.trigger) : null;
  if (!sig || scopeAssets.length === 0) return { excludedBy: new Map(), summary: {} };

  const others = await prisma.notificationRule.findMany({
    where: { enabled: true, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true, name: true, trigger: true, scope: true },
  });
  const peers: CarveOutPeer[] = others
    .filter((o) => triggerSignature(o.trigger as unknown as Trigger) === sig)
    .map((o) => ({
      id: o.id,
      name: o.name,
      scope: (o.scope ?? {}) as RuleScope,
      rank: scopeRank((o.scope ?? {}) as RuleScope),
      // A monitorStatus signature no longer pins the device filter, so peers in
      // this group may be filtered differently from the draft — carry it so
      // coverage is tested rather than assumed.
      dimensionFilter: (o.trigger as { dimensionFilter?: Parameters<typeof deviceFilterMatch>[0] } | null)?.dimensionFilter,
    }));
  if (peers.length === 0) return { excludedBy: new Map(), summary: {} };

  // Same reason as the engine tick: a peer may filter by interface even when the
  // draft does not, and carveOutPeerCovers reads the verdict off the row. The
  // rows arrive already decorated for the DRAFT's own leaves; this merges the
  // peers' on top.
  await decorateRelationLeafHits(scopeAssets, peers.map((p) => p.scope?.condition));

  return carveOutAggregate(scopeRank(input.scope), scopeAssets, peers);
}

/**
 * Stamp `excludedBy` on the carved-out matches, order them BEHIND the rest,
 * and count what is left. Sorts in place; returns the covered counts.
 *
 * The order matters because the caller caps the list at 200 rows and the
 * wizard's Devices step draws "the devices this automation will alert on" from
 * it. On an all-assets draft over a fleet already covered by per-type
 * automations the carved-out rows are the overwhelming majority (2254 of 2412
 * on the prod fleet), so a meets-only sort filled the entire window with
 * devices the draft can never fire about and the handful it does own never
 * appeared at all. Within each group the original meets-first order holds.
 */
export function applyCarveOutToMatches(
  matches: PreviewMatch[],
  excludedBy: Map<string, { ruleId: string; ruleName: string }>,
): { evaluated: number; assets: number } {
  for (const m of matches) {
    if (m.assetId && excludedBy.has(m.assetId)) m.excludedBy = excludedBy.get(m.assetId);
  }
  matches.sort((a, b) => Number(!!a.excludedBy) - Number(!!b.excludedBy) || Number(b.meets) - Number(a.meets));
  const keep = matches.filter((m) => !m.excludedBy);
  return { evaluated: keep.length, assets: new Set(keep.map((m) => m.assetId).filter(Boolean)).size };
}

/** A preview input with a linked forecast's levels swapped in, as the tick
 *  would evaluate it — a copy, the caller's input is untouched. */
async function previewInputWithLinkedLevels(input: PreviewRuleInput): Promise<PreviewRuleInput> {
  if (!input.trigger || !forecastLevelsSourceId(input.trigger)) return input;
  const copy = { ...input, severityBands: input.severityBands ?? null } as PreviewRuleInput & { severityBands: SeverityBand[] | null };
  await applyLinkedForecastLevels([copy as unknown as Pick<DbRule, "trigger" | "severity" | "severityBands">]);
  return copy;
}

/** Dry-run a draft rule against current data with NO writes. A draft without
 *  a trigger is a SCOPE-ONLY preview: list the devices the scope matches
 *  (the wizard's asset-filtering step). */
/** Draft DbRule assembled from a preview input — what both preview paths render templates against. */
function draftRuleForPreview(input: PreviewRuleInput, trigger: DbRule["trigger"]): DbRule {
  return {
    id: "", name: input.name, description: input.description ?? null, severity: input.severity,
    trigger, scope: input.scope, resetActions: input.resetActions ?? null, repeat: input.repeat ?? null,
    reset: input.reset, actions: input.actions, cooldownSec: input.cooldownSec ?? null,
    messageTemplate: input.messageTemplate ?? null,
    emailComposition: input.emailComposition, escalation: normalizeEscalationToV2(input.escalation),
    severityBands: input.severityBands, bandNotify: input.bandNotify,
    // A preview writes nothing, so grouping cannot change what it reports per
    // reading — but the draft still carries the operator's choice so the
    // preview's own grouped roll-up ("47 interfaces → 12 alerts") can count it.
    groupByAsset: input.groupByAsset === true,
    // A preview writes nothing and joins nothing, so it never resolves a group.
    alertGroupId: null,
  };
}

/**
 * Rendered composed-email sample for a preview — templates only, no recipient
 * resolution. Direct asset fetch (not the per-tick cache — preview runs in
 * the web process).
 */
async function renderPreviewEmail(
  draft: DbRule,
  composition: NonNullable<PreviewRuleInput["emailComposition"]>,
  sample: Reading,
  fireInfo?: CompositeFireInfo,
): Promise<NonNullable<PreviewResult["emailPreview"]>> {
  const detail = sample.assetId
    ? await prisma.asset.findUnique({ where: { id: sample.assetId }, select: ASSET_DETAIL_SELECT })
    : null;
  const ctx = buildTemplateContext({
    ...readingContextParts(draft, sample, new Date(), fireInfo),
    assetDetail: detail ? { ...detail, status: String(detail.status) } : null,
  });
  ctx["message"] = renderMessage(draft, sample, ctx);
  const composed = buildComposedEmail(composition, ctx);
  return { subject: composed.subject, text: composed.text, html: composed.html };
}

export async function previewRule(rawInput: PreviewRuleInput): Promise<PreviewResult> {
  const input = await previewInputWithLinkedLevels(rawInput);
  const trigger = input.trigger;
  let readings: Reading[] = [];

  if (!trigger) {
    // Device-list preview: MONITORED devices are what the operator is choosing
    // between, so they're what the list and the count report. The unmonitored
    // remainder is stated rather than hidden — the filter still selects those
    // devices, they just can't trigger anything (assetCanTrigger). Loaded
    // UNFILTERED for exactly that reason: the count is the point.
    const all = await loadScopeAssets(input.scope);
    const assets = all.filter((a) => a.monitored);
    const listed: PreviewMatch[] = assets.map((a) => ({
      assetId: a.id,
      hostname: a.hostname,
      dimension: "",
      value: null,
      meets: true,
    }));
    // Precedence carve-out (business rule 18): when the wizard passes the
    // draft's trigger, devices a more-specific same-trigger automation already
    // covers are stamped and ordered last, and the covered counts say how many
    // are left — the same computation the Test step and the engine use, so the
    // Devices step cannot disagree with who the automation will alert on.
    const carve = input.carveOutTrigger
      ? await computeCarveOut({ ...input, trigger: input.carveOutTrigger }, assets)
      : null;
    const covered = carve && carve.excludedBy.size ? applyCarveOutToMatches(listed, carve.excludedBy) : undefined;
    const sigTrigger = input.carveOutTrigger;
    return {
      supported: true,
      totalEvaluated: assets.length,
      totalAssets: assets.length,
      meetsCount: assets.length,
      unmonitoredCount: all.length - assets.length,
      ...(covered ? { coveredEvaluated: covered.evaluated, coveredAssets: covered.assets } : {}),
      matches: listed.slice(0, 200),
      ...(carve && (carve.summary.carvedOut || carve.summary.carvesFrom) ? { carveOut: carve.summary } : {}),
      ...(sigTrigger && (sigTrigger.type === "asset_metric" || sigTrigger.type === "asset_state")
        ? { specificity: { rank: scopeRank(input.scope), label: scopeRankLabel(scopeRank(input.scope)) } }
        : {}),
    };
  }

  if (trigger.type === "composite") {
    return previewCompositeRule(trigger, input);
  }

  let scopeAssets: ScopeAssetRow[] = [];
  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
  } else if (trigger.type === "asset_metric") {
    scopeAssets = await loadScopeAssets(scopeForTrigger(input.scope, trigger), { monitoredOnly: true });
    readings = await resolveAssetMetricReadings(trigger, scopeAssets, undefined, undefined, forecastLevelsOf(trigger, input.severity, input.severityBands));
    if (pathTriggerIncludesServer(trigger)) readings = [...readings, ...(await serverPathReadings(trigger))];
  } else if (trigger.type === "asset_state") {
    scopeAssets = await loadScopeAssets(input.scope, { monitoredOnly: true });
    readings = await resolveAssetStateReadings(trigger, scopeAssets);
  } else {
    // Event / change drafts have nothing to evaluate against current data —
    // they fire on new audit events. What they DO have, once the operator
    // narrows them (business rule 46), is a device filter with a definite
    // membership right now, and that is the half the Devices step is asking
    // about. So: list it, and say plainly that the list is who it would fire
    // ABOUT rather than who is currently triggering it.
    const eventNote = "Event and change automations fire on new audit events, so there's nothing to evaluate against current data.";
    if (scopeIsUnconstrained(input.scope)) {
      return { supported: false, note: eventNote, totalEvaluated: 0, meetsCount: 0, matches: [] };
    }
    const listed = await previewRule({ ...input, trigger: undefined });
    return { ...listed, note: eventNote + " These are the devices the filter selects — the automation only fires about these." };
  }

  // Severity bands: the tier a value lands in (numeric triggers only).
  const banded = !!(input.severityBands && input.severityBands.length) && (trigger.type === "asset_metric" || trigger.type === "host_metric");
  const bandSevOf = (v: number | string | boolean | null): string | null =>
    banded && (trigger.type === "asset_metric" || trigger.type === "host_metric")
      ? severityForValue(trigger.operator, trigger.threshold, input.severity as Severity, input.severityBands as SeverityBand[], typeof v === "number" ? v : null)
      : null;

  const showHysteresis = input.reset.mode === "auto" && input.reset.clearThreshold != null;
  const matches: PreviewMatch[] = readings.map((r) => {
    const meets = readingMeets(trigger, r.value);
    const base: PreviewMatch = { assetId: r.assetId || null, hostname: r.hostname, dimension: r.dimLabel, dimensionKey: r.dimKey, value: r.value, meets };
    if (banded) base.severity = bandSevOf(r.value);
    if (showHysteresis) {
      const wouldClear = recoveredMeets(trigger, input.reset, r.value);
      base.wouldClear = wouldClear;
      base.inDeadBand = !meets && !wouldClear;
    }
    return base;
  });
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));

  // Precedence carve-out (both authoring directions) for asset-scoped drafts.
  const { excludedBy, summary: carveOut } = await computeCarveOut(input, scopeAssets);
  const covered = excludedBy.size ? applyCarveOutToMatches(matches, excludedBy) : undefined;

  // Rendered sample of the composed email against the best reading (first
  // matching, else first evaluated) — templates only, no recipient resolution.
  let emailPreview: PreviewResult["emailPreview"];
  // Composition or not: every email notify action now renders through the
  // shared default template, so a draft that customized nothing still has a
  // real email worth previewing.
  if (readings.length > 0) {
    const draft = draftRuleForPreview(input, trigger);
    const sample = readings.find((r) => readingMeets(trigger, r.value)) ?? readings[0];
    emailPreview = await renderPreviewEmail(draft, input.emailComposition ?? {}, sample);
  }

  return {
    supported: true,
    totalEvaluated: readings.length,
    // Counted over every reading, not the capped window below — the cap now
    // orders by carve-out first, so a count taken from it would move with the
    // precedence picture rather than with the data.
    meetsCount: matches.filter((m) => m.meets).length,
    // Per-dimension metrics fan out to several readings per device; the device
    // count is what the wizard headlines. Host drafts have no asset scope.
    ...(trigger.type === "host_metric"
      ? {}
      : { totalAssets: new Set(readings.map((r) => r.assetId).filter(Boolean)).size }),
    ...(covered ? { coveredEvaluated: covered.evaluated, coveredAssets: covered.assets } : {}),
    matches: matches.slice(0, 200),
    emailPreview,
    ...(carveOut.carvedOut || carveOut.carvesFrom ? { carveOut } : {}),
    ...(trigger.type === "asset_metric" || trigger.type === "asset_state"
      ? { specificity: { rank: scopeRank(input.scope), label: scopeRankLabel(scopeRank(input.scope)) } }
      : {}),
  };
}

/** Composite dry-run: one PreviewMatch per asset with a per-leaf breakdown
 *  (met / measured-false / noData) in tree order. Suppression is NOT applied —
 *  preview answers "would this fire on current data", not "is it silenced". */
async function previewCompositeRule(trigger: CompositeTrigger, input: PreviewRuleInput): Promise<PreviewResult> {
  const assets = trigger.kind === "host" ? [HOST_PSEUDO_ASSET] : await loadScopeAssets(scopeForTrigger(input.scope, trigger), { monitoredOnly: true });
  const leaves = collectLeafRefs(trigger);
  const truths = await resolveLeafTruths(leaves, assets);

  const matches: PreviewMatch[] = [];
  let evaluated = 0;
  const outcomes = new Map<string, CompositeOutcome>();
  for (const a of assets) {
    const outcome = compositeOutcomeForAsset(trigger, a.id, leaves, truths);
    if (!outcome.hasAnyReading) continue; // nothing measured — not evaluated
    outcomes.set(a.id, outcome);
    evaluated++;
    matches.push({
      assetId: a.id || null,
      hostname: a.hostname,
      dimension: "",
      value: null,
      meets: outcome.meets,
      leaves: leaves.map(({ leafId, leaf }) => {
        const t = truths.get(leafId)?.get(a.id);
        const src = t?.witness ?? t?.sample ?? null;
        return {
          leafId,
          label: leafConditionLabel(leaf),
          met: t?.met === true,
          value: src?.value ?? null,
          dimension: src?.dimLabel ?? "",
          noData: !t?.hasReading,
        };
      }),
      conditionsSummary: `${outcome.metLeaves.length} of ${outcome.totalLeaves} conditions met`,
    });
  }
  matches.sort((a, b) => Number(b.meets) - Number(a.meets));

  let emailPreview: PreviewResult["emailPreview"];
  if (input.emailComposition && matches.length > 0) {
    const draft = draftRuleForPreview(input, trigger);
    const best = matches[0];
    const outcome = outcomes.get(best.assetId ?? "")!;
    const sample: Reading = { assetId: best.assetId ?? "", hostname: best.hostname, tags: [], dimKey: "", dimLabel: "", value: null };
    emailPreview = await renderPreviewEmail(draft, input.emailComposition, sample, compositeFireInfo(outcome));
  }

  // Composite drafts already evaluate ONE row per asset, so the two counts agree.
  return {
    supported: true,
    totalEvaluated: evaluated,
    meetsCount: matches.filter((m) => m.meets).length,
    ...(trigger.kind === "host" ? {} : { totalAssets: evaluated }),
    matches: matches.slice(0, 200),
    emailPreview,
  };
}

/** How many of the draft's devices the in-app example's picker offers. */
const MESSAGE_EXAMPLE_CANDIDATE_CAP = 200;

/**
 * Which catalogued tokens this trigger can ever give a value — the wizard's
 * variable list shows the rest folded away as "not used by this trigger".
 * Answers TemplateVariable.appliesTo from the same predicates the fire and
 * delivery paths gate on (dimensionNounOf, chartTokensForAlert,
 * INTERFACE_DIMENSION_METRICS, processRankingForMetric,
 * ruleAlertsWhenDependencyDown), so the list cannot offer a token the alert
 * will silently drop. A multiple-conditions trigger counts a token when ANY of
 * its leaves would — except the per-reading ones (component, interface,
 * processes, a scoped chart), which a composite alert never fills: it is one
 * alert per device with no single metric behind it.
 */
export function applicableTemplateTokens(trigger: Trigger | null | undefined): string[] {
  type Leafish = { type: string; metric?: string; field?: string; changeType?: string };
  const t = trigger as (Leafish & { kind?: string }) | null | undefined;
  const isHost = !!t && (t.type === "host_metric" || (t.type === "composite" && t.kind === "host"));
  const isComposite = t?.type === "composite";
  const isEvent = t?.type === "event" || t?.type === "change";
  const keyOf = (x: Leafish): string | null =>
    x.type === "asset_metric" || x.type === "host_metric" ? x.metric ?? null
      : x.type === "asset_state" ? x.field ?? null
        // An SD-WAN failover is the one change event charted as a metric.
        : x.type === "change" && x.changeType === "sdwan_failover" ? "sdwanSelectedMember"
          : null;
  const metricKey = t && !isComposite ? keyOf(t) : null;
  // A chart needs a device to read samples for; a host trigger has none. A
  // WAN port and a mount are taken as present — the list says what CAN render,
  // the email decides what does. The sensor chart is the exception: delivery
  // hands every alert's dimension over as a "sensor name", so only a sensor
  // trigger has one that names a real sensor.
  const charts: Set<ChartToken> = !t || isHost
    ? new Set()
    : chartTokensForAlert(CHART_TOKENS, metricKey, { port: true, sensor: chartTokenForMetric(metricKey) === "chart.sensor", mount: true });
  if (charts.size && !isComposite && chartTokenForMetric(metricKey)) charts.add("chart.trigger");
  const has: Record<TemplateVariableScope, boolean> = {
    device: !!t && !isHost,
    metric: !!t && !isComposite && t.type !== "event",
    threshold: !!t && (t.type === "asset_metric" || t.type === "asset_state" || t.type === "host_metric"),
    component: !!t && !isComposite && dimensionNounOf(t) !== "",
    composite: isComposite,
    event: isEvent,
    chart: charts.size > 0,
    interface: !!metricKey && t?.type !== "change" && INTERFACE_DIMENSION_METRICS.has(metricKey),
    processes: !isHost && !!metricKey && processRankingForMetric(metricKey) !== null,
    dependency: !!t && ruleAlertsWhenDependencyDown(t as Trigger),
    path: !!metricKey && PATH_GRAPH_METRICS.has(metricKey),
    forecast: !!metricKey && (FORECAST_HORIZON_METRICS as readonly string[]).includes(metricKey),
  };
  return TEMPLATE_VARIABLES
    .filter((v) => {
      if (!v.appliesTo) return true;
      if (v.appliesTo === "chart") return charts.has(v.token.slice(1, -1) as ChartToken);
      return has[v.appliesTo];
    })
    .map((v) => v.token);
}

export interface MessageExampleResult {
  /** The devices the example can be about — the draft's monitored scope, capped. */
  candidates: Array<{ id: string; hostname: string | null }>;
  /** More devices matched than `candidates` carries. */
  truncated: boolean;
  /** The device the example is about; null for a host trigger or an empty scope. */
  asset: { id: string; hostname: string | null } | null;
  /** The in-app alert text, rendered exactly the way a fire renders it. */
  message: string;
  severity: string;
  /** Token (no braces) → what it renders to for this device. Deferred tokens
   *  ({ack}, {chart.*} …) are absent: they are filled at delivery time. */
  values: Record<string, string>;
  /** The draft has no readings for this device right now — {value} is "n/a". */
  noReading: boolean;
  /** Tokens this trigger can give a value (applicableTemplateTokens). */
  applicable: string[];
}

/**
 * The wizard's In-app Alert example: the draft's message rendered against ONE
 * real device from its own scope — `assetId` when it is in scope, otherwise a
 * random pick — through the same context builder and `renderMessage` a fire
 * uses, so the example cannot word itself differently from the real alert.
 *
 * Read-only, like previewRule. The value is the device's CURRENT reading (the
 * first one that meets the trigger, else the first at all); an event/change
 * trigger has no reading to take, so its `{value}` is a stand-in that says so.
 */
export async function previewAlertMessage(rawInput: PreviewRuleInput, assetId?: string | null): Promise<MessageExampleResult> {
  const input = await previewInputWithLinkedLevels(rawInput);
  const trigger = input.trigger;
  const isHost = !!trigger && (trigger.type === "host_metric" || (trigger.type === "composite" && trigger.kind === "host"));
  const scopeAssets = isHost ? [] : await loadScopeAssets(scopeForTrigger(input.scope, trigger), { monitoredOnly: true });
  const candidates = scopeAssets
    .map((a) => ({ id: a.id, hostname: a.hostname }))
    .sort((a, b) => (a.hostname ?? a.id).localeCompare(b.hostname ?? b.id));
  const picked = isHost
    ? null
    : scopeAssets.find((a) => a.id === assetId) ?? (scopeAssets.length ? scopeAssets[Math.floor(Math.random() * scopeAssets.length)] : null);

  // The draft's trigger, or a stand-in state trigger for a draft that has none
  // yet — readingContextParts / renderMessage need SOME trigger to word from.
  const draftTrigger = (trigger ?? { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }) as DbRule["trigger"];
  const draft = draftRuleForPreview(input, draftTrigger);

  let reading: Reading = {
    assetId: picked?.id ?? "",
    hostname: picked?.hostname ?? (isHost ? "Polaris" : null),
    tags: [], dimKey: "", dimLabel: "", value: null,
  };
  let fireInfo: CompositeFireInfo | undefined;
  let noReading = false;
  if (trigger && trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    if (r) reading = r; else noReading = true;
  } else if (picked && trigger && (trigger.type === "asset_metric" || trigger.type === "asset_state")) {
    const rs = trigger.type === "asset_metric"
      ? await resolveAssetMetricReadings(trigger, [picked], undefined, undefined, forecastLevelsOf(trigger, input.severity, input.severityBands))
      : await resolveAssetStateReadings(trigger, [picked]);
    const r = rs.find((x) => readingMeets(trigger, x.value)) ?? rs[0];
    if (r) reading = r; else noReading = true;
  } else if (trigger && trigger.type === "composite") {
    const assets = trigger.kind === "host" ? [HOST_PSEUDO_ASSET] : picked ? [picked] : [];
    if (assets.length) {
      const leaves = collectLeafRefs(trigger);
      const truths = await resolveLeafTruths(leaves, assets);
      const outcome = compositeOutcomeForAsset(trigger, assets[0].id, leaves, truths);
      if (outcome.hasAnyReading) fireInfo = compositeFireInfo(outcome); else noReading = true;
    }
  }

  const severity = (trigger && (trigger.type === "asset_metric" || trigger.type === "host_metric") && input.severityBands && input.severityBands.length && typeof reading.value === "number")
    ? severityForValue(trigger.operator, trigger.threshold, input.severity as Severity, input.severityBands as SeverityBand[], reading.value) ?? input.severity
    : input.severity;

  const detail = picked
    ? await prisma.asset.findUnique({ where: { id: picked.id }, select: ASSET_DETAIL_SELECT })
    : null;
  const isEvent = !!trigger && (trigger.type === "event" || trigger.type === "change");
  const eventStandIn = "(the source event’s own message)";
  const eventAction = trigger && trigger.type === "event" ? trigger.actionPattern ?? ""
    : trigger && trigger.type === "change" ? trigger.changeType ?? "" : "";
  const parts: TemplateContextParts = isEvent
    ? {
      asset: picked?.hostname ?? "",
      metric: eventAction,
      value: eventStandIn,
      threshold: "",
      metricLabel: triggerTokenParts(trigger as never).metricLabel,
      dimension: "",
      severity,
      time: new Date(),
      link: notificationsPageUrl(),
      ruleName: draft.name,
      ruleDescription: draft.description,
      event: { action: eventAction || null, message: eventStandIn, resourceName: picked?.hostname ?? null, resourceType: picked ? "asset" : null },
      triggerSummary: triggerSummary({ trigger: trigger as never, eventResource: picked?.hostname ?? null }),
    }
    : { ...readingContextParts(draft, reading, new Date(), fireInfo), severity };
  const ctx = buildTemplateContext({
    ...parts,
    assetDetail: detail ? { ...detail, status: String(detail.status) } : null,
  });
  let message: string;
  if (isEvent) {
    const tmpl = draft.messageTemplate;
    message = tmpl && tmpl.trim() ? renderNotificationTemplate(tmpl, ctx) : `${draft.name}: ${eventStandIn}`;
  } else {
    message = renderMessage(draft, reading, ctx);
  }
  ctx["message"] = message;

  return {
    candidates: candidates.slice(0, MESSAGE_EXAMPLE_CANDIDATE_CAP),
    truncated: candidates.length > MESSAGE_EXAMPLE_CANDIDATE_CAP,
    asset: picked ? { id: picked.id, hostname: picked.hostname } : null,
    message,
    severity,
    values: ctx,
    noReading,
    applicable: applicableTemplateTokens(trigger),
  };
}
