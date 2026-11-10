/**
 * src/services/notificationEngine.ts
 *
 * The notification rule evaluator. Two paths, both driven by the
 * evaluateNotificationRules job:
 *
 *  1. Threshold / state path (asset_metric, asset_state, host_metric):
 *     batch-load in-scope assets + their latest sample readings, compare
 *     against the rule, and drive a per-(rule, asset, dimension) firing state
 *     machine (clear → pending → firing) with sustained-duration + debounce.
 *     Fires only on the clear→firing crossing; clears per the rule's
 *     clearBehavior (manual / auto / timed). Modeled on capacityWatch's
 *     transition guard — state writes happen only on transition, so the hot
 *     path is bounded by the number of *changes*, not the fleet size.
 *
 *  2. Event-tail path (event, change): consume new Event audit rows since a
 *     stored cursor and match them against event/change rules. Change rules
 *     are sugar over the change-Events the persist* functions emit.
 *
 * The engine WRITES notifications; notificationService is the read/lifecycle
 * side. previewRule() dry-runs a draft against current data with no writes
 * (the builder's Test button).
 *
 * CQ-B063: the scope, readings, evaluation, alert lifecycle, event tail and
 * preview now live in src/services/notifications/*.ts (layered, none imports
 * this file back); this file keeps the entry point and re-exports every
 * public name.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { type Trigger, type RuleScope, type EmailComposition, ruleGroupsByAsset, normalizeRuleToV2, buildShadowIndex, isAssetShadowed } from "./notificationTypes.js";
import { buildComposedEmail } from "./notificationRecipientService.js";

// CQ-B063 — the rule model, comparators, lookback windows (notifications/ruleModel.ts).
import { type DbRule } from "./notifications/ruleModel.js";

// CQ-B063 — the per-tick asset-detail + blame caches (notifications/assetDetail.ts).
import { _assetDetailCache, _blameCache, clearAssetDetailCache } from "./notifications/assetDetail.js";

// CQ-B063 — scope → assets and the pin tests (notifications/scope.ts).
import { clearScopeAssetCache } from "./notifications/scope.js";

// CQ-B063 — the alert lifecycle: fire / reset / recover + grouped alerts, business rule 75 (notifications/alertLifecycle.ts).
import { type PendingSends, TickAlertIndex, releaseDueGroupSends, drainPendingSends } from "./notifications/alertLifecycle.js";

// CQ-B063 — threshold / state + composite evaluation (notifications/evaluation.ts).
import { evaluationOrder, evaluateThresholdRule, evaluateCompositeRule } from "./notifications/evaluation.js";

// CQ-B063 — event-tail evaluation (notifications/eventTail.ts).
import { runEventRuleTimedClear, runEventTail, applyLinkedForecastLevels } from "./notifications/eventTail.js";

// CQ-B063 — the builder Test-button preview (notifications/preview.ts).
export { type PreviewMatch, type CarveOutPeer, carveOutAggregate, applyCarveOutToMatches, previewRule, applicableTemplateTokens, previewAlertMessage } from "./notifications/preview.js";

export { globToRegExp, runEventRuleTimedClear, type MaintenanceSpan, suppressedAtEventTime } from "./notifications/eventTail.js";

export { evaluationOrder } from "./notifications/evaluation.js";

export { forecastCountdownMoved } from "./notifications/alertLifecycle.js";

export { tierForSeverity, bandNotifyOf } from "./notifications/severityBands.js";


export { applyDeviceFilters, type InterfaceStateRow, interfaceSampleCarries, interfaceStateSeries, streamFailingMinutes, readingMeets, recoveredMeets } from "./notifications/readings.js";

export { assetCanTrigger, loadScopeAssetIds, loadScopeRegionSnapshots, isSuppressedForNotifications, frozenReadingIsFresh, assetIsAnsweringProbes, triggerHandsOffWhenDeviceDown, assetIsDown, interfaceIsPinned, poeFaultCoversUnpinned, interfaceDimLabel, tunnelIsPinned, storageIsPinned } from "./notifications/scope.js";

export { clearAssetDetailCache } from "./notifications/assetDetail.js";

export { lookbackMsFor, fireLookbackMsFor, withRecoveryLookback, compareNum, compareValue } from "./notifications/ruleModel.js";

// buildComposedEmail moved to notificationRecipientService (the action layer
// composes per-action emails and importing it from here would be circular);
// re-exported so the escalation sweep + tests keep their import path.
export { buildComposedEmail };

// ─── Specificity precedence / carve-out ─────────────────────────────────────
// A more-specific automation "carves" the assets it covers out of a
// less-specific one that watches the SAME trigger (triggerSignature): those
// assets drop their readings, any active alert on the general rule clears
// (superseded), and its pending debounce resets. Same-rank ties both fire.
// Built once per engine tick over the enabled rule set; only asset_metric /
// asset_state rules (non-null signature) participate.
//
// The index and the per-asset test live in notificationTypes so the asset
// Alerts tab's "automations that can trigger" lookup (notificationRuleService,
// which this module imports) applies the very same carve-out; re-exported here
// for the tests' import path.
export { buildShadowIndex, isAssetShadowed };

// ─── Entry point ────────────────────────────────────────────────────────────

export async function evaluateAllNotificationRules(): Promise<void> {
  const dbRules = await prisma.notificationRule.findMany({
    where: { enabled: true },
    include: { alertGroup: { select: { foldBy: true, name: true } } },
  });
  const rules: DbRule[] = dbRules.map((r) => {
    // Shape-v2 normalization: legacy rows (clearBehavior/targets) and v2 rows
    // (reset/actions) evaluate identically through the v2 view.
    const v2 = normalizeRuleToV2(r);
    return {
      id: r.id, name: r.name, description: r.description, severity: r.severity,
      trigger: r.trigger as unknown as Trigger,
      scope: (r.scope ?? {}) as RuleScope,
      reset: v2.reset,
      actions: v2.actions,
      cooldownSec: r.cooldownSec,
      messageTemplate: r.messageTemplate,
      emailComposition: (r.emailComposition ?? null) as EmailComposition | null,
      escalation: v2.escalation,
      severityBands: v2.severityBands,
      bandNotify: v2.bandNotify,
      resetActions: v2.resetActions,
      repeat: v2.repeat,
      // Not part of the v2 normalization — grouping is a real column on the
      // rule, deliberately not a key inside the trigger (a trigger key would
      // change triggerSignature and stop a grouped rule shadowing its
      // ungrouped sibling in the carve-out index, business rule 46).
      groupByAsset: r.groupByAsset === true,
      severityFromPriorityTag: r.severityFromPriorityTag === true,
      alertGroupId: r.alertGroupId ?? null,
      alertGroupFoldBy: r.alertGroup?.foldBy ?? null,
      alertGroupName: r.alertGroup?.name ?? null,
    };
  });
  await applyLinkedForecastLevels(rules);

  clearAssetDetailCache();
  // Arm the per-tick scope memo for the duration of this pass only. The
  // finally below disarms it even if the pass throws — left armed, an
  // operator's preview between ticks would answer from a stale snapshot.
  clearScopeAssetCache(true);
  try {

  // Precedence index: which asset_metric/asset_state rules can carve assets out
  // of which (same trigger signature, higher scope specificity). Built once.
  const shadowIndex = buildShadowIndex(rules);

  // Grouped alerts (business rule 75): the tick's sends, drained once every
  // rule has been evaluated rather than inside each rule's flush. A grouped
  // alert therefore sends ONCE per tick with the final member set, whatever
  // order its contributions arrived in.
  const pendingSends: PendingSends = new Map();
  // Live grouped alerts, keyed by groupKey. Loaded lazily and only when an
  // AlertGroup member actually needs it, so an install with no groups never
  // issues the query.
  const tickIndex = new TickAlertIndex();

  for (const rule of evaluationOrder(rules)) {
    try {
      if (rule.trigger.type === "composite") {
        await evaluateCompositeRule(rule, pendingSends, tickIndex);
      } else if (rule.trigger.type === "asset_metric" || rule.trigger.type === "asset_state" || rule.trigger.type === "host_metric") {
        await evaluateThresholdRule(rule, shadowIndex, pendingSends, tickIndex);
      }
    } catch (err) {
      await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: `Rule "${rule.name}" evaluation failed`, details: { ruleId: rule.id, err: (err as Error)?.message } }).catch(() => {});
    }
  }

  // After every rule, before the event tail: the alerts exist and their member
  // sets are final, so each one's message goes out exactly once. Best-effort,
  // like every other fan-out — a failed send must not cost the fleet a tick.
  try {
    // Grouped alerts whose first-send hold has ended join this drain. Only an
    // install with a grouping automation can hold one, so every other skips
    // the query.
    if (rules.some((r) => ruleGroupsByAsset(r))) {
      await releaseDueGroupSends(new Map(rules.map((r) => [r.id, r])), pendingSends, new Date());
    }
    await drainPendingSends(pendingSends);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Grouped-alert send drain failed", details: { err: (err as Error)?.message } }).catch(() => {});
  }

  try {
    await runEventTail(rules);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Event-tail evaluation failed", details: { err: (err as Error)?.message } }).catch(() => {});
  }

  try {
    await runEventRuleTimedClear(rules);
  } catch (err) {
    await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: "Event-rule timed clear failed", details: { err: (err as Error)?.message } }).catch(() => {});
  }

  } finally {
    clearScopeAssetCache(false);
  }
}
