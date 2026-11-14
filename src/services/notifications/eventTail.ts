/**
 * src/services/notifications/eventTail.ts — event-tail evaluation (CQ-B063, moved verbatim from notificationEngine.ts): the incremental scan of new Event rows
 * that event-type triggers fire on, and its cursor.
 */

import { compileGlob, type PatternMatcher } from "../../utils/wildcard.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { logEvent } from "../eventLogService.js";
import { triggerSummary, triggerTokenParts } from "../../utils/triggerSummary.js";
import { eventSubjectLabel } from "../../utils/alertSubject.js";
import { chartKeysForChangeEvent } from "../alertChartService.js";
import { eventMatchesPathServer, scopeForTrigger, type Trigger, type SeverityBand, CHANGE_TYPE_ACTIONS, forecastLevelsSourceId, linkForecastLevels, scopeIsUnconstrained, eventFeedsAutomations } from "../notificationTypes.js";
import { scopeMatchesAsset } from "../notificationRuleService.js";
import { decorateRelationLeafHits } from "../scopeRelationIndex.js";
import { scopeRegionTagsOf } from "../notificationRecipientService.js";
import { buildTemplateContext, renderNotificationTemplate, notificationsPageUrl } from "../../utils/notificationTemplate.js";
import { DEFAULT_LOOKBACK_MS, type DbRule } from "./ruleModel.js";
import { ASSET_DETAIL_SELECT, type AssetDetailRow, _assetDetailCache, assetDetail } from "./assetDetail.js";
import { assetCanTrigger, regionSnapshot } from "./scope.js";
import { followUpParts, ruleWantsContext } from "./templating.js";
import { executeActionsSafe } from "./alertActions.js";
import { fireReset } from "./alertLifecycle.js";

const LAST_EVENT_SETTING_KEY = "notificationEngine.lastEventCursor";

// ─── Event-tail evaluation ──────────────────────────────────────────────────

/**
 * An event trigger's action pattern as an anchored, case-insensitive matcher —
 * `*` is the only wildcard. Linear (utils/wildcard.compileGlob), never a regex:
 * the old `*` → `.*` translation let a stored `****…x` backtrack
 * combinatorially on every Event.action in the tail (business rule 116). The
 * name is kept for its callers; the result has `.test` like a RegExp.
 */
export function globToRegExp(glob: string): PatternMatcher {
  return compileGlob(glob, { ignoreCase: true, questionMark: false });
}

const LEVEL_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

/**
 * Timed reset for event/change rules. The two timed sweeps walk
 * NotificationRuleState rows, but the event tail never creates state rows —
 * so without this pass a timed event rule's notifications stayed uncleared
 * forever (and `timed` is the wizard DEFAULT for event triggers). One
 * updateMany per timed event rule per tick — independent of fleet size.
 */
export async function runEventRuleTimedClear(rules: DbRule[], now = new Date()): Promise<number> {
  const timedRules = rules.filter(
    (r) =>
      (r.trigger.type === "event" || r.trigger.type === "change") &&
      r.reset.mode === "timed" &&
      r.reset.afterSec != null,
  );
  let cleared = 0;
  for (const rule of timedRules) {
    const cutoff = new Date(now.getTime() - (rule.reset.afterSec as number) * 1000);
    // Reset actions need the alerts THEMSELVES, not a count — an action is
    // per-alert (its deliveries hang off a notification id). Select first when
    // the rule has any, then clear; without reset actions this stays the
    // single bulk update it always was.
    const doomed = rule.resetActions?.length
      ? await prisma.notification.findMany({
          where: { ruleId: rule.id, cleared: false, triggeredAt: { lte: cutoff } },
          select: { id: true, assetId: true, assetHostname: true },
          take: 500,
        })
      : [];
    for (const n of doomed) {
      await fireReset(
        rule,
        { assetId: n.assetId ?? "", hostname: n.assetHostname, tags: [], dimKey: "", dimLabel: "", value: null },
        { notificationId: n.id },
        "alert timed out",
        now,
      );
    }
    const res = await prisma.notification.updateMany({
      where: { ruleId: rule.id, cleared: false, triggeredAt: { lte: cutoff } },
      data: { cleared: true, clearedBy: "system:timed", clearedAt: now },
    });
    if (res.count > 0) {
      cleared += res.count;
      await logEvent({
        action: "notification.auto_cleared",
        resourceType: "notification",
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `Timed reset: cleared ${res.count} alert(s) of "${rule.name}" older than ${rule.reset.afterSec}s`,
        details: { ruleId: rule.id, count: res.count, afterSec: rule.reset.afterSec },
      }).catch(() => {});
    }
  }
  return cleared;
}

/**
 * One matched clearing event → the alerts it closes.
 *
 * Scoped to the SAME subject the alert is about: `agent.connected` for one
 * asset says nothing about another asset's agent, so the clear is keyed on the
 * identity the notification already stores (assetId when the event names an
 * asset, else the resource label the alert was filed under). `triggeredAt <=`
 * the clearing event keeps a batch that contains disconnect → reconnect →
 * disconnect from clearing the SECOND outage with the FIRST reconnect.
 */
async function applyEventReset(
  rule: DbRule,
  hit: { assetId: string | null; subjectLabel: string; at: Date },
): Promise<void> {
  const where: Prisma.NotificationWhereInput = {
    ruleId: rule.id,
    cleared: false,
    triggeredAt: { lte: hit.at },
    ...(hit.assetId ? { assetId: hit.assetId } : { assetId: null, assetHostname: hit.subjectLabel || null }),
  };
  // Reset actions are per-alert (their delivery rows hang off a notification
  // id), so select first when the rule has any — otherwise this stays the one
  // bulk update it would be without them.
  const doomed = rule.resetActions?.length
    ? await prisma.notification.findMany({ where, select: { id: true, assetId: true, assetHostname: true }, take: 500 })
    : [];
  for (const n of doomed) {
    await fireReset(
      rule,
      { assetId: n.assetId ?? "", hostname: n.assetHostname, tags: [], dimKey: "", dimLabel: "", value: null },
      { notificationId: n.id },
      "recovered",
      hit.at,
    );
  }
  const res = await prisma.notification.updateMany({
    where,
    data: { cleared: true, clearedBy: "system:event-reset", clearedAt: new Date() },
  });
  if (res.count > 0) {
    await logEvent({
      action: "notification.auto_cleared",
      resourceType: "notification",
      resourceName: rule.name,
      actor: "system:notification-engine",
      message: `Event reset: cleared ${res.count} alert(s) of "${rule.name}" — ${rule.reset.resetEvent?.actionPattern} occurred for ${hit.subjectLabel || "the same resource"}`,
      details: { ruleId: rule.id, count: res.count, resetPattern: rule.reset.resetEvent?.actionPattern ?? null },
    }).catch(() => {});
  }
}

export async function runEventTail(rules: DbRule[]): Promise<void> {
  const eventRules = rules.filter((r) => r.trigger.type === "event" || r.trigger.type === "change");
  if (eventRules.length === 0) return;

  const cursorRow = await prisma.setting.findUnique({ where: { key: LAST_EVENT_SETTING_KEY } });
  const cursorIso = (cursorRow?.value as any)?.lastTimestamp as string | undefined;
  const since = cursorIso ? new Date(cursorIso) : new Date(Date.now() - DEFAULT_LOOKBACK_MS);

  const events = await prisma.event.findMany({
    where: { timestamp: { gt: since } },
    orderBy: { timestamp: "asc" },
    take: 1000,
    // Only what the matchers, the fire and the cursor read.
    select: { timestamp: true, level: true, action: true, resourceType: true, resourceId: true, resourceName: true, actor: true, message: true, details: true },
  });
  if (events.length === 0) return;

  // Cooldown pre-pass: the event tail has no per-(rule,asset) state rows, so
  // cooldownSec is enforced against the recent Notification rows themselves —
  // one query for all cooldown-bearing event rules, keyed by the same
  // (rule, assetId-or-resourceName) identity the notifications store. The map
  // updates in-loop so a single 1000-event batch also self-dedupes.
  const cooldownRules = eventRules.filter((r) => r.cooldownSec && r.cooldownSec > 0);
  const lastFired = new Map<string, number>();
  if (cooldownRules.length > 0) {
    const maxCooldownMs = Math.max(...cooldownRules.map((r) => (r.cooldownSec as number) * 1000));
    const recent = await prisma.notification.findMany({
      where: {
        ruleId: { in: cooldownRules.map((r) => r.id) },
        triggeredAt: { gte: new Date(Date.now() - maxCooldownMs) },
      },
      select: { ruleId: true, assetId: true, assetHostname: true, triggeredAt: true },
    });
    for (const n of recent) {
      const key = `${n.ruleId}|${n.assetId ?? n.assetHostname ?? ""}`;
      const t = n.triggeredAt.getTime();
      if ((lastFired.get(key) ?? 0) < t) lastFired.set(key, t);
    }
  }

  // Precompile matchers. flatMap so non-event/change rules (shouldn't appear,
  // but the filter predicate isn't a type guard) are dropped and TS narrows.
  type CompiledMatcher = {
    rule: DbRule;
    re: PatternMatcher;
    trigger: Extract<Trigger, { type: "event" }> | Extract<Trigger, { type: "change" }>;
    /** Does this rule's scope name devices? Precomputed per rule, not per
     *  event: a 1000-event batch would otherwise re-walk the same scope object
     *  a thousand times. See business rule 46. */
    scoped: boolean;
  };
  const compiled: CompiledMatcher[] = eventRules.flatMap((r): CompiledMatcher[] => {
    const scoped = !scopeIsUnconstrained(r.scope);
    if (r.trigger.type === "event") {
      return [{ rule: r, re: globToRegExp(r.trigger.actionPattern), trigger: r.trigger, scoped }];
    }
    if (r.trigger.type === "change") {
      const action = CHANGE_TYPE_ACTIONS[r.trigger.changeType];
      return [{ rule: r, re: globToRegExp(action), trigger: r.trigger, scoped }];
    }
    return [];
  });

  // Reset matchers: the counterpart event that says the thing came back. Kept
  // in the same pass as the trigger matchers because both read the same batch
  // and the same cursor — a second query would either re-read events or race
  // the cursor advance below.
  const resetMatchers = eventRules.flatMap((r) =>
    r.reset.mode === "event" && r.reset.resetEvent?.actionPattern
      ? [{ rule: r, re: globToRegExp(r.reset.resetEvent.actionPattern), resourceType: r.reset.resetEvent.resourceType ?? null }]
      : [],
  );
  const resetHits: { rule: DbRule; assetId: string | null; subjectLabel: string; at: Date }[] = [];

  const toCreate: Prisma.NotificationCreateManyInput[] = [];
  // Notifications from rules with actions get a client-generated id so we can
  // execute their actions after the batch insert (createMany returns no ids).
  // The fire-time template context rides along — api_call bodies render from it.
  const deliverAfter: { id: string; rule: DbRule; assetId: string | null; ctx: Record<string, string>; assetRegionTags: string[] }[] = [];
  // Warm the asset-detail cache for the whole batch up front — the loop below
  // reads it per matched event, and the miss-per-distinct-asset pattern is at
  // its worst exactly when a broad outage fills the batch with asset events.
  // Maintenance windows that were open at any point across this batch's span,
  // for the gate below. Loaded per batch rather than per event: see
  // loadMaintenanceSpansForEvents for why the live Asset row cannot answer
  // this question for an event that is up to a tick old.
  let maintenanceSpans = new Map<string, MaintenanceSpan[]>();
  if (compiled.length > 0) {
    const eventAssetIds = [...new Set(events.flatMap((ev) => (ev.resourceType === "asset" && ev.resourceId ? [ev.resourceId] : [])))];
    await primeAssetDetailCache(eventAssetIds);
    // `events` is ordered by timestamp asc, so the ends of the batch are the
    // ends of its span.
    maintenanceSpans = await loadMaintenanceSpansForEvents(
      eventAssetIds,
      events[0]!.timestamp,
      events[events.length - 1]!.timestamp,
    );
    // Relation-backed device-filter leaves (interface name, SSID, FortiGate
    // sighting) resolve in SQL for the whole batch — one query per DISTINCT
    // leaf, and no query at all when no filter asks for one — instead of
    // joining those relations onto every primed row. Same contract the
    // threshold path and downDetectionService use, for the same reason: at
    // 2000 assets the relations dwarf the rows they hang off.
    const scopedTrees = compiled.filter((c) => c.scoped).map((c) => scopeForTrigger(c.rule.scope, c.trigger)?.condition);
    if (scopedTrees.length > 0) {
      const rows = eventAssetIds.map((id) => _assetDetailCache.get(id)).filter((r): r is AssetDetailRow => !!r);
      await decorateRelationLeafHits(rows, scopedTrees);
    }
  }
  for (const ev of events) {
    // Business rule 106: the record that an alert email went out is never a
    // trigger or a reset. Skipped before BOTH matcher sets; the cursor still
    // advances past it with the rest of the batch.
    if (!eventFeedsAutomations(ev.action)) continue;
    // Which rules this same event FIRED — a rule whose trigger and reset globs
    // both match one event (`agent.*` on both sides) would otherwise clear the
    // alert it just raised, in the same tick, forever.
    const firedThisEvent = new Set<string>();
    const resetHitsBefore = resetHits.length;
    for (const m of resetMatchers) {
      if (!m.re.test(ev.action)) continue;
      if (m.resourceType && ev.resourceType !== m.resourceType) continue;
      resetHits.push({
        rule: m.rule,
        assetId: ev.resourceType === "asset" ? ev.resourceId ?? null : null,
        subjectLabel: eventSubjectLabel(ev.resourceType, ev.resourceName),
        at: ev.timestamp,
      });
    }
    for (const c of compiled) {
      if (!c.re.test(ev.action)) continue;
      if (c.trigger.type === "event") {
        if (c.trigger.resourceType && ev.resourceType !== c.trigger.resourceType) continue;
        if (c.trigger.minLevel && (LEVEL_RANK[ev.level] ?? 0) < (LEVEL_RANK[c.trigger.minLevel] ?? 0)) continue;
        if (c.trigger.detailsMatch && !detailsMatch(ev.details, c.trigger.detailsMatch)) continue;
      }
      const assetId = ev.resourceType === "asset" ? ev.resourceId ?? null : null;
      const detail = assetId ? await assetDetail(assetId) : null;
      // Device filter (business rule 46). Read BEFORE the fired stamp below,
      // not with the state gates further down: an automation whose filter
      // doesn't name this device isn't watching this event at all, so it must
      // not suppress its own reset either. An event that names no asset — an
      // integration, a user, the host — cannot satisfy a device filter and is
      // therefore not a match for a filtered automation; nor is one whose
      // asset row is already gone (`asset.deleted`), because there is nothing
      // left to test the filter against. Unfiltered automations (`{}` or
      // "All assets") take neither branch and behave exactly as before.
      // Path Monitor: the Polaris server's own route change names the CHECK,
      // not a host, so no device filter can match it — whether it counts is
      // the automation's includeServer (eventMatchesPathServer).
      const serverPath = eventMatchesPathServer(c.trigger, c.scoped, ev.resourceType);
      if (serverPath === false) continue;
      if (serverPath === null && c.scoped && (!detail || !scopeMatchesAsset(scopeForTrigger(c.rule.scope, c.trigger), detail))) continue;
      // Stamped as soon as the TRIGGER matches, ahead of the gate and the
      // cooldown: "this event raises this automation" is a property of the two
      // globs overlapping, and a cooldown-suppressed fire must block the reset
      // exactly the same way — otherwise a wide glob clears the alert the
      // cooldown was protecting.
      firedThisEvent.add(c.rule.id);
      // What this alert is ABOUT, as a label. A system-scoped Event (capacity,
      // backups, updates) names no resource because the resource IS this
      // install, so without the fallback the alert had no subject at all. Used
      // for every field that has to agree on it: {asset}, the stored
      // assetHostname, and the cooldown key below.
      const subjectLabel = eventSubjectLabel(ev.resourceType, ev.resourceName);
      // Event/change rules honor the SAME trigger gate as threshold rules
      // (assetCanTrigger): no notifications about an asset Polaris isn't
      // polling — unmonitored, or one of the four statuses that can't be
      // monitor-enabled — nor about one in a maintenance window or
      // dependency-suppressed behind a dark parent. Event and change triggers
      // used to be the deliberate exception to the monitored half; they no
      // longer are, so "an automation fires about it" and "Polaris watches it"
      // are one answer. (The event cursor still advances — skipped events are
      // skipped, not deferred.)
      //
      // A null detail is NOT a skip: the asset row is gone (an `asset.deleted`
      // event is the case that matters), and swallowing those would silence
      // the deletion audit trail. System-scoped events carry no assetId at
      // all and are unaffected.
      if (detail && !assetCanTrigger(detail)) continue;
      // ...and the same gate asked as of WHEN THE EVENT HAPPENED. The check
      // above reads the asset's status now; this one reads the maintenance
      // window history at ev.timestamp, which is the only way a window shorter
      // than this job's 60s interval can suppress anything at all (business
      // rule 80a — an agent upgrade's window is about two seconds wide). The
      // cursor still advances: a suppressed event is skipped, not deferred.
      if (suppressedAtEventTime(maintenanceSpans, assetId, ev.timestamp)) continue;
      // Cooldown: skip when this (rule, asset/resource) fired within
      // cooldownSec — and stamp the map so later events in this batch dedupe.
      if (c.rule.cooldownSec) {
        const cdKey = `${c.rule.id}|${assetId ?? subjectLabel}`;
        const last = lastFired.get(cdKey);
        const evT = ev.timestamp.getTime();
        if (last !== undefined && evT - last < c.rule.cooldownSec * 1000) continue;
        lastFired.set(cdKey, evT);
      }
      const tags = detail?.tags ?? [];
      // Event-path token mapping: {asset}=resourceName, {metric}=action,
      // {value}=event message; threshold/dimension are empty.
      const ctx = buildTemplateContext({
        asset: subjectLabel,
        metric: ev.action,
        value: ev.message,
        threshold: "",
        // A change trigger names its change type ("LLDP neighbor appeared"); an
        // audit-event one has no metric of its own, so this stays empty.
        metricLabel: triggerTokenParts(c.rule.trigger as never).metricLabel,
        dimension: "",
        severity: c.rule.severity,
        time: ev.timestamp,
        link: notificationsPageUrl(),
        ruleName: c.rule.name,
        ruleDescription: c.rule.description,
        assetDetail: detail,
        // The EVENT's own identity. Most event automations fire on things that
        // aren't assets at all (an integration, a user, the host), so the
        // device facts prune away and this is the only thing the email can say
        // about what happened. Composed at fire time — the Event row is in
        // hand here and gone by delivery.
        event: {
          action: ev.action,
          level: ev.level,
          resourceType: ev.resourceType,
          resourceName: ev.resourceName,
          actor: ev.actor,
          // Why it happened, as its own token: the email prints it as a facts
          // row, so the reason survives whatever the rule's messageTemplate
          // says (the 12 seeded event automations use "{value}" to surface
          // exactly this text, and the body no longer relies on that).
          message: ev.message,
        },
        triggerSummary: triggerSummary({
          trigger: c.rule.trigger as never,
          eventAction: ev.action,
          // "… on Polaris server" for a system-scoped event, where the bare
          // resourceType ("system") named nothing a reader recognizes.
          eventResource: subjectLabel || ev.resourceType || null,
        }),
        ...followUpParts(c.rule, c.rule.severity),
      });
      const tmpl = c.rule.messageTemplate;
      const message = tmpl && tmpl.trim()
        ? renderNotificationTemplate(tmpl, ctx)
        : `${c.rule.name}: ${ev.message}`;
      ctx["message"] = message;
      const hasActions = c.rule.actions.length > 0;
      const id = hasActions ? randomUUID() : undefined;
      if (hasActions && id) {
        deliverAfter.push({ id, rule: c.rule, assetId, ctx, assetRegionTags: regionSnapshot(tags) });
      }
      // Almost every event alert is chart-blind, and rightly so: nothing fired
      // as a metric, so metric/dimension stay null and the email's charts fall
      // through to the device's own story. A few change events ARE about one
      // sub-asset and know which — an SD-WAN failover names the service rule
      // and the member it left — and for those the columns are stamped so the
      // delivery-time charts can resolve the path (alertChartService). Null for
      // everything else, which leaves those alerts exactly as they were.
      const chartKeys = chartKeysForChangeEvent(ev.action, ev.details);
      toCreate.push({
        ...(id ? { id } : {}),
        ruleId: c.rule.id,
        assetId,
        // The in-app / mobile alert lists render this as the alert's subject —
        // blank for a system-scoped event before the label existed.
        assetHostname: subjectLabel || null,
        severity: c.rule.severity,
        message,
        regionTags: regionSnapshot(tags),
        ...(chartKeys ? { metric: chartKeys.metric, dimension: chartKeys.dimension } : {}),
        ...(ruleWantsContext(c.rule) ? { templateCtx: ctx } : {}),
      });
    }
    // Drop any reset hit THIS event also fired: an event cannot both raise and
    // clear the same automation's alert. Bounded to the hits this iteration
    // added, so an earlier event's hit for the same rule is untouched.
    if (firedThisEvent.size > 0) {
      for (let i = resetHits.length - 1; i >= resetHitsBefore; i--) {
        if (firedThisEvent.has(resetHits[i].rule.id)) resetHits.splice(i, 1);
      }
    }
  }

  if (toCreate.length > 0) {
    await prisma.notification.createMany({ data: toCreate });
  }
  for (const d of deliverAfter) {
    await executeActionsSafe(d.id, d.rule.actions, d.ctx, {
      scopeRegionTags: scopeRegionTagsOf(d.rule.scope),
      assetRegionTags: d.assetRegionTags,
      assetId: d.assetId,
      ruleId: d.rule.id,
      ruleName: d.rule.name,
      ruleEmailComposition: d.rule.emailComposition,
      actor: "system:notification-engine",
    });
  }

  // Applied AFTER the batch's own fires land: within one batch a disconnect
  // and its reconnect can both arrive, and the disconnect alert genuinely
  // happened — it is raised, delivered, then cleared, rather than swallowed.
  //
  // Deduped to the LAST hit per (rule, subject) first: a Polaris restart
  // reconnects the whole agent fleet at once, and without this a subject that
  // flapped twice inside one 1000-event batch would issue two updateManys for
  // the same (already cleared) alert. The later hit's `at` is the safe one to
  // keep — it can only ever clear MORE of what was already eligible.
  const dedupedHits = new Map<string, (typeof resetHits)[number]>();
  for (const hit of resetHits) dedupedHits.set(`${hit.rule.id}|${hit.assetId ?? hit.subjectLabel}`, hit);
  for (const hit of dedupedHits.values()) {
    try {
      await applyEventReset(hit.rule, hit);
    } catch (err) {
      await logEvent({ action: "notification.engine_error", actor: "system:notification-engine", level: "error", message: `Event reset for "${hit.rule.name}" failed`, details: { ruleId: hit.rule.id, err: (err as Error)?.message } }).catch(() => {});
    }
  }

  const newest = events[events.length - 1].timestamp.toISOString();
  await prisma.setting.upsert({
    where: { key: LAST_EVENT_SETTING_KEY },
    create: { key: LAST_EVENT_SETTING_KEY, value: { lastTimestamp: newest } },
    update: { value: { lastTimestamp: newest } },
  });
}

function detailsMatch(details: unknown, match: Record<string, string | number | boolean>): boolean {
  if (!details || typeof details !== "object") return false;
  const d = details as Record<string, unknown>;
  return Object.entries(match).every(([k, v]) => String(d[k]) === String(v));
}

/**
 * One maintenance window's span. `endedAt: null` = still open.
 */
export type MaintenanceSpan = { startedAt: Date; endedAt: Date | null };

/**
 * ─── Suppression at EVENT time, not tick time (business rule 80a) ───────────
 *
 * `assetCanTrigger` reads the live Asset row, which is the right question for
 * a threshold rule: a reading is current by definition, so "is this device
 * suppressed" and "was it suppressed when this was measured" are the same
 * question. The EVENT tail is different, and the difference is a real leak.
 *
 * Events are a backlog. `runEventTail` reads everything since a cursor and the
 * job runs once a MINUTE, so an event is routinely judged up to 60 seconds
 * after it happened — against whatever the asset's status is by then. Any
 * maintenance window shorter than that interval is therefore invisible to the
 * gate: it opened and closed entirely between two ticks, and the engine sees
 * an asset that is plainly `active`.
 *
 * That is not hypothetical. Business rule 80 holds an asset in maintenance for
 * the duration of an agent upgrade so the `agent.disconnected` the operator
 * asked for does not page anyone — and a 0.19.0 → 0.20.0 upgrade takes about
 * TWO SECONDS end to end:
 *
 *   10:30:47  agent.upgrade_kickoff
 *   10:30:47  maintenance.entered      ← hold taken, window opens
 *   10:30:49  agent.disconnected       ← written INSIDE the window
 *   10:30:49  agent.connected
 *   10:30:49  maintenance.exited       ← released on reattach, window closes
 *
 * Every part of rule 80 worked. The window was open at the instant the event
 * was written. But by the time the tail read that event the window had been
 * shut for most of a minute, so the gate passed it and the operator was paged
 * for exactly the work they had asked for — the thing rule 80 exists to stop.
 * The faster the upgrade, the more reliably it leaks, which is why it survived
 * the rule's own testing: a slow operation is still in its window when the
 * tick lands.
 *
 * So the tail asks the question the event's own timestamp asks, against the
 * window HISTORY (`AssetMaintenanceWindow` keeps `startedAt` / `endedAt` and is
 * indexed `[assetId, startedAt]`). This is general, not an agent carve-out: a
 * scheduled window that ends quickly, or an operator releasing maintenance
 * shortly after an event, leaked the same way.
 *
 * **The boundary is strict — no grace after `endedAt`, deliberately.** It is
 * tempting to extend the window by a few seconds to absorb the fact that
 * `Event.timestamp` is `@default(now())` (stamped by the DATABASE at insert)
 * while `detach()` writes its event without awaiting it, so a heavily loaded
 * host could in principle land the insert just after the window closed. A
 * grace would also swallow `agent.upgrade_failed`, which `failUpgrade` writes
 * IMMEDIATELY after dropping the hold — on purpose, so a dead agent still
 * alerts. Losing that is far worse than the rare race, which merely degrades
 * to the behaviour we have today (one late alert), so the strict test wins.
 *
 * Covers the maintenance half of the gate only. `dependencySuppressed` is a
 * live boolean on Asset with no history to consult, so a suppression that
 * clears within the tick still leaks — a separate problem, and not one any
 * table here can answer.
 */
async function loadMaintenanceSpansForEvents(
  assetIds: string[],
  from: Date,
  to: Date,
): Promise<Map<string, MaintenanceSpan[]>> {
  const byAsset = new Map<string, MaintenanceSpan[]>();
  if (assetIds.length === 0) return byAsset;
  const rows = await prisma.assetMaintenanceWindow.findMany({
    where: {
      assetId: { in: assetIds },
      // Overlaps the batch's span: started no later than its newest event, and
      // either still open or closed no earlier than its oldest. One query per
      // tick, bounded by the assets IN THE BATCH rather than by the fleet —
      // at 2000 assets a quiet minute still costs nothing.
      startedAt: { lte: to },
      OR: [{ endedAt: null }, { endedAt: { gte: from } }],
    },
    select: { assetId: true, startedAt: true, endedAt: true },
  });
  for (const r of rows) {
    const list = byAsset.get(r.assetId);
    if (list) list.push({ startedAt: r.startedAt, endedAt: r.endedAt });
    else byAsset.set(r.assetId, [{ startedAt: r.startedAt, endedAt: r.endedAt }]);
  }
  return byAsset;
}

/**
 * Was this asset inside a maintenance window at `at`? Pure, so the boundary
 * cases are testable without a database — and the boundaries are the whole
 * point of this function. Both ends are INCLUSIVE: an event stamped the same
 * millisecond a window opened or closed belongs to it, which is the common
 * case rather than an edge when a window lasts two seconds.
 */
export function suppressedAtEventTime(
  spans: Map<string, MaintenanceSpan[]>,
  assetId: string | null,
  at: Date,
): boolean {
  if (!assetId) return false;
  const list = spans.get(assetId);
  if (!list || list.length === 0) return false;
  const t = at.getTime();
  return list.some(
    (w) => w.startedAt.getTime() <= t && (w.endedAt === null || t <= w.endedAt.getTime()),
  );
}

/** Warm the per-tick cache for a known id set in ONE query. A site-wide
 *  outage writes one monitor Event per asset, so the event tail's per-event
 *  assetDetail miss serialized one findUnique per distinct asset — inside the
 *  very tick raising the alerts about that outage. Only rows actually found
 *  are cached: an id the findMany didn't return falls through to assetDetail's
 *  own findUnique, so a genuinely-deleted asset (rare) costs one lookup and
 *  the null-means-deleted contract stays decided by the same read it always
 *  was. */
async function primeAssetDetailCache(assetIds: Iterable<string>): Promise<void> {
  const missing = [...new Set(assetIds)].filter((id) => !_assetDetailCache.has(id));
  if (missing.length === 0) return;
  const rows = await prisma.asset.findMany({ where: { id: { in: missing } }, select: ASSET_DETAIL_SELECT });
  for (const a of rows) _assetDetailCache.set(a.id, { ...a, status: String(a.status) });
}

/**
 * A forecast that takes its levels from another automation
 * (`trigger.levelsFromRuleId`) evaluates with that automation's CURRENT
 * threshold, base severity and bands (`linkForecastLevels`), so editing the
 * memory-utilization automation's percentages moves the forecast with it.
 * Swapped in here, where the tick loads its rules, so every path downstream
 * (the tier ladder, recovery, the band severity) sees an ordinary banded rule.
 * The source is read whether or not it is enabled — a paused memory alert
 * still states the levels. ONE query, and none on an install with no linked
 * forecast. Mutates `rules` in place.
 */
export async function applyLinkedForecastLevels(rules: Array<Pick<DbRule, "trigger" | "severity" | "severityBands">>): Promise<void> {
  const ids = [...new Set(rules.map((r) => forecastLevelsSourceId(r.trigger)).filter((x): x is string => !!x))];
  if (ids.length === 0) return;
  const sources = await prisma.notificationRule.findMany({
    where: { id: { in: ids } },
    select: { id: true, trigger: true, severity: true, severityBands: true },
  });
  const byId = new Map(sources.map((s) => [s.id, s]));
  for (const rule of rules) {
    const id = forecastLevelsSourceId(rule.trigger);
    const src = id ? byId.get(id) : undefined;
    if (!src) continue;
    const linked = linkForecastLevels(
      { trigger: rule.trigger, severity: rule.severity, severityBands: rule.severityBands },
      { trigger: src.trigger, severity: src.severity, severityBands: src.severityBands as unknown as SeverityBand[] | null },
    );
    rule.trigger = linked.trigger as Trigger;
    rule.severity = linked.severity;
    rule.severityBands = linked.severityBands ?? null;
  }
}
