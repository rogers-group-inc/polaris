/**
 * src/services/notifications/evaluation.ts — threshold / state and composite trigger evaluation (CQ-B063, moved verbatim from
 * notificationEngine.ts): the specificity / carve-out shadow index, the per-rule sweep that
 * turns readings into fire / hold / reset decisions and its sweep state, and the composite
 * (AND / OR) trigger tree.
 */

import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { logEvent } from "../eventLogService.js";
import { POLARIS_SERVER_SUBJECT } from "../pathCheckIngestService.js";
import { pathCheckIdsInMaintenance } from "../maintenanceScheduleService.js";
import { isPathTrigger, isPathMetric, pathTriggerIncludesServer, scopeForTrigger, PATH_SERVER_LABEL, type Trigger, type CompositeTrigger, type CompositeLeaf, type TriggerConditionGroup, severityRank, updateTierMetSince, sustainedSeverity, bandDescent, tierMetSinceChanged, ruleGroupsByAsset, METRIC_META, FIELD_META, dimensionSpaceOf, isTriggerLeaf, triggerSignature, scopeRank, forecastLevelsOf, triggerHoldPolls, advanceRun, sustainedSeverityByRun, ruleAlertsWhenDependencyDown, isAssetShadowed, type ShadowIndex as ShadowIndexOf } from "../notificationTypes.js";
import { decorateRelationLeafHits } from "../scopeRelationIndex.js";
import { type PrioritySeverity } from "../../utils/priorityTags.js";
import { withRecoveryLookback, type DbRule, type ScopeAssetRow, type Reading, engineSustainPolls, type LeafRef, collectLeafRefs } from "./ruleModel.js";
import { loadScopeAssets, isSuppressedForNotifications, suppressionOwedToMaintenance, frozenFreshnessFor, assetIsAnsweringProbes, triggerNeedsAnsweringDevice, triggerHandsOffWhenDeviceDown, assetIsDown, poeFaultCoversUnpinned, pinTestForTrigger } from "./scope.js";
import { rulePrioritySubject, applyPrioritySeverity, tagGateGone, deletedTargetGone, sdwanCollectionStopped, resolveAssetMetricReadings, resolveAssetStateReadings, resolveHostMetricReading, readingMeets, engineSustainSec, recoveredMeets, type SweepStateRow } from "./readings.js";
import { type CompositeFireInfo, round2 } from "./templating.js";
import { ruleHasBands, bandSeverityFor, tierLadderFor, readingRuns, tierRuns, CLEARED_RUNS, metSinceJson, metSinceOf, tierForSeverity } from "./severityBands.js";
import { type GroupBuffer, type PendingSends, TickAlertIndex, liveAlertsByAsset, flushGroupFires, fire, applyBandTransition, refreshForecastCountdowns, fireResolved, readingFromState, fireReset, recover, clearActiveNotification, stillFiringElsewhere, clearAlertRow, handoffDependencyFlavour } from "./alertLifecycle.js";

type ShadowIndex = ShadowIndexOf<DbRule>;

/**
 * Clear firing/pending state rows the readings loop can no longer SEE — the
 * asset left the rule's scope (scope edit, tag drift, asset deleted or
 * unmonitored) or its dimension stopped being covered (interface unpinned or
 * admin-downed, mount/tunnel gone, dimensionFilter edit). Without this they
 * sit firing forever: the loop only re-evaluates keys that produce readings.
 * Two rows are deliberately left alone: suppressed assets (maintenance /
 * dependency — business rule 16; re-checked here for assets whose scope
 * condition drops them WHILE suppressed, e.g. a `status = active` condition,
 * so their alert is retired by the suppression sweep under its own reason
 * rather than mislabelled "left the scope") and in-scope assets that produced
 * no readings at all this tick (a collection gap is not evidence of
 * recovery). The no-readings freeze has one
 * carve-out: a PIN-gated dimension (interface / IPsec tunnel) whose pin is
 * gone clears anyway — the operator unpinning it is a configuration edge,
 * not a collection gap, and without the carve-out unpinning a device's ONLY
 * alerting interface left its alert firing forever (the asset then produces
 * zero readings for the rule, so the freeze swallowed the unpin). Zero extra
 * queries on the steady-state tick — the scope re-check only runs when
 * orphans exist.
 */
async function clearVanishedStates(
  rule: DbRule,
  states: SweepStateRow[],
  seenKeys: Set<string>,
  scopeIds: Set<string>,
  handledIds: Set<string>,
  assetsWithReadings: Set<string>,
  assetIndex: Map<string, ScopeAssetRow>,
  /** A Path Monitor rule's Polaris-server rows (subject ""): null for every
   *  other rule. `included` false = the operator turned the server off, so its
   *  rows have left the scope; true with readings = a check the server no
   *  longer reports has vanished, the same test an asset's dimension gets. */
  pathServer: { included: boolean; hasReadings: boolean } | null = null,
): Promise<void> {
  const pinTest = pinTestForTrigger(rule.trigger);
  const vanished: Array<{ st: SweepStateRow; reason: "scope" | "dimension" }> = [];
  const scopeChecks: SweepStateRow[] = [];
  const frozen: SweepStateRow[] = [];
  /** The server's rows on a tick it reported nothing (rule 167(a), below). */
  const serverParked: SweepStateRow[] = [];
  for (const st of states) {
    if (!st.assetId) {
      // host/global rows have no scope to leave — except the server's rows on
      // a Path Monitor rule, which can leave it.
      if (!pathServer || (st.state !== "firing" && st.state !== "pending")) continue;
      if (seenKeys.has(`|${st.dimensionKey}`)) continue;
      if (!pathServer.included) vanished.push({ st, reason: "scope" });
      else if (pathServer.hasReadings) vanished.push({ st, reason: "dimension" });
      else serverParked.push(st);
      continue;
    }
    if (st.state !== "firing" && st.state !== "pending") continue;
    if (seenKeys.has(`${st.assetId}|${st.dimensionKey}`)) continue;
    if (handledIds.has(st.assetId)) continue; // suppressed freeze / carve-out handoff own these
    if (scopeIds.has(st.assetId)) {
      const a = assetIndex.get(st.assetId);
      if (pinTest && st.dimensionKey && a && !pinTest(a, st.dimensionKey)) {
        vanished.push({ st, reason: "dimension" }); // unpinned — config edge, clear even with no readings
      } else if (assetsWithReadings.has(st.assetId)) {
        vanished.push({ st, reason: "dimension" });
      } else {
        // The asset reported nothing this tick — stay frozen, unless a tag
        // gate dropped it (tagGateGone, below).
        frozen.push(st);
      }
    } else {
      scopeChecks.push(st);
    }
  }
  if (frozen.length > 0) {
    const gone = await tagGateGone(rule, frozen, assetIndex);
    for (const st of frozen) if (gone.has(st.id)) vanished.push({ st, reason: "dimension" });
  }
  if (frozen.length > 0 || serverParked.length > 0) {
    // Rule 167(a): a row parked because its subject reports nothing is still
    // retired when the check, widget or probe it is about has been deleted.
    const parked = [...frozen, ...serverParked];
    const taken = new Set(vanished.map((v) => v.st.id));
    const deleted = await deletedTargetGone(rule, parked);
    for (const st of parked) if (deleted.has(st.id) && !taken.has(st.id)) vanished.push({ st, reason: "dimension" });
  }
  if (frozen.length > 0) {
    // Rule 174: an SD-WAN alert on a gate whose SD-WAN is no longer collected.
    // Loaded lazily: the monitoring service is heavy and imports this engine's
    // neighbours, and almost no tick reaches here.
    const taken = new Set(vanished.map((v) => v.st.id));
    const stopped = await sdwanCollectionStopped(rule, frozen, async (assetId) =>
      (await import("../monitoringService.js")).resolveSdwanPollIntervalForAsset(assetId));
    for (const st of frozen) if (stopped.has(st.id) && !taken.has(st.id)) vanished.push({ st, reason: "dimension" });
  }
  if (scopeChecks.length > 0) {
    const ids = Array.from(new Set(scopeChecks.map((s) => s.assetId as string)));
    const rows = await prisma.asset.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, dependencySuppressed: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const st of scopeChecks) {
      const a = byId.get(st.assetId as string);
      if (a && isSuppressedForNotifications(a)) continue; // rule 16: the suppression sweep owns these, not scope drift
      vanished.push({ st, reason: "scope" });
    }
  }
  for (const { st, reason } of vanished) {
    if (st.state === "firing") {
      // On a GROUPED alert (business rule 75) most departures are not clears:
      // one port of eight going out of scope leaves the alert standing. Ask
      // before logging, so the audit trail does not say "Cleared" about an
      // alert that is still up — the Event vocabulary is what an operator
      // reads back when working out why an alert did or did not end.
      const alsoFiring = await stillFiringElsewhere(st, rule);
      await clearActiveNotification(st, "system:out-of-scope", rule);
      await logEvent({
        action: alsoFiring ? "notification.member_left" : "notification.out_of_scope",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: alsoFiring
          ? `${rule.name}: ${st.dimensionKey || "a component"} is no longer reported or monitored — it left this alert`
          : reason === "scope"
            ? `Cleared: ${rule.name} — asset is no longer covered by this automation's scope`
            : `Cleared: ${rule.name} — ${st.dimensionKey || "the dimension"} is no longer reported or monitored`,
        details: { ruleId: rule.id, assetId: st.assetId, dimension: st.dimensionKey, reason },
      }).catch(() => {});
    }
    await prisma.notificationRuleState.update({
      where: { id: st.id },
      data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null },
    });
  }
}

/**
 * Business rule 89 — which of these assets carry a LIVE all-cores CPU alert
 * (an uncleared, real — not test — alert some automation raised on the
 * `cpuPct` asset metric). A per-core CPU automation hands those assets off:
 * the all-cores alert already says the device is busy, and a second alert
 * listing its cores says the same thing again. Acknowledged still counts —
 * acknowledging an alert does not end it. One indexed query per per-core
 * rule per tick, narrowed to the assets that rule is about to evaluate.
 */
async function assetsWithLiveAllCoresCpuAlert(assetIds: string[]): Promise<Set<string>> {
  const rows = await prisma.notification.findMany({
    where: { assetId: { in: assetIds }, metric: "cpuPct", cleared: false, testRun: false, ruleId: { not: null } },
    select: { assetId: true },
  });
  return new Set(rows.map((r) => r.assetId).filter((id): id is string => !!id));
}

/** Tick order: every rule before a per-core CPU rule, so the all-cores alert a
 *  per-core rule defers to (rule 89) is raised or cleared in the SAME tick it
 *  is read — otherwise a device crossing both lines at once would get both
 *  alerts for one tick before the handoff. Stable: nothing else reorders. */
export function evaluationOrder<T extends { trigger: unknown }>(rules: T[]): T[] {
  const late = (r: T) => {
    const t = r.trigger as { type?: string; metric?: string } | null;
    return t?.type === "asset_metric" && t.metric === "cpuCorePct" ? 1 : 0;
  };
  return rules.map((r, i) => ({ r, i })).sort((a, b) => late(a.r) - late(b.r) || a.i - b.i).map((x) => x.r);
}

export async function evaluateThresholdRule(
  rule: DbRule,
  shadowIndex?: ShadowIndex,
  /** The TICK's pending sends (business rule 75). Owned by
   *  evaluateAllNotificationRules and drained once every rule has run, so a
   *  grouped alert sends once however many contributions arrived. */
  pendingSends: PendingSends = new Map(),
  /** The TICK's live-alert index (business rule 75). Only an AlertGroup member
   *  needs it: its alert may have been opened by a different automation. */
  tickIndex: TickAlertIndex | null = null,
): Promise<void> {
  // Widened for the FETCH when the reset clears on a count of readings, so the
  // series that count is taken off can hold them (withRecoveryLookback).
  const trigger = withRecoveryLookback(rule.trigger, rule.reset);
  let readings: Reading[] = [];
  // Assets silenced this tick (maintenance window / dependency-suppressed).
  const suppressedIds = new Set<string>();
  // Business rule 78: this down automation speaks for its dependency-
  // suppressed devices instead of dropping them.
  const speaksForSuppressed = ruleAlertsWhenDependencyDown(trigger);
  // Assets carved out this tick by a more-specific same-signature automation.
  const shadowedIds = new Set<string>();
  // Business rule 89 — a per-core CPU rule's assets that carry a live
  // all-cores CPU alert this tick. Handed off like a carve-out.
  const coreSupersededIds = new Set<string>();
  // Assets whose device isn't answering, on a rule whose metric needs it to be
  // (packet loss — business rule 29), or that is `down` on a rule whose input
  // is the outage itself (response time, stream failing — 29(i)). Handed off
  // to asset-down alerting.
  const notAnsweringIds = new Set<string>();
  // Assets whose reading sat at or above the trigger's saturation ceiling, so
  // there is no reading this tick. Handled like notAnswering: cleared, not
  // frozen (business rule 29).
  const saturatedIds = new Set<string>();
  // Business rule 90 — SD-WAN member readings that yielded to a parent member
  // over the same line: `${assetId}|${dimKey}` → the parent. Per DIMENSION,
  // unlike the per-asset handoffs above: wan1 keeps alerting on the same gate.
  const sdwanYielded = new Map<string, string>();
  // Every asset the scope resolved this tick (incl. suppressed/shadowed);
  // null for host rules, which have no asset scope to leave.
  let scopeIds: Set<string> | null = null;
  // The assets this tick actually evaluated (scope minus suppressed / carved
  // out / not-answering). Hoisted out of the branch below because a custom
  // reset condition resolves its own leaves against them.
  let activeAssets: ScopeAssetRow[] = [];
  // The rows behind suppressedIds — the frozen-recovery pass re-reads them.
  const suppressedAssets: ScopeAssetRow[] = [];
  const needsAnswering = triggerNeedsAnsweringDevice(trigger);
  const handsOffWhenDown = !needsAnswering && triggerHandsOffWhenDeviceDown(trigger);
  // Path Monitor: the Polaris server's readings, keyed to subject "" — kept
  // apart so the vanished sweep can tell the server's rows from a host rule's.
  let serverReadings: Reading[] | null = null;

  if (trigger.type === "host_metric") {
    const r = await resolveHostMetricReading(trigger);
    readings = r ? [r] : [];
    activeAssets = [HOST_PSEUDO_ASSET];
  } else if (trigger.type === "asset_metric" || trigger.type === "asset_state") {
    // A Path Monitor rule's pool is agent hosts only (scopeForTrigger).
    const assets = await loadScopeAssets(scopeForTrigger(rule.scope, trigger), { monitoredOnly: true });
    scopeIds = new Set(assets.map((a) => a.id));
    // Precedence: only worth checking when this rule isn't already the most
    // specific in its signature group (and the group has a higher-rank peer).
    const sig = shadowIndex ? triggerSignature(rule.trigger) : null;
    const rank = sig ? scopeRank(rule.scope) : 0;
    const shadowable = !!(sig && shadowIndex && (shadowIndex.maxRankBySig.get(sig) ?? 0) > rank);
    // A PEER's scope may ask about interfaces this rule's scope never mentions,
    // and peerCoversAsset reads the same decorated row. Resolve those leaves too
    // before the coverage test, or a peer scoped by interface would read as
    // covering nothing (positive operator) or everything (negative one) — and a
    // wrong answer here either duplicates an alert or silences one.
    if (shadowable) {
      await decorateRelationLeafHits(
        assets,
        (shadowIndex!.bySig.get(sig!) ?? []).map((m) => m.rule.scope?.condition),
      );
    }
    const active: ScopeAssetRow[] = [];
    const maintOwed = speaksForSuppressed ? await suppressionOwedToMaintenance(assets) : null;
    for (const a of assets) {
      // Business rule 78: a down automation that opted in keeps its
      // dependency-suppressed devices — it is about to speak for them. A
      // MAINTENANCE window still silences (rule 16 wins: announced downtime
      // is not an outage to report), so the carve-out is dependency-only —
      // and that holds for a window on an UPSTREAM device too: a PLC dark
      // behind a switch being upgraded is planned, not an outage.
      const spokenFor = speaksForSuppressed && a.dependencySuppressed && String(a.status) !== "maintenance" && !maintOwed?.has(a.id);
      if (isSuppressedForNotifications(a) && !spokenFor) { suppressedIds.add(a.id); suppressedAssets.push(a); }
      else if (shadowable && isAssetShadowed(shadowIndex!, rule, sig!, rank, a)) shadowedIds.add(a.id);
      else if (needsAnswering ? !assetIsAnsweringProbes(a) : handsOffWhenDown && assetIsDown(a)) notAnsweringIds.add(a.id);
      else active.push(a);
    }
    if (trigger.type === "asset_metric" && trigger.metric === "cpuCorePct" && active.length > 0) {
      for (const id of await assetsWithLiveAllCoresCpuAlert(active.map((a) => a.id))) coreSupersededIds.add(id);
    }
    activeAssets = coreSupersededIds.size ? active.filter((a) => !coreSupersededIds.has(a.id)) : active;
    readings = trigger.type === "asset_metric"
      ? await resolveAssetMetricReadings(trigger, activeAssets, saturatedIds, sdwanYielded, forecastLevelsOf(trigger, rule.severity, rule.severityBands))
      : await resolveAssetStateReadings(trigger, activeAssets, { dependencyDownReadsDown: speaksForSuppressed, sdwanYielded });
    if (trigger.type === "asset_metric" && pathTriggerIncludesServer(trigger)) {
      serverReadings = await serverPathReadings(trigger);
      readings = [...readings, ...serverReadings];
    }
  } else {
    return;
  }

  // Existing firing/pending state for this rule.
  const states = await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id } });
  const stateMap = new Map(states.map((s) => [`${s.assetId ?? ""}|${s.dimensionKey}`, s]));
  const now = new Date();
  // FROZEN, NOT DEAF (business rule 16 — frozenReadingIsFresh). A suppressed
  // asset holding a FIRING row of this rule is re-read so the alert can recover
  // on evidence taken during the window. These readings only ever reach the
  // recovery half of the loop below: never a fire, a pending row or a band
  // change. Narrowed to firing rows first, so at 2000 assets this is the
  // handful currently frozen, not the whole suppressed set.
  let frozenReadings: Reading[] = [];
  const frozenFreshIds = new Set<string>();
  if (suppressedAssets.length > 0 && (trigger.type === "asset_metric" || trigger.type === "asset_state")) {
    const firingFrozen = new Set(
      states.filter((s) => s.state === "firing" && s.assetId && suppressedIds.has(s.assetId)).map((s) => s.assetId as string),
    );
    // A metric that needs an answering device has nothing to say about one
    // that isn't answering (business rule 29) — leave that alert frozen.
    const candidates = suppressedAssets.filter((a) => firingFrozen.has(a.id) && (!needsAnswering || assetIsAnsweringProbes(a)));
    if (candidates.length > 0) {
      const raw = trigger.type === "asset_metric"
        ? await resolveAssetMetricReadings(trigger, candidates, new Set(), new Map(), forecastLevelsOf(trigger, rule.severity, rule.severityBands))
        : await resolveAssetStateReadings(trigger, candidates, { dependencyDownReadsDown: speaksForSuppressed, sdwanYielded: new Map() });
      // Judged per READING, not per asset: one dimension refreshed during the
      // window says nothing about another that stopped reporting before it.
      const isFresh = await frozenFreshnessFor(candidates);
      frozenReadings = raw.filter((r) => isFresh(r.assetId, r.readingAt));
      for (const r of frozenReadings) frozenFreshIds.add(r.assetId);
    }
  }
  // Business rule 136(e): severity from the Priority tag. Untagged readings are
  // dropped here, before the loop, so they neither fire nor count as "the
  // asset reported" for the vanished-state sweep.
  let prioritySeverityByKey: Map<string, PrioritySeverity> | null = null;
  if (rulePrioritySubject(rule)) {
    const index = new Map([...activeAssets, ...suppressedAssets].map((a) => [a.id, a]));
    const live = await applyPrioritySeverity(rule, readings, index);
    const held = await applyPrioritySeverity(rule, frozenReadings, index);
    if (live && held) {
      readings = live.readings;
      frozenReadings = held.readings;
      prioritySeverityByKey = new Map([...live.severityByKey, ...held.severityByKey]);
    }
  }
  // Business rule 78 — which FLAVOUR each live alert of this rule was raised
  // in (plain Down, or dependency-down), so a firing row can be handed off when
  // the asset's suppression flag no longer agrees with its alert. Read only for
  // an opted-in rule and only for its firing rows: a handful of ids.
  //
  // A GROUPED alert (rule 75, `groupKey` set) has no flavour and is left out:
  // it folds several devices, some Dep. Down and some down in their own right,
  // and createGroupAlert never stamps `dependencyDown`. Comparing each device's
  // reading against that unstamped `false` handed every Dep. Down member off
  // and straight back in on every tick — "is in fault again after recovering
  // for 0m" on each paced update, and a re-open of any acknowledgement.
  const flavourByNotif = new Map<string, boolean>();
  if (speaksForSuppressed) {
    const firingIds = states.filter((s) => s.state === "firing" && s.notificationId).map((s) => s.notificationId as string);
    if (firingIds.length > 0) {
      const rows = await prisma.notification.findMany({ where: { id: { in: firingIds }, groupKey: null }, select: { id: true, dependencyDown: true } });
      for (const r of rows) flavourByNotif.set(r.id, r.dependencyDown);
    }
  }
  const seen = new Set<string>();
  const hasBands = ruleHasBands(rule);
  // Per-tier sustained durations: every severity (base + each band) carries its
  // own "sustained for", so the tier ladder + the state row's per-tier
  // met-since map — not one shared conditionMetSince — decide which severity
  // has actually earned its time. Null for non-banded rules (unchanged path).
  const tiers = hasBands ? tierLadderFor(rule) : null;
  // Custom reset conditions: while an alert is firing, this tree is the SOLE
  // recovery authority — the trigger going false does not clear it and the
  // trigger re-meeting does not cancel its sustain timer. Owned by the
  // dedicated pass after this loop, which is why the firing branches below
  // hand recovery off rather than acting on the trigger's own reading.
  const resetTree = rule.reset.mode === "condition" ? (rule.reset.condition ?? null) : null;
  // GROUPED ALERTS (business rule 75). When this rule consolidates per device,
  // fire() stops writing and starts BUFFERING: the eight ports a failing PSU
  // faults land in one `readings` loop, and a read-modify-write per reading
  // would be eight reads, eight updates and eight sends on precisely the tick
  // the feature exists to quieten. flushGroupFires (after the loop) turns each
  // asset's buffer into ONE alert.
  //
  // `liveByAsset` is seeded from the `states` snapshot already loaded above, so
  // finding the alert a contribution should join costs ZERO extra queries.
  const groupBuf: GroupBuffer | null = ruleGroupsByAsset(rule) ? new Map() : null;
  const liveByAsset = await liveAlertsByAsset(rule, states, tickIndex);
  /** Firing memory-forecast alerts whose countdown may have moved (refreshForecastCountdowns). */
  const forecastLive: Array<{ st: { id: string; notificationId: string | null; firingSeverity: string | null }; reading: Reading }> = [];

  for (const reading of frozenReadings.length ? [...readings, ...frozenReadings] : readings) {
    const key = `${reading.assetId || ""}|${reading.dimKey}`;
    seen.add(key);
    const lastValue = typeof reading.value === "number" ? reading.value : null;
    const st = stateMap.get(key);
    // Banded rules fire/clear by the resolved band severity (null = below tier
    // 0); non-banded rules use the single-threshold decision unchanged.
    const bandSev = hasBands ? bandSeverityFor(rule, lastValue) : null;
    const meets = hasBands ? bandSev !== null : readingMeets(trigger, reading.value);
    // Roll each tier's run forward, then resolve the most-severe tier whose OWN
    // duration has elapsed. null = nothing has sustained yet (stay pending, or
    // hold the firing alert's current severity).
    const prevMetSince = tiers ? metSinceOf(st) : null;
    const metSince = tiers ? updateTierMetSince(prevMetSince, tiers, meets ? lastValue : null, now.getTime()) : null;
    const metSinceChanged = !!tiers && tierMetSinceChanged(prevMetSince, metSince);
    // POLL-COUNTED HOLDS (FOR_POLLS_NOTE). A rule that states its hold or its
    // clear-sustain as a count of readings is decided by counting readings; one
    // that states seconds keeps the wall-clock path below, untouched. Both runs
    // are resolved once per reading and reused by the fire and the clear side.
    const holdPolls = triggerHoldPolls(trigger);
    const sustainPolls = engineSustainPolls(rule);
    const tierPolls = tiers ? tierRuns(reading, tiers) : null;
    const recoveredNow = recoveredMeets(trigger, rule.reset, reading.value);
    const runs = holdPolls > 0 || sustainPolls > 0 || (tiers && tierPolls)
      ? readingRuns(reading, st ?? undefined, trigger, rule.reset, meets, recoveredNow)
      : null;
    // A banded ladder counts readings only when its tiers carry counts AND the
    // source has a series to count (tierRuns is null for a windowed ratio).
    const sustainedSev = tiers
      ? (tierPolls && tiers.some((t) => t.forPolls != null)
        ? sustainedSeverityByRun(tierPolls, tiers)
        : sustainedSeverity(metSince, tiers, now.getTime()))
      : null;
    /** Business rule 19(a): may a FIRING banded alert ease from its current
     *  band down to `target` yet? Only once the value has stayed out of the
     *  current band for that band's own hold — else one reading under the line
     *  eases it and the next hold re-escalates it, re-notifying every time. */
    const descentTo = (target: string) => {
      const current = st?.firingSeverity ?? rule.severity;
      if (!tiers || severityRank(target) >= severityRank(current)) return { due: true, metSince: metSince ?? {} };
      return bandDescent({
        tiers, current, value: lastValue, series: reading.series,
        countsReadings: !!tierPolls, metSince, prevMetSince, nowMs: now.getTime(),
      });
    };
    // Business rule 136(e): the Priority tag's severity, when the rule follows
    // it. Never set beside bands (validatePrioritySeverity refuses the pair).
    const prioritySev = prioritySeverityByKey?.get(key) ?? null;
    const firedSev = sustainedSev ?? prioritySev;
    /** Persist the current-state counters, but only when this reading moved
     *  them — a series-backed rule stores nothing, having nothing to remember. */
    const runPatch = (): Prisma.NotificationRuleStateUpdateInput =>
      runs && runs.stateful && runs.advanced
        ? { metRun: runs.metRun, clearRun: runs.clearRun, lastReadingAt: reading.readingAt ?? now }
        : {};
    // The grouping buffer rides fireOpts so the six fire() sites below stay
    // untouched — every one of them already threads it.
    const fireOpts = firedSev || groupBuf
      ? {
        ...(firedSev ? { severity: firedSev, actions: tierForSeverity(rule, firedSev).actions } : {}),
        ...(groupBuf ? { group: groupBuf } : {}),
      }
      : undefined;

    // A FROZEN asset's reading (business rule 16 — only suppressed assets with
    // a fresh reading get here at all) may end a live alert and nothing else:
    // no fire, no pending row, no band move, no flavour handoff. A still-bad
    // reading just breaks any recovery run in progress.
    if (reading.assetId && suppressedIds.has(reading.assetId)) {
      if (!st || st.state !== "firing") continue;
      if (meets) {
        const data: Prisma.NotificationRuleStateUpdateInput = { ...(resetTree || !st.recoveredSince ? {} : { recoveredSince: null }), ...runPatch() };
        if (Object.keys(data).length) await prisma.notificationRuleState.update({ where: { id: st.id }, data });
        continue;
      }
      // Not met → the ordinary firing-row recovery branch below.
    }

    if (meets) {
      // Business rule 78 — the alert's flavour follows the asset's suppression
      // flag. A plain Down alert whose device has since turned Dep. Down (the
      // sweep normally retires it first; this catches a flag that flipped
      // between the sweep and this loop), or a dependency-down alert whose
      // upstream came back while the device stayed dark, is ENDED and raised
      // again in the other flavour — the operators hear "and it is the switch"
      // or "and now it is the PLC itself". No reset actions: nothing recovered.
      if (st && st.state === "firing" && speaksForSuppressed && st.notificationId) {
        const was = flavourByNotif.get(st.notificationId);
        const isDep = reading.dependencyDown === true;
        if (was !== undefined && was !== isDep) {
          await handoffDependencyFlavour(rule, st, isDep);
          await fire(rule, reading, lastValue, now, undefined, fireOpts);
          continue;
        }
      }
      if (!st || st.state === "clear") {
        if (hasBands) {
          // A tier whose sustain is 0 fires on the first reading; otherwise the
          // per-tier timer starts here and the row sits pending.
          if (sustainedSev) await fire(rule, reading, lastValue, now, undefined, fireOpts, metSince);
          else await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue, bandMetSince: metSince });
        } else if (holdPolls > 0) {
          // Counted in READINGS: this one is the first of the run, so it fires
          // only when the hold is a single poll. The run itself is stored only
          // for a current-state source; a series-backed one recomputes it.
          if (runs && runs.metRun >= holdPolls) await fire(rule, reading, lastValue, now, undefined, fireOpts);
          else await upsertState(rule.id, reading, "pending", {
            conditionMetSince: now, lastValue,
            ...(runs?.stateful ? { metRun: runs.metRun, clearRun: runs.clearRun, lastReadingAt: reading.readingAt ?? now } : {}),
          });
        } else if ((trigger as any).forDurationSec > 0) {
          // start the sustained-duration timer
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue });
        } else {
          await fire(rule, reading, lastValue, now, undefined, fireOpts);
        }
      } else if (st.state === "pending") {
        if (hasBands) {
          if (sustainedSev) await fire(rule, reading, lastValue, now, undefined, fireOpts, metSince);
          else if (metSinceChanged) {
            // A tier entered or dropped out while pending — persist the runs.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { bandMetSince: metSinceJson(metSince), lastValue } });
          }
        } else if (holdPolls > 0) {
          if (runs && runs.metRun >= holdPolls) await fire(rule, reading, lastValue, now, undefined, fireOpts);
          else {
            const patch = runPatch();
            if (Object.keys(patch).length) await prisma.notificationRuleState.update({ where: { id: st.id }, data: { ...patch, lastValue } });
          }
        } else {
          const since = st.conditionMetSince ?? now;
          if (now.getTime() - since.getTime() >= (trigger as any).forDurationSec * 1000) {
            await fire(rule, reading, lastValue, now, undefined, fireOpts);
          }
          // else keep pending
        }
      } else if (st.state === "firing") {
        // A move DOWN the ladder waits out the band's hold (rule 19(a)); the
        // map it returns carries a wall-clock descent timer while one runs.
        const descent = hasBands && sustainedSev && sustainedSev !== (st.firingSeverity ?? rule.severity)
          ? descentTo(sustainedSev)
          : null;
        const bandMap = descent ? descent.metSince : metSince;
        const bandMapChanged = !!tiers && tierMetSinceChanged(prevMetSince, bandMap);
        if (hasBands && sustainedSev && descent?.due) {
          // Crossed into a band that has now held for its own duration —
          // escalate/de-escalate the live alert.
          await applyBandTransition(rule, reading, st, sustainedSev, now, bandMap);
        } else if (prioritySev && prioritySev !== (st.firingSeverity ?? rule.severity)) {
          // Business rule 136(e): the device's (or port's) Priority tag changed
          // while it was down — the live alert takes the new severity and
          // re-notifies per bandNotify, the way a band crossing does.
          await applyBandTransition(rule, reading, st, prioritySev, now);
        } else if (st.recoveredSince || bandMapChanged) {
          // Re-met mid-recovery: cancel the clear-sustain timer (transition-only
          // write — a steadily-firing condition costs nothing per tick). Also
          // where a climbing-but-not-yet-sustained tier's run is persisted, and
          // a pending descent's timer (rule 19(a)).
          // Under a custom reset condition `recoveredSince` is the RESET tree's
          // sustain timer, not this trigger's, so the trigger re-meeting must
          // not cancel it (parity with the composite path's same contract).
          const data: Prisma.NotificationRuleStateUpdateInput = resetTree ? {} : { recoveredSince: null };
          if (hasBands) data.bandMetSince = metSinceJson(bandMap);
          Object.assign(data, runPatch()); // the recovery run just broke
          if (Object.keys(data).length) await prisma.notificationRuleState.update({ where: { id: st.id }, data });
        } // same band / firing without a pending recovery → already active; suppress
        // A memory forecast's live alert COUNTS DOWN: "Days until Serious: 6"
        // must read 5 tomorrow, though nothing above changed. Queued here and
        // rewritten after the loop, only when the countdown moved.
        if (reading.forecast && st.notificationId && !groupBuf) forecastLive.push({ st, reading });
      }
    } else {
      // condition not met for this reading
      if (st && st.state === "pending") {
        // Zeroed with the timer: a run is CONSECUTIVE, so a reading under the
        // line ends it however long it was.
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull, metRun: 0, clearRun: 0, lastReadingAt: reading.readingAt ?? now } });
      } else if (st && st.state === "firing") {
        if (resetTree) {
          // The reset tree owns recovery — the trigger falling away is not
          // itself evidence the alert should clear. Handled after this loop.
        } else if (rule.reset.mode !== "auto") {
          // manual re-arms the state; timed waits for its sweep — same as ever.
          await recover(rule, st, reading, now);
        } else if (!recoveredMeets(trigger, rule.reset, reading.value)) {
          // Hysteresis dead band (below fire, above clear): stay firing — but
          // a BANDED alert eases to the base severity here. The value is out
          // of every band (only anti-flap keeps the alert active), and a CPU
          // that crashes from the critical band straight into the dead band
          // in one tick never passes through the lower bands — parked at the
          // old band it would read critical indefinitely.
          // Easing waits out the band's hold like any other descent (rule 19(a)).
          const descent = hasBands && (st.firingSeverity ?? rule.severity) !== rule.severity ? descentTo(rule.severity) : null;
          const bandMap = descent ? descent.metSince : metSince;
          if (descent?.due) {
            await applyBandTransition(rule, reading, st, rule.severity, now, bandMap);
          } else if (st.recoveredSince || (!!tiers && tierMetSinceChanged(prevMetSince, bandMap)) || Object.keys(runPatch()).length) {
            await prisma.notificationRuleState.update({
              where: { id: st.id },
              // A dead-band reading is neither met nor recovered, so it ends the
              // recovery run (advanceRun zeroes it) without starting a new one.
              data: { recoveredSince: null, ...(hasBands ? { bandMetSince: metSinceJson(bandMap) } : {}), ...runPatch() },
            });
          }
        } else if (sustainPolls > 0) {
          // "Must stay cleared for N polls": N consecutive RECOVERED readings,
          // counted the same way the fire side counts qualifying ones.
          if (runs && runs.clearRun >= sustainPolls) {
            if (hasBands) await fireResolved(rule, reading, st, now);
            await recover(rule, st, reading, now);
          } else {
            const patch = runPatch();
            if (Object.keys(patch).length) await prisma.notificationRuleState.update({ where: { id: st.id }, data: patch });
          }
        } else {
          const sustainSec = engineSustainSec(rule);
          if (sustainSec <= 0) {
            if (hasBands) await fireResolved(rule, reading, st, now);
            await recover(rule, st, reading, now);
          } else if (!st.recoveredSince) {
            // Recovery observed — start the clear-sustain timer.
            await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
          } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
            if (hasBands) await fireResolved(rule, reading, st, now);
            await recover(rule, st, reading, now);
          }
          // else: recovered but not sustained long enough yet — keep firing.
        }
      }
    }
  }

  // GROUPED ALERTS (business rule 75). Every contribution that crossed into
  // firing this tick is in the buffer; turn each asset's into ONE alert.
  //
  // Placed HERE, straight after the readings loop, for one hard reason: the
  // custom-reset pass further down re-reads firing rows from the database
  // rather than from the pre-loop snapshot, so these state rows have to exist
  // by then. The sweeps between the two (suppressed-pending, carve-out,
  // device-down, vanished-state) all read `states`, which is the snapshot —
  // they cannot see these rows and have no business with them: a contribution
  // that only just fired has not gone out of scope or been superseded.
  if (groupBuf?.size) await flushGroupFires(rule, groupBuf, liveByAsset, now, pendingSends, tickIndex);
  if (forecastLive.length) await refreshForecastCountdowns(rule, forecastLive, now);

  // Suppressed assets produced no fire-side readings this tick. Reset their
  // `pending` rows — the debounce restarts from scratch after the window, a
  // dropped reading being evidence of nothing. Their `firing` rows are left
  // alone here: frozen through a maintenance window (rule 16 — a window never
  // retires an alert, though fresh evidence may recover one in the loop above),
  // or retired by the suppression sweep (clearSuppressedAlerts, run ahead of
  // this tick) when the asset is dark behind a parent that is down.
  // One statement, not one per row (CQ-B050): every row gets the same data, and
  // a maintenance window opening on a large group resets them all at once.
  const suppressedPendingIds = states
    .filter((st) => st.state === "pending" && st.assetId && suppressedIds.has(st.assetId))
    .map((st) => st.id);
  if (suppressedPendingIds.length) {
    await prisma.notificationRuleState.updateMany({
      where: { id: { in: suppressedPendingIds } },
      data: { state: "clear", conditionMetSince: null },
    });
  }

  // Carved-out assets: a more-specific same-signature automation has taken them
  // over. Unlike maintenance suppression (which freezes firing rows), the
  // takeover is a real handoff — clear any active alert (superseded) and reset
  // pending debounce so the general rule no longer alerts for these assets.
  for (const st of states) {
    if (!st.assetId) continue;
    const allCores = coreSupersededIds.has(st.assetId);
    if (!allCores && !shadowedIds.has(st.assetId)) continue;
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:superseded", rule);
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null },
      });
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: allCores
          ? `Cleared: ${rule.name} superseded by the device's all-cores CPU utilization alert`
          : `Cleared: ${rule.name} superseded by a more-specific automation`,
        details: { ruleId: rule.id, assetId: st.assetId, ...(allCores ? { reason: "all-cores-cpu" } : {}) },
      }).catch(() => {});
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null },
      });
    }
  }

  // TWO HANDOFFS TO ASSET-DOWN ALERTING. Like the carve-out and unlike
  // maintenance, the live alert CLEARS rather than freezing — freezing is what
  // used to leave a packet-loss alert sitting next to the asset-down alert for
  // a whole outage, which is the duplicate operators were seeing.
  //
  //   device-down       — packet loss: the device stopped answering, so it
  //                       produces no reading at all (assetIsAnsweringProbes).
  //                       Response time and the stream-failing fields: it
  //                       is `down` (triggerHandsOffWhenDeviceDown, 29(i)) —
  //                       their input is the outage itself. Every other
  //                       reading freezes through it.
  //   reading-saturated — it IS answering, but the ratio reached the rule's
  //                       own `ignoreAtOrAbove` ceiling, so the number has
  //                       stopped describing a lossy link. This is the case
  //                       the removed loss anchor used to hide: a device back
  //                       from a 55-minute outage really does read ~92% for
  //                       the rest of the window, and an operator who does not
  //                       want an alert trailing every outage sets the ceiling
  //                       below that (business rule 29). Packet loss only.
  //
  // Deliberately no reset actions (matching the carve-out): the alert isn't
  // recovering, and mailing "packet loss resolved" about a device that just went
  // dark would be worse than saying nothing. The Event is the audit trail.
  for (const st of states) {
    if (!st.assetId) continue;
    const handoff = notAnsweringIds.has(st.assetId)
      ? "device-down"
      : saturatedIds.has(st.assetId) ? "reading-saturated" : null;
    if (!handoff) continue;
    if (st.state === "firing") {
      await clearActiveNotification(st, `system:${handoff}`, rule);
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS },
      });
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: handoff === "device-down"
          ? `Cleared: ${rule.name} — the device is no longer answering, so its outage is the asset-down alert`
          : `Cleared: ${rule.name} — the reading reached the automation's ignore-at-or-above ceiling, so it describes an outage rather than a lossy link`,
        details: { ruleId: rule.id, assetId: st.assetId, reason: handoff },
      }).catch(() => {});
      // The timed sweep below reads this snapshot; a row cleared here must not
      // then time out and run the reset actions this handoff withholds.
      st.state = "clear";
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull },
      });
    }
  }

  // Business rule 90 — a member whose parent is over the same line hands its
  // alert to the parent's. Same shape as the carve-out: the live alert CLEARS
  // as superseded, with no reset actions — the child has not recovered, and
  // mailing "packet loss resolved" about an overlay still dropping packets
  // would be a lie. Marked seen so the vanished sweep below does not also
  // retire it as "no longer reported".
  for (const st of states) {
    if (!st.assetId) continue;
    const key = `${st.assetId}|${st.dimensionKey}`;
    const parent = sdwanYielded.get(key);
    if (parent === undefined) continue;
    seen.add(key);
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:superseded", rule);
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS },
      });
      const member = st.dimensionKey.slice(st.dimensionKey.indexOf("|") + 1);
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Cleared: ${rule.name} on ${member} — it rides ${parent}, which is over the same line; ${parent}'s alert speaks for it`,
        details: { ruleId: rule.id, assetId: st.assetId, dimension: st.dimensionKey, reason: "sdwan-parent", parent },
      }).catch(() => {});
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, bandMetSince: Prisma.DbNull },
      });
    }
  }

  // Business rule 135 — a path check in maintenance is FROZEN on this rule, the
  // check-level twin of rule 16's asset freeze. Its samples were never read
  // (pathCheckIdWhere), so its firing rows are marked seen — otherwise a host
  // still reporting its OTHER checks would have them cleared as vanished — and
  // left to recover on their own evidence once runs resume; a pending row
  // restarts its debounce after the window, a missing reading being evidence
  // of nothing. Narrowed to this rule's rows for the held checks: a handful.
  const pathHeld = trigger.type === "asset_metric" && isPathMetric(trigger.metric)
    ? await pathCheckIdsInMaintenance()
    : null;
  if (pathHeld?.size) {
    const heldPendingIds: string[] = [];
    for (const st of states) {
      if (!pathHeld.has(st.dimensionKey)) continue;
      seen.add(`${st.assetId ?? ""}|${st.dimensionKey}`);
      if (st.state === "pending") heldPendingIds.push(st.id);
    }
    if (heldPendingIds.length) {
      await prisma.notificationRuleState.updateMany({
        where: { id: { in: heldPendingIds } },
        data: { state: "clear", conditionMetSince: null },
      });
    }
  }

  // Vanished states: assets that left the scope or dimensions that stopped
  // being reported — the readings loop never sees them, so clear them here
  // (suppressed assets stay frozen, in-scope assets with no readings at all
  // stay frozen; see clearVanishedStates).
  if (scopeIds) {
    const handled = new Set([...suppressedIds, ...shadowedIds, ...coreSupersededIds, ...notAnsweringIds, ...saturatedIds]);
    const assetsWithReadings = new Set(readings.map((r) => r.assetId).filter(Boolean));
    const pathServer = trigger.type === "asset_metric" && isPathTrigger(trigger)
      ? { included: serverReadings !== null, hasReadings: (serverReadings?.length ?? 0) > 0 }
      : null;
    // activeAssets suffices as the pin-test index: any state row that passes
    // the handled/scope checks belongs to an active asset by construction.
    await clearVanishedStates(rule, states, seen, scopeIds, handled, assetsWithReadings, new Map(activeAssets.map((a) => [a.id, a])), pathServer);
  }

  // ── Custom reset conditions ──────────────────────────────────────────────
  // Recovery for a condition-reset rule is decided HERE rather than in the
  // readings loop, because the reset tree is the sole authority and its leaves
  // need not be the trigger's metric at all: a firing alert whose trigger
  // stopped reporting entirely must still be able to clear.
  //
  // Firing rows are re-read from the DB rather than taken from `states`, which
  // is a pre-loop snapshot the sweeps above have since invalidated — a row this
  // tick cleared as superseded / out-of-scope must not then be "recovered", and
  // a row that only just fired must not be recovered in the same tick it fired.
  if (resetTree) {
    const firing = (await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id, state: "firing" } }))
      // A suppressed asset (maintenance / dependency-down) is frozen — unless
      // its trigger reading was taken during the freeze, the same evidence
      // test the readings loop applies (business rule 16).
      .filter((st) => !(st.assetId && suppressedIds.has(st.assetId) && !frozenFreshIds.has(st.assetId)))
      // …and so is a path check in maintenance (business rule 135).
      .filter((st) => !pathHeld?.has(st.dimensionKey));
    // Resolve the tree against the FIRING assets only — usually a handful out of
    // the whole scope, and the leaves are separate queries per sample table, so
    // handing them 2000 asset ids to answer a question about three alerts is the
    // difference between a free pass and a fleet-wide scan every 60s. (Same
    // narrowing the composite path does.)
    const firingAssetIds = new Set(firing.map((st) => st.assetId ?? ""));
    const resetAssets = trigger.type === "host_metric"
      ? activeAssets // the host pseudo-asset; host leaf resolvers ignore the list anyway
      : [...activeAssets, ...suppressedAssets.filter((a) => frozenFreshIds.has(a.id))].filter((a) => firingAssetIds.has(a.id));
    if (firing.length > 0 && resetAssets.length > 0) {
      const resetLeaves = collectLeafRefs(resetTree);
      // The firing rows' own dimension vocabulary, and whether this automation
      // reads unpinned PoE ports — both are properties of the TRIGGER, and both
      // decide what its reset tree is allowed to answer (business rule 32(b)).
      const truthAt = await resolveResetTruths(
        resetLeaves,
        resetAssets,
        dimensionSpaceOf(trigger),
        poeFaultCoversUnpinned(trigger),
      );
      const readingByKey = new Map([...readings, ...frozenReadings].map((r) => [`${r.assetId || ""}|${r.dimKey}`, r]));
      for (const st of firing) {
        const assetId = st.assetId ?? "";
        const recovered = evalTriggerTree(resetTree, (leafId) => truthAt(leafId, assetId, st.dimensionKey));
        // The trigger's own reading when there is one (it carries hostname/tags
        // for the reset actions' template), else a reading rebuilt from the row.
        const reading = readingByKey.get(`${assetId}|${st.dimensionKey}`) ?? readingFromState(st);
        await applySustainedRecovery(rule, st, recovered, now, reading, { fireResolvedFirst: hasBands });
      }
    }
  }

  // Timed auto-clear: firing states past their timer, even without an explicit
  // recovery reading (e.g. the asset stopped reporting).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    if (ruleGroupsByAsset(rule)) {
      // GROUPED ALERTS (business rule 75): a timed reset times the ALERT, not
      // each contribution.
      //
      // `firedAt` is per state row and contributions join on different ticks,
      // so timing them individually would expire the first-joined port while
      // seven were still faulted — the alert would shrink port by port instead
      // of ending, and each departure would mail its own reset. The alert's own
      // `triggeredAt` is the only clock that means "this alert has been up for
      // an hour", which is what the operator asked for.
      const byAlert = new Map<string, typeof states>();
      for (const st of states) {
        if (st.state !== "firing" || !st.notificationId) continue;
        const rows = byAlert.get(st.notificationId) ?? [];
        rows.push(st);
        byAlert.set(st.notificationId, rows);
      }
      if (byAlert.size) {
        const alerts = await prisma.notification.findMany({
          where: { id: { in: [...byAlert.keys()] }, cleared: false },
          select: { id: true, triggeredAt: true },
        });
        for (const a of alerts) {
          if (now.getTime() - a.triggeredAt.getTime() < afterSec * 1000) continue;
          const rows = byAlert.get(a.id) ?? [];
          if (!rows.length) continue;
          // One reset for the alert, from its lead contribution — not one per
          // component.
          await fireReset(rule, readingFromState(rows[0]!), rows[0]!, "alert timed out", now);
          await clearAlertRow(rows[0]!, "system:timed");
          await prisma.notificationRuleState.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS },
          });
        }
      }
    } else {
      for (const st of states) {
        if (st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
          // A timed clear may have no reading at all (the asset stopped
          // reporting), so the reset context is built from the state row.
          await fireReset(rule, readingFromState(st), st, "alert timed out", now);
          await clearActiveNotification(st, "system:timed", rule);
          await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS } });
        }
      }
    }
  }
}

interface LeafTruth {
  met: boolean;
  /** Newest reading time across this leaf's dimensions — the composite's own
   *  poll anchor (a tree has no series of its own to count, so its hold counts
   *  observations and this is what says a NEW one happened). */
  readingAt?: Date | null;
  /** The first meeting dimension — names the sensor/mount/interface in the alert. */
  witness: { dimLabel: string; value: number | string | boolean | null } | null;
  /** A representative reading regardless of met (preview shows current values). */
  sample: { dimLabel: string; value: number | string | boolean | null } | null;
  hasReading: boolean;
}

async function resolveOneLeafReadings(
  leaf: CompositeLeaf,
  assets: ScopeAssetRow[],
  /** A RESET leaf inherits the automation's trigger coverage — see
   *  resolveResetTruths. Absent on a composite trigger's own leaves, which
   *  qualify for the carve-out (or not) entirely on their own terms. */
  opts?: { coverUnpinnedPoe?: boolean },
): Promise<Reading[]> {
  if (leaf.type === "asset_metric") return resolveAssetMetricReadings({ ...leaf, forDurationSec: 0 }, assets);
  if (leaf.type === "asset_state") return resolveAssetStateReadings({ ...leaf, forDurationSec: 0 }, assets, opts);
  const r = await resolveHostMetricReading({ ...leaf, forDurationSec: 0 });
  return r ? [r] : [];
}

/** Resolve every leaf's readings (identical leaves share one query) and fold
 *  them to per-asset truths. Host leaves land on the pseudo-asset id "". */
export async function resolveLeafTruths(leaves: LeafRef[], assets: ScopeAssetRow[]): Promise<Map<string, Map<string, LeafTruth>>> {
  const byResolverKey = new Map<string, Promise<Reading[]>>();
  const out = new Map<string, Map<string, LeafTruth>>();
  for (const { leafId, leaf } of leaves) {
    const key = JSON.stringify(leaf);
    let p = byResolverKey.get(key);
    if (!p) {
      p = resolveOneLeafReadings(leaf, assets);
      byResolverKey.set(key, p);
    }
    out.set(leafId, leafTruthByAsset(leaf, await p));
  }
  return out;
}

/** ANY-dimension fold: a leaf is met for an asset when any of its readings meets. */
function leafTruthByAsset(leaf: CompositeLeaf, readings: Reading[]): Map<string, LeafTruth> {
  const out = new Map<string, LeafTruth>();
  const leafTrigger = leaf as unknown as Trigger; // readingMeets reads type/operator/threshold|value only
  for (const r of readings) {
    const id = r.assetId || "";
    let t = out.get(id);
    if (!t) {
      t = { met: false, witness: null, sample: null, hasReading: true };
      out.set(id, t);
    }
    if (!t.sample) t.sample = { dimLabel: r.dimLabel, value: r.value };
    if (r.readingAt && (!t.readingAt || r.readingAt.getTime() > t.readingAt.getTime())) t.readingAt = r.readingAt;
    if (!t.met && readingMeets(leafTrigger, r.value)) {
      t.met = true;
      t.witness = { dimLabel: r.dimLabel, value: r.value };
    }
  }
  return out;
}

/** Per-(asset, dimension) truths — one entry per reading, no ANY fold. The
 *  dimension-aware half of a reset tree's lookup (see resolveResetTruths). */
function leafTruthByAssetDim(leaf: CompositeLeaf, readings: Reading[]): Map<string, LeafTruth> {
  const out = new Map<string, LeafTruth>();
  const leafTrigger = leaf as unknown as Trigger;
  for (const r of readings) {
    const key = `${r.assetId || ""}|${r.dimKey}`;
    if (out.has(key)) continue; // a resolver yields at most one reading per (asset, dimension)
    const met = readingMeets(leafTrigger, r.value);
    out.set(key, {
      met,
      witness: met ? { dimLabel: r.dimLabel, value: r.value } : null,
      sample: { dimLabel: r.dimLabel, value: r.value },
      hasReading: true,
    });
  }
  return out;
}

/**
 * A reset tree's truths, resolved DIMENSION-FIRST with a per-asset fallback.
 *
 * A composite trigger alerts once per device, so its leaves only ever need the
 * per-asset ANY fold. A reset tree can sit on a PER-DIMENSION single trigger,
 * where the firing alert belongs to one interface / sensor / mount — and the
 * seeded reset (the trigger inverted) is a leaf on that same dimension space.
 * Reading it per-asset would clear every pinned port on a switch the moment one
 * of them recovered, so the lookup tries the firing row's own dimension first.
 *
 * The fallback is what makes a MIXED tree work: a leaf on another dimension
 * space (CPU, whose dimKey is "") reports nothing at `assetId|port2`, so it
 * falls through to the ANY fold and contributes its device-wide truth. So
 * "clear port2 when port2's error rate drops AND the box's CPU is under 70"
 * evaluates each half where that half actually lives.
 *
 * And the fallback is EXACTLY as wrong for a leaf in the firing row's OWN
 * dimension space (business rule 32(b)). A leaf that is about interfaces and has
 * no reading for port2 has not said port2 recovered — it has said nothing
 * about port2 — and folding in "some other port on this switch is fine"
 * answered a question nobody asked. That is not hypothetical: a
 * `poeStatus == fault` automation covers UNPINNED ports (rule 57's carve-out)
 * while its seeded reset leaf, `poeStatus != fault`, does not qualify for the
 * carve-out, so the faulted port produced no reset reading at all — and every
 * healthy port on the switch stood in for it and cleared the alert. Hence
 * `sameSpace`: in the firing row's own vocabulary the answer is the component's
 * own reading or nothing, and nothing leaves the alert standing (a reset tree
 * never fires on absent evidence).
 *
 * `coverUnpinnedPoe` is the other half of that fix: a reset leaf inherits the
 * TRIGGER's port coverage, so the tree that has to end a carve-out alert can
 * see the same ports the trigger that raised it could. Without it the leaf is
 * silent about the one port that matters and the alert never clears at all.
 *
 * One query pass, folded twice — identical leaves still share their resolver.
 */
async function resolveResetTruths(
  leaves: LeafRef[],
  assets: ScopeAssetRow[],
  /** The dimension space of the trigger whose alerts this tree clears — what
   *  "the firing row's own vocabulary" means. Null for a whole-device trigger,
   *  where every lookup is a device lookup and the fallback is all there is. */
  triggerSpace: string | null,
  /** Does the automation's TRIGGER read unpinned PoE ports (rule 57's
   *  carve-out)? Then so must its reset leaves. */
  coverUnpinnedPoe: boolean,
): Promise<(leafId: string, assetId: string, dimKey: string) => LeafTruth | undefined> {
  const byResolverKey = new Map<string, Promise<Reading[]>>();
  const byAsset = new Map<string, Map<string, LeafTruth>>();
  const byAssetDim = new Map<string, Map<string, LeafTruth>>();
  /** Leaves that speak the firing row's own dimension vocabulary — no fallback. */
  const ownSpace = new Set<string>();
  for (const { leafId, leaf } of leaves) {
    const key = JSON.stringify(leaf);
    let p = byResolverKey.get(key);
    if (!p) {
      p = resolveOneLeafReadings(leaf, assets, { coverUnpinnedPoe });
      byResolverKey.set(key, p);
    }
    const readings = await p;
    byAsset.set(leafId, leafTruthByAsset(leaf, readings));
    byAssetDim.set(leafId, leafTruthByAssetDim(leaf, readings));
    if (triggerSpace && dimensionSpaceOf(leaf) === triggerSpace) ownSpace.add(leafId);
  }
  return (leafId, assetId, dimKey) => {
    const own = byAssetDim.get(leafId)?.get(`${assetId}|${dimKey}`);
    if (own) return own;
    // Same vocabulary, no reading for THIS component: say nothing rather than
    // letting a sibling component answer for it.
    if (dimKey && ownSpace.has(leafId)) return undefined;
    return byAsset.get(leafId)?.get(assetId);
  };
}

/** Where a tree walk gets each leaf's truth. Keyed by tree-path leafId so the
 *  same walker serves the per-asset fold (composite triggers) and the
 *  dimension-aware fold (a reset tree over a per-dimension single trigger). */
type LeafTruthLookup = (leafId: string) => LeafTruth | undefined;

function evalTriggerTree(
  node: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  lookup: LeafTruthLookup,
  prefix = "",
): boolean {
  const results = node.children.map((c, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (isTriggerLeaf(c)) return lookup(id)?.met === true; // no reading ⇒ false (never fire on absent evidence)
    return evalTriggerTree(c as TriggerConditionGroup, lookup, id);
  });
  return node.op === "and" ? results.every(Boolean) : results.some(Boolean);
}

function evalTriggerTreeForAsset(
  node: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  assetId: string,
  truths: Map<string, Map<string, LeafTruth>>,
  prefix = "",
): boolean {
  return evalTriggerTree(node, (leafId) => truths.get(leafId)?.get(assetId), prefix);
}

export interface CompositeOutcome {
  meets: boolean;
  /** Newest reading time across every leaf — see LeafTruth.readingAt. */
  readingAt?: Date | null;
  /** False when NO leaf produced a reading for this asset — the asset is
   *  skipped entirely (state frozen), matching the per-reading path's
   *  no-reading behavior. */
  hasAnyReading: boolean;
  metLeaves: Array<{ leafId: string; leaf: CompositeLeaf; witness: LeafTruth["witness"] }>;
  totalLeaves: number;
}

export function compositeOutcomeForAsset(
  tree: { op: "and" | "or"; children: (TriggerConditionGroup | CompositeLeaf)[] },
  assetId: string,
  leaves: LeafRef[],
  truths: Map<string, Map<string, LeafTruth>>,
): CompositeOutcome {
  const metLeaves: CompositeOutcome["metLeaves"] = [];
  let hasAnyReading = false;
  let readingAt: Date | null = null;
  for (const { leafId, leaf } of leaves) {
    const t = truths.get(leafId)?.get(assetId);
    if (t?.hasReading) hasAnyReading = true;
    // The NEWEST leaf reading is the tree's own: a poll on any leaf is a new
    // observation of the tree, and the alternative (the oldest) would stall the
    // count on the slowest-cadence leaf.
    if (t?.readingAt && (!readingAt || t.readingAt.getTime() > readingAt.getTime())) readingAt = t.readingAt;
    if (t?.met) metLeaves.push({ leafId, leaf, witness: t.witness });
  }
  return { meets: evalTriggerTreeForAsset(tree, assetId, truths), hasAnyReading, readingAt, metLeaves, totalLeaves: leaves.length };
}

/** Human label for a leaf condition ("CPU utilization >= 90"). */
export function leafConditionLabel(leaf: CompositeLeaf): string {
  if (leaf.type === "asset_state") {
    return `${FIELD_META[leaf.field]?.label ?? leaf.field} ${leaf.operator} ${leaf.value}`;
  }
  return `${METRIC_META[leaf.metric]?.label ?? leaf.metric} ${leaf.operator} ${leaf.threshold}`;
}

export function compositeFireInfo(outcome: CompositeOutcome): CompositeFireInfo {
  const parts = outcome.metLeaves.map(({ leaf, witness }) => {
    const base = leafConditionLabel(leaf);
    if (!witness) return base;
    const v = typeof witness.value === "number" ? round2(witness.value) : String(witness.value ?? "");
    return witness.dimLabel ? `${base} (${witness.dimLabel} = ${v})` : `${base} (${v})`;
  });
  return {
    summary: parts.join(" and ") || "conditions met",
    conditions: `${outcome.metLeaves.length} of ${outcome.totalLeaves} conditions met`,
  };
}

export const HOST_PSEUDO_ASSET: ScopeAssetRow = {
  id: "", hostname: "Polaris host", assetType: null, tags: [], discoveredByIntegrationId: null,
  monitorStatus: null, status: "active", consecutiveFailures: 0, dependencySuppressed: false,
  quarantinedAt: null, ipAddress: null,
  // The Polaris host is not a FortiGate-managed device and never will be; null
  // is the correct reading and the resolver drops it rather than producing one.
  fortilinkStatus: null, fortilinkCheckedAt: null,
};

/**
 * The Polaris server as a Path Monitor source (business rule 85, 2026-10-05).
 * Its samples are stored under the reserved subject POLARIS_SERVER_SUBJECT, so
 * this row's id is what the path resolvers query by; the readings it yields are
 * then re-keyed to assetId "" (serverPathReadings) — the subject shape of a
 * Polaris-host alert, which every fire / clear / email path already handles
 * without an asset: no assetDetail, no maintenance or dependency suppression,
 * Notification.assetId null. Never put through the scope, suppression or
 * carve-out filters: it is not a device and no device condition describes it.
 */
const PATH_SERVER_PSEUDO_ASSET: ScopeAssetRow = { ...HOST_PSEUDO_ASSET, id: POLARIS_SERVER_SUBJECT, hostname: PATH_SERVER_LABEL };

/** Resolve a path metric for the Polaris server, re-keyed to the "" subject. */
export async function serverPathReadings(trigger: Extract<Trigger, { type: "asset_metric" }>): Promise<Reading[]> {
  const raw = await resolveAssetMetricReadings(trigger, [PATH_SERVER_PSEUDO_ASSET], new Set(), new Map());
  return raw.map((r) => ({ ...r, assetId: "", hostname: PATH_SERVER_LABEL, tags: [] }));
}

/** The auto/condition clear-sustain ladder — shared by both recovery signals
 *  (auto: !triggerTree; condition: the reset tree). Mirrors the legacy
 *  per-reading sustain block exactly. */
async function applySustainedRecovery(
  rule: DbRule,
  st: { id: string; notificationId: string | null; recoveredSince: Date | null; firingSeverity?: string | null; clearRun?: number; metRun?: number; lastReadingAt?: Date | null },
  recovered: boolean,
  now: Date,
  /** Carried purely so the reset actions have a device to talk about. */
  reading?: Reading,
  /** `fireResolvedFirst`: run the severity-band resolved actions before the
   *  clear, exactly as the auto path does. Only meaningful on a banded rule
   *  (bands need a numeric single trigger, so composites never set it). */
  opts?: { fireResolvedFirst?: boolean },
): Promise<void> {
  if (!recovered && engineSustainPolls(rule) <= 0) {
    if (st.recoveredSince) {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
    }
    return;
  }
  const clear = async (): Promise<void> => {
    if (opts?.fireResolvedFirst && reading) {
      await fireResolved(rule, reading, { ...st, firingSeverity: st.firingSeverity ?? null }, now);
    }
    await recover(rule, st, reading, now);
  };
  // Counted in READINGS when the reset states a count: the recovery has to hold
  // across N consecutive observations, and an observation is one in which the
  // source actually produced a new reading (advanceRun). A non-recovered
  // reading lands here too — it is what ENDS the run.
  const sustainPolls = engineSustainPolls(rule);
  if (sustainPolls > 0) {
    const stepped = advanceRun(st.clearRun ?? 0, recovered, reading?.readingAt ?? null, st.lastReadingAt ?? null);
    if (recovered && stepped.run >= sustainPolls) {
      await clear();
      return;
    }
    if (stepped.advanced || st.recoveredSince) {
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { recoveredSince: null, clearRun: stepped.run, lastReadingAt: reading?.readingAt ?? now },
      });
    }
    return;
  }
  const sustainSec = engineSustainSec(rule);
  if (sustainSec <= 0) {
    await clear();
  } else if (!st.recoveredSince) {
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: now } });
  } else if (now.getTime() - st.recoveredSince.getTime() >= sustainSec * 1000) {
    await clear();
  }
  // else: recovered but not sustained long enough yet — keep firing.
}

export async function evaluateCompositeRule(
  rule: DbRule,
  /** The TICK's pending sends and live-alert index (business rule 75) — a
   *  composite may be a member of an AlertGroup. */
  pendingSends: PendingSends = new Map(),
  tickIndex: TickAlertIndex | null = null,
): Promise<void> {
  const trigger = rule.trigger as CompositeTrigger;
  const suppressedIds = new Set<string>();
  // Devices that are `down`, on a tree whose every leaf is read from the
  // outage itself — handed off to asset-down (business rule 29(i)).
  const deviceDownIds = new Set<string>();
  let scopeAssets: ScopeAssetRow[] = [];
  let activeAssets: ScopeAssetRow[];
  if (trigger.kind === "host") {
    activeAssets = [HOST_PSEUDO_ASSET];
  } else {
    scopeAssets = await loadScopeAssets(scopeForTrigger(rule.scope, trigger), { monitoredOnly: true });
    activeAssets = [];
    const handsOffWhenDown = triggerHandsOffWhenDeviceDown(trigger);
    for (const a of scopeAssets) {
      if (isSuppressedForNotifications(a)) suppressedIds.add(a.id);
      else if (handsOffWhenDown && assetIsDown(a)) deviceDownIds.add(a.id);
      else activeAssets.push(a);
    }
  }

  const leaves = collectLeafRefs(trigger);
  const truths = await resolveLeafTruths(leaves, activeAssets);

  const states = await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id } });
  const now = new Date();

  // Orphan sweep: composite state lives at dimensionKey "" only. Rows at any
  // other key are stale BY CONSTRUCTION (a single→composite trigger edit that
  // bypassed the service cleanup — raw API, restored backup): clear their
  // notifications and delete the rows so they can't linger firing forever.
  for (const st of states) {
    if (st.dimensionKey !== "") {
      await clearActiveNotification(st, "system:rule-edited");
      await prisma.notificationRuleState.delete({ where: { id: st.id } });
    }
  }
  const stateMap = new Map(states.filter((s) => s.dimensionKey === "").map((s) => [s.assetId ?? "", s]));

  // FROZEN, NOT DEAF (business rule 16 — frozenReadingIsFresh): a suppressed
  // asset holding a firing row is evaluated for RECOVERY only, and only when
  // its tree's newest reading was taken during the freeze.
  let frozenAssets: ScopeAssetRow[] = [];
  let frozenTruths: Awaited<ReturnType<typeof resolveLeafTruths>> | null = null;
  const frozenCandidates = scopeAssets.filter((a) => suppressedIds.has(a.id) && stateMap.get(a.id)?.state === "firing");
  if (frozenCandidates.length > 0) {
    frozenTruths = await resolveLeafTruths(leaves, frozenCandidates);
    const isFresh = await frozenFreshnessFor(frozenCandidates);
    frozenAssets = frozenCandidates.filter((a) => isFresh(a.id, compositeOutcomeForAsset(trigger, a.id, leaves, frozenTruths!).readingAt));
  }

  // Condition-mode reset: resolve the reset tree ONLY against assets that are
  // actually firing — usually zero extra queries.
  const resetTree = rule.reset.mode === "condition" ? (rule.reset.condition ?? null) : null;
  let resetOutcomeFor: (assetId: string) => CompositeOutcome | null = () => null;
  if (resetTree) {
    const firingAssets = [...activeAssets, ...frozenAssets].filter((a) => stateMap.get(a.id)?.state === "firing");
    if (firingAssets.length > 0) {
      const resetLeaves = collectLeafRefs(resetTree);
      const resetTruths = await resolveLeafTruths(resetLeaves, firingAssets);
      resetOutcomeFor = (assetId) => compositeOutcomeForAsset(resetTree, assetId, resetLeaves, resetTruths);
    }
  }

  // GROUPED ALERTS (business rule 75). A composite is the natural whole-device
  // contribution to an AlertGroup — it already fires once per asset at
  // dimensionKey "", which is exactly one contribution. It can never group on
  // its OWN (the per-rule checkbox refuses it as redundant), so the buffer is
  // armed only for a group member.
  const groupBuf: GroupBuffer | null = rule.alertGroupId && ruleGroupsByAsset(rule) ? new Map() : null;
  const liveByAsset = await liveAlertsByAsset(rule, states, tickIndex);

  // Assets actually evaluated this tick (≥1 leaf reading) — the composite
  // analogue of the per-reading path's `seen` set, for the vanished sweep.
  const evaluatedIds = new Set<string>();

  for (const a of frozenAssets.length ? [...activeAssets, ...frozenAssets] : activeAssets) {
    const frozen = suppressedIds.has(a.id);
    const outcome = compositeOutcomeForAsset(trigger, a.id, leaves, frozen ? frozenTruths! : truths);
    if (!outcome.hasAnyReading) continue; // no evidence either way — state frozen (parity with the per-reading path)
    evaluatedIds.add(a.id);
    const st = stateMap.get(a.id);
    // Frozen assets were narrowed to firing rows, so they take the firing
    // branch below and `continue` — the fire half is unreachable for them.
    if (frozen && st?.state !== "firing") continue;
    // `readingAt` is the tree's own poll anchor (the newest leaf reading), which
    // is what a poll-counted hold or clear-sustain counts observations against.
    const reading: Reading = { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value: null, readingAt: outcome.readingAt ?? null };
    const holdPolls = triggerHoldPolls(trigger);
    // A tree has no series of its own — its leaves' readings are of different
    // things — so the run lives on the state row.
    const stepped = holdPolls > 0
      ? advanceRun(st?.metRun ?? 0, outcome.meets, outcome.readingAt ?? null, st?.lastReadingAt ?? null)
      : null;

    if (st?.state === "firing") {
      if (rule.reset.mode === "condition") {
        // While firing, the reset tree is the SOLE recovery authority — the
        // trigger re-meeting does not independently cancel the sustain timer.
        // No reset reading ⇒ not recovered (never clear on absent evidence).
        const recovered = resetOutcomeFor(a.id)?.meets === true;
        await applySustainedRecovery(rule, st, recovered, now, reading);
      } else if (outcome.meets) {
        if (st.recoveredSince) {
          // Re-met mid-recovery under auto: cancel the clear-sustain timer.
          await prisma.notificationRuleState.update({ where: { id: st.id }, data: { recoveredSince: null } });
        }
      } else if (rule.reset.mode !== "auto") {
        await recover(rule, st, reading, now); // manual re-arms the state; timed waits for its sweep
      } else {
        // auto for composites = the tree is no longer true (no hysteresis
        // dead band — clearThreshold is rejected at save for composites).
        await applySustainedRecovery(rule, st, true, now, reading);
      }
      continue;
    }

    if (outcome.meets) {
      if (!st || st.state === "clear") {
        if (holdPolls > 0) {
          if (stepped && stepped.run >= holdPolls) await fire(rule, reading, null, now, compositeFireInfo(outcome), groupBuf ? { group: groupBuf } : undefined);
          else await upsertState(rule.id, reading, "pending", {
            conditionMetSince: now, lastValue: null,
            metRun: stepped?.run ?? 1, clearRun: 0, lastReadingAt: outcome.readingAt ?? now,
          });
        } else if (trigger.forDurationSec > 0) {
          await upsertState(rule.id, reading, "pending", { conditionMetSince: now, lastValue: null });
        } else {
          await fire(rule, reading, null, now, compositeFireInfo(outcome), groupBuf ? { group: groupBuf } : undefined);
        }
      } else if (st.state === "pending") {
        if (holdPolls > 0) {
          if (stepped && stepped.run >= holdPolls) await fire(rule, reading, null, now, compositeFireInfo(outcome), groupBuf ? { group: groupBuf } : undefined);
          else if (stepped?.advanced) {
            await prisma.notificationRuleState.update({
              where: { id: st.id },
              data: { metRun: stepped.run, clearRun: 0, lastReadingAt: outcome.readingAt ?? now },
            });
          }
        } else {
          const since = st.conditionMetSince ?? now;
          if (now.getTime() - since.getTime() >= trigger.forDurationSec * 1000) {
            await fire(rule, reading, null, now, compositeFireInfo(outcome), groupBuf ? { group: groupBuf } : undefined);
          }
          // else keep pending
        }
      }
    } else if (st?.state === "pending") {
      // Partial-missing under AND lands here too (missing leaf ⇒ false) — the
      // debounce restarts; accepted semantics (readings smooth over 15 min).
      // The counted run ends with it, for the same reason.
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, ...CLEARED_RUNS } });
    }
  }

  // Suppressed assets: reset pending rows (the debounce restarts after the
  // window). Firing rows belong to the suppression sweep — same contract as
  // the per-reading path.
  const compositeSuppressedIds = states
    .filter((st) => st.dimensionKey === "" && st.state === "pending" && st.assetId && suppressedIds.has(st.assetId))
    .map((st) => st.id);
  if (compositeSuppressedIds.length) {
    await prisma.notificationRuleState.updateMany({
      where: { id: { in: compositeSuppressedIds } },
      data: { state: "clear", conditionMetSince: null },
    });
  }

  // GROUPED ALERTS (business rule 75): land this composite's contributions
  // before the sweeps below, for the same reason the threshold path does —
  // a state row must never be left `firing` with no notification behind it.
  if (groupBuf?.size) await flushGroupFires(rule, groupBuf, liveByAsset, now, pendingSends, tickIndex);

  // Device-down handoff (business rule 29(i)) — same contract as the
  // per-reading path: the live alert CLEARS as superseded with no reset
  // actions, and a pending debounce restarts once the device is back.
  for (const st of states) {
    if (st.dimensionKey !== "" || !st.assetId || !deviceDownIds.has(st.assetId)) continue;
    if (st.state === "firing") {
      await clearActiveNotification(st, "system:device-down", rule);
      await prisma.notificationRuleState.update({
        where: { id: st.id },
        data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS },
      });
      await logEvent({
        action: "notification.superseded",
        resourceType: "notification",
        resourceId: st.notificationId ?? undefined,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Cleared: ${rule.name} — the device is no longer answering, so its outage is the asset-down alert`,
        details: { ruleId: rule.id, assetId: st.assetId, reason: "device-down" },
      }).catch(() => {});
      st.state = "clear"; // the timed sweep below reads this snapshot
    } else if (st.state === "pending") {
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, ...CLEARED_RUNS } });
    }
  }

  // Vanished states: assets that left the rule's scope (composite state lives
  // at dimensionKey "", so only the scope reason applies here — an evaluated
  // asset is always `seen`). Same freeze contracts as the legacy path.
  if (trigger.kind !== "host") {
    await clearVanishedStates(
      rule,
      states.filter((s) => s.dimensionKey === ""),
      new Set(Array.from(evaluatedIds, (id) => `${id}|`)),
      new Set(scopeAssets.map((a) => a.id)),
      deviceDownIds.size ? new Set([...suppressedIds, ...deviceDownIds]) : suppressedIds,
      evaluatedIds,
      // Composite state has no dimensionKey, so the pin-test carve-out never
      // applies here (pinTestForTrigger is null for composite triggers anyway).
      new Map(scopeAssets.map((a) => [a.id, a])),
    );
  }

  // Timed auto-clear sweep (identical to the legacy path; orphan rows already
  // deleted above are excluded by the dimensionKey guard).
  if (rule.reset.mode === "timed" && rule.reset.afterSec) {
    const afterSec = rule.reset.afterSec;
    for (const st of states) {
      if (st.dimensionKey === "" && st.state === "firing" && st.firedAt && now.getTime() - st.firedAt.getTime() >= afterSec * 1000) {
        // A timed clear may have no reading at all (the asset stopped
        // reporting), so the reset context is built from the state row.
        await fireReset(rule, readingFromState(st), st, "alert timed out", now);
        await clearActiveNotification(st, "system:timed");
        await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS } });
      }
    }
  }
}

async function upsertState(
  ruleId: string,
  reading: Reading,
  state: string,
  extra: {
    conditionMetSince?: Date | null;
    firedAt?: Date | null;
    lastValue?: number | null;
    notificationId?: string | null;
    /** Per-tier met-since runs (banded rules only); undefined leaves it alone. */
    bandMetSince?: Record<string, number> | null;
    /** Poll-counted run state — current-state sources only (a series-backed
     *  trigger recomputes its runs and stores none). */
    metRun?: number;
    clearRun?: number;
    lastReadingAt?: Date | null;
  },
) {
  const { bandMetSince, ...rest } = extra;
  const data = { ...rest, ...(bandMetSince !== undefined ? { bandMetSince: metSinceJson(bandMetSince) } : {}) };
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId, assetId: reading.assetId, dimensionKey: reading.dimKey, state, ...data },
    update: { state, ...data },
  });
}
