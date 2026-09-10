/**
 * src/services/notificationRuleService.ts
 *
 * Notification RULE business logic: scope matching (which assets a rule
 * applies to), the "rules matching this asset" lookup behind the asset-details
 * Notifications tab, and (Stage 4) rule CRUD + the change-type subscription
 * cache. Scope matching is shared by the asset tab and the builder's preview
 * so they can't drift.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { createTtlCache } from "../utils/ttlCache.js";
import type { RuleScope, Trigger, RuleInput, Severity, CompositeLeaf, TriggerConditionGroup } from "./notificationTypes.js";
import {
  isAssetScopedTrigger,
  isTriggerLeaf,
  resolveTierLadder,
  severityRank,
  hwSensorFilterMatches,
  deviceFilterMatch,
  CHANGE_TYPE_ACTIONS,
  legacyMirrorOfV2,
  normalizeRuleToV2,
  normalizeEscalationToV2,
  allRuleActionRefs,
  notifyChannelIds,
  evaluateScopeCondition,
} from "./notificationTypes.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { listRegions, REGION_TAG_CATEGORY } from "./mapRegionService.js";
import { regionLevelIndex } from "./regionHierarchyService.js";
import { ipInCidr } from "../utils/cidr.js";
import { invalidateDownDetectionCache } from "./downDetectionService.js";
import { scopeMatchesAsset } from "./notificationTypes.js";

/**
 * Scope membership (ScopeAsset + scopeMatchesAsset) now lives in
 * notificationTypes beside the condition evaluator it delegates to, so that
 * downDetectionService can reach it without importing this module — which
 * imports downDetectionService to invalidate its cache on every rule write.
 * Re-exported here because the engine, the routes and the tests have always
 * imported it from this path.
 */
export { scopeMatchesAsset, type ScopeAsset } from "./notificationTypes.js";

/**
 * Enabled, asset-scoped rules whose scope matches the given asset. Backs the
 * asset-details Alerts tab's "automations that can trigger for this asset"
 * table. One findMany + in-memory filter (rule counts are small).
 *
 * Rows go out through `withV2` like every other read path: clicking a name in
 * that table opens the SAME edit wizard the Automations page uses, and a
 * pre-v2 row handed over with NULL reset/actions would open with its actions
 * missing and save them away.
 */
export async function findRulesMatchingAsset(assetId: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, assetType: true, tags: true, discoveredByIntegrationId: true, manufacturer: true, model: true, ipAddress: true, hostname: true, os: true, status: true },
  });
  if (!asset) return [];

  const rules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });

  return rules
    .filter((r) => {
      const trigger = r.trigger as unknown as Trigger;
      if (!isAssetScopedTrigger(trigger)) return false;
      return scopeMatchesAsset((r.scope ?? {}) as RuleScope, asset);
    })
    .map(withV2);
}

/** One severity threshold that applies to a charted metric on one asset. */
export interface MetricSeverityTier {
  severity: Severity;
  /** Ordered comparator — ">"/">=" color ABOVE the threshold, "<"/"<=" BELOW. */
  operator: ">" | ">=" | "<" | "<=";
  threshold: number;
  ruleId: string;
  ruleName: string;
}

/** Ordered comparators only: an `==`/`!=` trigger has no "worse in this
 *  direction" reading, so there is nothing to shade on a chart. */
function orderedOperator(op: string): MetricSeverityTier["operator"] | null {
  return op === ">" || op === ">=" || op === "<" || op === "<=" ? op : null;
}

/**
 * The severity thresholds that would fire on ONE asset's charted metric, so the
 * asset-detail chart can shade its line with the same numbers the engine
 * evaluates instead of a second copy of them.
 *
 * Sources, per enabled scope-matching automation (`findRulesMatchingAsset`):
 *  - a numeric single trigger on `metric` → its `resolveTierLadder` (tier 0 =
 *    the rule's own severity/threshold, plus every severity band on top);
 *  - a COMPOSITE trigger → each leaf on `metric` at the rule's severity (bands
 *    aren't valid on composites, so there's no ladder to resolve).
 *
 * `dimension` is the concrete thing being charted (a sensor's name + class);
 * a rule whose dimensionFilter doesn't select it is skipped — shading a fan's
 * chart with a temperature automation's 35 °C would be a lie. When two
 * automations set the same severity at different thresholds the MORE SENSITIVE
 * one wins (lowest for `>=`, highest for `<=`) — that's where that severity
 * first appears, which is what the shading is showing.
 *
 * Deliberately does NOT apply the rule-18 carve-out: precedence decides which
 * automation NOTIFIES, and a carved-out asset still crosses the same value. The
 * chart answers "what does this reading mean", not "which rule pages someone".
 */
export async function getMetricSeverityTiers(
  assetId: string,
  metric: string,
  dimension?: { sensorName?: string; sensorClass?: string },
): Promise<MetricSeverityTier[]> {
  const rules = await findRulesMatchingAsset(assetId);
  const collected: MetricSeverityTier[] = [];
  // A trigger carrying device-identifier dimensions (hostname / IP / MAC /
  // manufacturer / model) only evaluates devices it matches — shading this
  // asset's chart with a rule that filters it out would paint thresholds that
  // can never fire here. Same predicate the engine narrows with
  // (deviceFilterMatch). Fetched once; rules is often empty but the extra
  // findUnique is one indexed row.
  const asset = rules.length
    ? await prisma.asset.findUnique({
        where: { id: assetId },
        select: { hostname: true, ipAddress: true, macAddress: true, manufacturer: true, model: true },
      })
    : null;
  const deviceFilterSelects = (df: Parameters<typeof deviceFilterMatch>[0]): boolean =>
    deviceFilterMatch(df, asset ?? {});

  for (const row of rules) {
    const v2 = normalizeRuleToV2(row as Parameters<typeof normalizeRuleToV2>[0]);
    const trigger = row.trigger as unknown as Trigger;
    const ruleSeverity = String(row.severity) as Severity;
    const push = (op: string, threshold: unknown, severity: Severity) => {
      const operator = orderedOperator(op);
      if (!operator || typeof threshold !== "number" || !Number.isFinite(threshold)) return;
      collected.push({ severity, operator, threshold, ruleId: row.id, ruleName: row.name });
    };

    if (trigger.type === "asset_metric" && trigger.metric === metric) {
      if (!deviceFilterSelects(trigger.dimensionFilter)) continue;
      if (metric === "hwSensorValue" && dimension && !hwSensorFilterMatches(trigger.dimensionFilter, dimension)) continue;
      for (const tier of resolveTierLadder(trigger.operator, trigger.threshold, ruleSeverity, trigger.forDurationSec ?? 0, v2.severityBands)) {
        push(tier.operator, tier.threshold, tier.severity as Severity);
      }
      continue;
    }

    if (trigger.type === "composite") {
      for (const leaf of collectCompositeMetricLeaves(trigger)) {
        if (leaf.type !== "asset_metric" || leaf.metric !== metric) continue;
        if (!deviceFilterSelects(leaf.dimensionFilter)) continue;
        if (metric === "hwSensorValue" && dimension && !hwSensorFilterMatches(leaf.dimensionFilter, dimension)) continue;
        push(leaf.operator, leaf.threshold, ruleSeverity);
      }
    }
  }

  // One tier per severity: keep the most sensitive threshold in its direction.
  const bySeverity = new Map<string, MetricSeverityTier>();
  for (const t of collected) {
    const key = `${t.severity}|${t.operator === ">" || t.operator === ">=" ? "up" : "down"}`;
    const prev = bySeverity.get(key);
    if (!prev) { bySeverity.set(key, t); continue; }
    const moreSensitive = key.endsWith("up") ? t.threshold < prev.threshold : t.threshold > prev.threshold;
    if (moreSensitive) bySeverity.set(key, t);
  }
  return Array.from(bySeverity.values()).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** Flatten a composite trigger's tree to its leaves (groups nest ≤3 deep).
 *  Starts from `children`, NOT the trigger itself: `isTriggerLeaf` is a
 *  `"type" in node` test and the composite root carries `type: "composite"`, so
 *  walking from the root would classify the whole tree as one leaf. */
function collectCompositeMetricLeaves(trigger: Extract<Trigger, { type: "composite" }>): CompositeLeaf[] {
  const out: CompositeLeaf[] = [];
  const walk = (node: TriggerConditionGroup | CompositeLeaf): void => {
    if (isTriggerLeaf(node)) { out.push(node); return; }
    for (const child of node.children ?? []) walk(child);
  };
  for (const child of trigger.children ?? []) walk(child);
  return out;
}

/** How many distinct interface names the "Device interface" picker offers. A
 *  fleet reuses port names, so this is generous; the field accepts free text
 *  either way, so the cap bounds the payload and never the filter. */
const INTERFACE_NAME_OPTION_CAP = 500;

/**
 * Option lists for the wizard's device-filtering pickers: distinct
 * manufacturers/models present in the inventory, the interface names the
 * monitored fleet reports + the defined (non-deprecated) IPAM subnets. Distinct
 * queries only — cheap at 2000 assets.
 */
export async function listScopeOptions(): Promise<{
  manufacturers: string[];
  models: string[];
  /** Distinct interface names the MONITORED fleet currently reports, for the
   *  condition builder's "Device interface" picker. Capped — see the query. */
  interfaceNames: string[];
  /** Distinct SSIDs the MONITORED fleet is currently broadcasting, for the
   *  "Broadcast SSID" picker. Same monitored-only rule: an SSID only
   *  unmonitored APs carry is a choice that cannot produce an alert. */
  ssids: string[];
  subnets: { id: string; name: string; cidr: string }[];
  /** The IPAM blocks, for the condition builder's "IP block" picker. Unfiltered
   *  by monitoring for the same reason `subnets` is — this is the address plan,
   *  not inventory — and there is no deprecated state on a block to exclude. */
  ipBlocks: { id: string; name: string; cidr: string }[];
  regions: string[];
  /** How deep region NESTING goes right now (1 = nothing is nested), plus the
   *  derived level of each region keyed by its LOWER-CASED name. The two
   *  recipient pickers read `maxLevel` to decide how many "Asset's L<n> Region
   *  Users" entries to offer; the address book's Regions list reads `byName`
   *  for its Level column. Both ride this payload for the same reason the
   *  region names do, since GET /map/regions is gated `mapRegions:read`.
   *  `byName` levels are the GLOBAL derived level — display only. Routing walks
   *  the containment edges instead (see regionHierarchyService), because a
   *  global level is asset-relative-wrong on an uneven tree. */
  regionLevels: { maxLevel: number; byName: Record<string, number> };
  roles: { id: string; name: string }[];
  /** The TAG REGISTRY, for the recipient pickers' Tags list — every operator
   *  tag an automation can route to, with the category it is filed under so the
   *  list groups the way the registry page does. Distinct from `tags` on the
   *  filter-schema payloads, which is the set of tags the INVENTORY currently
   *  carries: a tag can scope users without being on a single device, and
   *  routing to it still reaches them. Map Regions rows are excluded — they are
   *  the region catalogue under another name, already carried (with levels) by
   *  `regions`, and routing to a region matches region tags ONLY. */
  tagCatalog: { name: string; category: string }[];
}> {
  // MONITORED devices only. These lists exist to be picked from, and a
  // manufacturer or model that only unmonitored inventory reports is a choice
  // that can't produce a metric alert — offering it is how an operator builds a
  // filter, sees it match nothing, and distrusts the picker. Deliberately NOT
  // applied to matching: `scopeWhere` still selects unmonitored devices, because
  // event and change triggers fire on them. The subnet list is IPAM, not
  // inventory, so it is unfiltered by the same reasoning.
  const monitoredOnly = { monitored: true } as const;
  const [mfrRows, modelRows, ifNameRows, ssidRows, subnets, ipBlocks, regions, regionLevelsOut, roles, tagRows] = await Promise.all([
    prisma.asset.findMany({
      select: { manufacturer: true },
      distinct: ["manufacturer"],
      where: { ...monitoredOnly, manufacturer: { not: null } },
      orderBy: { manufacturer: "asc" },
    }),
    prisma.asset.findMany({
      select: { model: true },
      distinct: ["model"],
      where: { ...monitoredOnly, model: { not: null } },
      orderBy: { model: "asc" },
    }),
    // Interface names for the "Device interface" condition field. A real GROUP
    // BY (not a client-side dedupe) because AssetInterface is the largest
    // current-state table in the schema — tens of thousands of rows at 2000
    // devices, collapsing to a couple of hundred distinct names, since a fleet
    // of switches names its ports the same way. Capped: past a few hundred the
    // combobox is a scroll rather than a picker, and free text still matches
    // whatever the cap left out.
    prisma.assetInterface.groupBy({
      by: ["ifName"],
      where: { asset: monitoredOnly },
      orderBy: { ifName: "asc" },
      take: INTERFACE_NAME_OPTION_CAP,
    }).catch(() => [] as { ifName: string }[]),
    // The SSIDs the monitored fleet is currently broadcasting, for the
    // "Broadcast SSID" condition field. Tiny next to the interface list — a
    // site runs a handful of SSIDs across hundreds of APs — but grouped in
    // the database for the same reason: the rows are per (AP, radio, VAP).
    prisma.assetApVap.groupBy({
      by: ["ssid"],
      where: { asset: monitoredOnly, ssid: { not: null } },
      orderBy: { ssid: "asc" },
      take: INTERFACE_NAME_OPTION_CAP,
    }).catch(() => [] as { ssid: string | null }[]),
    prisma.subnet.findMany({
      select: { id: true, name: true, cidr: true },
      where: { status: { not: "deprecated" } },
      orderBy: { cidr: "asc" },
    }),
    // The IP blocks those subnets hang off, for the "IP block" condition field.
    // Tens of rows on the largest install — this is the top of the IPAM tree,
    // not a per-device table — so it needs neither a cap nor a distinct pass.
    prisma.ipBlock.findMany({
      select: { id: true, name: true, cidr: true },
      orderBy: { cidr: "asc" },
    }),
    // The map-region catalogue rides THIS payload rather than being fetched
    // from GET /map/regions, which is gated `mapRegions:read` — an operator who
    // can build an automation may not hold that key, and the region picker
    // would silently degrade to free text. This endpoint is already behind
    // automationManagement:read, which the wizard has by definition.
    listRegions().catch(() => []),
    // Nesting depth for the level-scoped recipient entries, and the per-region
    // level the address book displays. Falls back to a flat catalogue on
    // failure, which makes the pickers offer no level entries at all rather
    // than offering ones that resolve to nobody — and leaves the Level column
    // blank rather than claiming everything is L1.
    regionLevelIndex()
      .then((ix) => ({
        maxLevel: ix.maxLevel,
        // The index is already keyed by the normalized (bare, lower-cased)
        // name, so a caller looks a region up without re-deriving that.
        byName: Object.fromEntries(Array.from(ix.byName, ([k, e]) => [k, e.level])),
      }))
      .catch(() => ({ maxLevel: 1, byName: {} as Record<string, number> })),
    // Roles for the recipient picker's role tokens. Ids, not names: a rename
    // must never silently reroute an automation. Rides this payload for the
    // same reason regions do — GET /roles is gated `roles:read`, which an
    // automation editor may not hold.
    prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }).catch(() => []),
    // The tag registry, for the same reason the region catalogue rides here:
    // GET /server-settings/tags is behind serverSettingsSystem:read, which
    // someone editing an automation or browsing the address book need not hold.
    // Tiny table — a few dozen rows on the largest install.
    prisma.tag
      .findMany({
        select: { name: true, category: true },
        where: { category: { not: REGION_TAG_CATEGORY } },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      })
      .catch(() => [] as { name: string; category: string | null }[]),
  ]);
  return {
    manufacturers: mfrRows.map((r) => r.manufacturer).filter((m): m is string => !!m && m.trim() !== ""),
    models: modelRows.map((r) => r.model).filter((m): m is string => !!m && m.trim() !== ""),
    interfaceNames: ifNameRows.map((r) => r.ifName).filter((n) => !!n && n.trim() !== ""),
    ssids: ssidRows.map((r) => r.ssid).filter((n): n is string => !!n && n.trim() !== ""),
    subnets,
    ipBlocks,
    // Bare names — how User/Role/GroupMapping.regionTags store them. The
    // `region:` prefix exists only on ASSET tags.
    regions: regions.map((r) => r.name).filter((n) => !!n && n.trim() !== "").sort(),
    regionLevels: regionLevelsOut,
    roles,
    tagCatalog: tagRows
      .filter((t) => !!t.name && t.name.trim() !== "")
      .map((t) => ({ name: t.name, category: (t.category || "General").trim() || "General" })),
  };
}

// ─── Change-type subscription cache ─────────────────────────────────────────
// The persist* functions only diff + emit change-Events when at least one
// enabled `change` rule subscribes to that change type — zero overhead
// otherwise. Refreshed lazily (TTL) and on every rule write via
// bumpChangeSubscriptions().

// createTtlCache (2026-08 audit) replaces the hand-rolled value+timestamp
// pair — same TTL/invalidation semantics plus in-flight coalescing.
const SUBSCRIPTION_TTL_MS = 60_000;
const _subscriptionCache = createTtlCache<Set<string>>({ ttlMs: SUBSCRIPTION_TTL_MS, maxEntries: 1 });

export function bumpChangeSubscriptions(): void {
  _subscriptionCache.invalidate();
}

export function getSubscribedChangeActions(): Promise<Set<string>> {
  return _subscriptionCache.getOrCompute("", async () => {
    const rules = await prisma.notificationRule.findMany({
      where: { enabled: true },
      select: { trigger: true },
    });
    const actions = new Set<string>();
    for (const r of rules) {
      const t = r.trigger as unknown as Trigger;
      if (t.type === "change") {
        const action = CHANGE_TYPE_ACTIONS[t.changeType];
        if (action) actions.add(action);
      }
    }
    return actions;
  });
}

/** Is any enabled change-rule subscribed to this change action? */
export async function isChangeActionSubscribed(action: string): Promise<boolean> {
  const actions = await getSubscribedChangeActions();
  return actions.has(action);
}

// ─── Rule CRUD ──────────────────────────────────────────────────────────────

/**
 * Validate every reference a v2 rule's actions carry — TOP-LEVEL actions and
 * escalation-tier actions alike (tiers normalize through
 * normalizeEscalationToV2, so legacy email tiers validate as their converted
 * notify actions; the email-only tier restriction is gone — escalation v2
 * tiers take any action type):
 *   - notify.channelId must exist (any channel type),
 *   - api_call.url host must pass the outbound SSRF guard (friendly 400 at
 *     save beats a silent fire-time failure),
 *   - script.scriptId must resolve to an ENABLED registry script whose
 *     runTarget is compatible with the action's runOn.
 * (The automationScripts=fullwrite gate on rules carrying script actions is
 * enforced at the route layer — permissions are not a service concern.)
 */
async function assertActionRefs(input: RuleInput): Promise<void> {
  // Canonical walk over EVERY place actions live — top-level (+ their
  // per-action escalation tiers), rule-level escalation tiers, severity-band
  // actions (+ their per-action tiers), band-level tiers, and the dedicated
  // resolved actions — so a new action location can't escape these checks.
  const all = allRuleActionRefs(input);

  const notifyRefs: { label: string; channelId: string; broadcast: boolean }[] = [];
  // One entry per ACTION (not per channel) for the checks that are about the
  // action as a whole — the broadcast modes and the channelId/channelIds
  // coherence rule.
  const notifyActions: { label: string; channelIds: string[]; broadcast: boolean }[] = [];
  const scriptRefs: { label: string; scriptId: string; runOn: string }[] = [];
  for (const { action, label } of all) {
    if (action.type === "notify") {
      // channelId is the lossless single-channel mirror every pre-multi-channel
      // reader still uses, so the two views must agree. Refused rather than
      // repaired: a payload whose primary channel isn't its first channel is a
      // client bug, and picking one of the two answers is how an alert quietly
      // goes to the wrong destination.
      if (action.channelIds && action.channelIds[0] !== action.channelId) {
        throw new AppError(400, `${label}: channelId must be the first entry of channelIds`);
      }
      const chIds = notifyChannelIds(action);
      if (action.channelIds && new Set(action.channelIds).size !== action.channelIds.length) {
        throw new AppError(400, `${label}: the same delivery channel is listed twice`);
      }
      notifyActions.push({
        label,
        channelIds: chIds,
        // The two BROADCAST modes are Web-Push-only; flagged here so the
        // channel-type check below can reject them without a second walk.
        // `recipientRegions` is deliberately NOT in this set any more: naming
        // specific regions is now a recipient TOKEN the address-book picker
        // offers on every routed channel, so an email rule holding one is a
        // state the builder renders and can edit back out — which was the whole
        // reason for the restriction.
        broadcast: !!(action.recipientAllUsers || action.recipientAllRegions),
      });
      for (const channelId of chIds) {
        notifyRefs.push({ label, channelId, broadcast: false });
      }
    } else if (action.type === "api_call") {
      let host = "";
      try {
        host = new URL(action.url).hostname;
      } catch {
        throw new AppError(400, `${label}: api_call URL is not a valid URL`);
      }
      if (isBlockedOutboundHost(host)) {
        throw new AppError(400, `${label}: api_call host "${host}" is blocked (loopback/link-local/metadata addresses are not allowed)`);
      }
    } else if (action.type === "script") {
      scriptRefs.push({ label, scriptId: action.scriptId, runOn: action.runOn });
    }
    // `event` references nothing — no channel, script or URL to validate.
  }

  if (scriptRefs.length > 0) {
    const scripts = await prisma.automationScript.findMany({
      where: { id: { in: Array.from(new Set(scriptRefs.map((s) => s.scriptId))) } },
      select: { id: true, name: true, enabled: true, runTarget: true },
    });
    const scriptById = new Map(scripts.map((s) => [s.id, s]));
    for (const ref of scriptRefs) {
      const script = scriptById.get(ref.scriptId);
      if (!script) throw new AppError(400, `${ref.label}: references a script that no longer exists in the registry`);
      if (!script.enabled) throw new AppError(400, `${ref.label}: script "${script.name}" is disabled`);
      if (script.runTarget !== "either" && script.runTarget !== ref.runOn) {
        throw new AppError(400, `${ref.label}: script "${script.name}" only runs on ${script.runTarget}, but the action requests ${ref.runOn}`);
      }
    }
  }

  const channelIds = Array.from(new Set(notifyRefs.map((r) => r.channelId)));
  if (channelIds.length === 0) return;
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: channelIds } },
    select: { id: true, type: true },
  });
  const known = new Map(channels.map((c) => [c.id, c.type]));
  for (const ref of notifyRefs) {
    if (!known.has(ref.channelId)) {
      throw new AppError(400, `${ref.label}: references a delivery channel that no longer exists`);
    }
  }
  // Keep the stored shape renderable: the builder only offers the broadcast
  // modes on Web Push, so an action holding them with NO push channel at all
  // would be a state no UI can show or edit back out. A MIXED action (push +
  // email) keeps them — the builder renders the toggles as soon as one push
  // channel is selected, and expandDeliveries applies them to the push half
  // only, so the email half never silently inherits a fleet-wide broadcast.
  for (const ref of notifyActions) {
    if (ref.broadcast && !ref.channelIds.some((id) => known.get(id) === "web_push")) {
      throw new AppError(
        400,
        `${ref.label}: "all users" / "all regions" broadcast is only available on a Web Push channel — pick recipients (people, roles or named regions) explicitly for email and chat channels`,
      );
    }
  }
}

/** Attach the v2 view to a stored row: rows written before the v2 cutover
 *  (or restored from pre-upgrade backups) carry NULL reset/actions — fill
 *  them from the normalizer so API consumers always see the v2 shape. */
function withV2<T extends { reset: unknown; actions: unknown }>(row: T): T {
  if (row.reset && Array.isArray(row.actions)) return row;
  const v2 = normalizeRuleToV2(row as Parameters<typeof normalizeRuleToV2>[0]);
  return { ...row, reset: v2.reset, actions: v2.actions };
}

export async function listRules() {
  const rows = await prisma.notificationRule.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(withV2);
}

export async function getRule(id: string) {
  const rule = await prisma.notificationRule.findUnique({ where: { id } });
  if (!rule) throw new AppError(404, "Notification rule not found");
  return withV2(rule);
}

export async function createRule(input: RuleInput, actor?: string) {
  await assertActionRefs(input);
  const mirror = legacyMirrorOfV2(input.reset, input.actions);
  const rule = await prisma.notificationRule.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      reset: input.reset as any,
      actions: input.actions as any,
      // Lossless legacy mirror — keeps the pre-wizard UI + pre-upgrade
      // backups coherent. Derived, never authoritative (readers prefer v2).
      clearBehavior: mirror.clearBehavior,
      clearAfterSec: mirror.clearAfterSec,
      targets: mirror.targets as any,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      requireAckNote: input.requireAckNote === true,
      channels: input.channels,
      emailComposition: (input.emailComposition ?? undefined) as any,
      escalation: (input.escalation ?? undefined) as any,
      severityBands: (input.severityBands ?? undefined) as any,
      bandNotify: (input.bandNotify ?? undefined) as any,
      resetActions: (input.resetActions ?? undefined) as any,
      repeat: (input.repeat ?? undefined) as any,
      createdBy: actor ?? null,
    },
  });
  bumpChangeSubscriptions();
  // Unconditional: an edit can turn a rule INTO or OUT OF a down-detection
  // rule, so gating on "was it one?" would miss half the transitions.
  invalidateDownDetectionCache();
  await logEvent({
    action: "notification_rule.created",
    resourceType: "notification-rule",
    resourceId: rule.id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" created (${input.trigger.type})`,
    details: { triggerType: input.trigger.type, severity: input.severity },
  });
  return rule;
}

/** What makes two triggers "the same condition" for state-row continuity.
 *  A changed identity (type/kind/metric/field/changeType) means the stored
 *  NotificationRuleState rows describe a DIFFERENT condition — left in place
 *  they linger firing forever (per-dimension rows under a now-composite rule,
 *  a cpu row under a now-temperature rule). Threshold/operator/tree edits keep
 *  the identity: the state keys stay meaningful and re-evaluate next tick. */
export function triggerIdentityOf(trigger: Trigger): string {
  switch (trigger.type) {
    case "asset_metric": case "host_metric": return `${trigger.type}:${trigger.metric}`;
    case "asset_state": return `asset_state:${trigger.field}`;
    case "composite": return `composite:${trigger.kind}`;
    case "change": return `change:${trigger.changeType}`;
    default: return trigger.type;
  }
}

export async function updateRule(id: string, input: RuleInput, actor?: string) {
  const existing = await getRule(id); // 404 if missing
  await assertActionRefs(input);
  const identityChanged =
    triggerIdentityOf(existing.trigger as unknown as Trigger) !== triggerIdentityOf(input.trigger);
  const mirror = legacyMirrorOfV2(input.reset, input.actions);
  // Nullable-Json semantics: undefined (field absent) leaves the stored value
  // unchanged; explicit null clears it (Prisma.DbNull).
  const jsonOrClear = (v: unknown) => (v === undefined ? undefined : v === null ? Prisma.DbNull : (v as any));
  const rule = await prisma.notificationRule.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      severity: input.severity,
      trigger: input.trigger as any,
      scope: input.scope as any,
      reset: input.reset as any,
      actions: input.actions as any,
      clearBehavior: mirror.clearBehavior,
      clearAfterSec: mirror.clearAfterSec,
      targets: mirror.targets as any,
      cooldownSec: input.cooldownSec ?? null,
      messageTemplate: input.messageTemplate ?? null,
      requireAckNote: input.requireAckNote === true,
      channels: input.channels,
      emailComposition: jsonOrClear(input.emailComposition),
      escalation: jsonOrClear(input.escalation),
      severityBands: jsonOrClear(input.severityBands),
      bandNotify: jsonOrClear(input.bandNotify),
      resetActions: jsonOrClear(input.resetActions),
      repeat: jsonOrClear(input.repeat),
    },
  });
  // The trigger now describes a different condition — the old state rows (and
  // their active alerts) are about something that no longer exists. Clear the
  // alerts + drop the rows so nothing lingers firing under a stale key; the
  // next tick re-evaluates from scratch (cooldown restarts — an edited
  // trigger is a new condition). DISABLING gets the same cleanup: the engine
  // only evaluates enabled rules, so a disabled rule's active alerts would
  // otherwise sit uncleared forever (still counted by every widget). Clearing
  // by ruleId (not via state-row notificationIds) also catches stragglers.
  const disabling = existing.enabled && input.enabled === false;
  if (identityChanged || disabling) {
    await prisma.notification.updateMany({
      where: { ruleId: id, cleared: false },
      data: { cleared: true, clearedBy: identityChanged ? "system:rule-edited" : "system:rule-disabled", clearedAt: new Date() },
    });
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: id } });
  }
  bumpChangeSubscriptions();
  // Unconditional: an edit can turn a rule INTO or OUT OF a down-detection
  // rule, so gating on "was it one?" would miss half the transitions.
  invalidateDownDetectionCache();
  await logEvent({
    action: "notification_rule.updated",
    resourceType: "notification-rule",
    resourceId: rule.id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" updated`,
    details: { triggerType: input.trigger.type, enabled: input.enabled, ...(identityChanged ? { triggerIdentityChanged: true } : {}) },
  });
  return rule;
}

export async function deleteRule(id: string, actor?: string) {
  const rule = await getRule(id);
  // Clear the rule's ACTIVE alerts first: the cascade drops the state rows,
  // so nothing could ever auto-clear them after the delete — they'd sit in
  // every active-alert feed forever. Soft-clear keeps them as history.
  await prisma.notification.updateMany({
    where: { ruleId: id, cleared: false },
    data: { cleared: true, clearedBy: "system:rule-deleted", clearedAt: new Date() },
  });
  // Cascade drops NotificationRuleState; existing notifications keep ruleId
  // set to null (onDelete: SetNull) so history survives.
  await prisma.notificationRule.delete({ where: { id } });
  bumpChangeSubscriptions();
  // Unconditional: an edit can turn a rule INTO or OUT OF a down-detection
  // rule, so gating on "was it one?" would miss half the transitions.
  invalidateDownDetectionCache();
  await logEvent({
    action: "notification_rule.deleted",
    resourceType: "notification-rule",
    resourceId: id,
    resourceName: rule.name,
    actor,
    message: `Notification rule "${rule.name}" deleted`,
  });
}
