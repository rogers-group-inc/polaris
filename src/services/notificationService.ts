/**
 * src/services/notificationService.ts
 *
 * Read + lifecycle for triggered notifications (the View tab + asset-details
 * tab). Region-scoped listing, batch acknowledge/clear (no per-row awaits),
 * and the per-asset bundle. The engine writes notifications; this module is
 * the operator-facing read/lifecycle side.
 */

import { prisma } from "../db.js";
// A value import (not `import type`): the suppression sweep resets the per-tier
// band runs, a Json column, and that needs Prisma.DbNull at runtime.
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent, logEventsBatch } from "./eventLogService.js";
import { findRulesMatchingAsset } from "./notificationRuleService.js";
import { effectiveFollowUpForSeverity, parseSeverityBands } from "./notificationTypes.js";
import { higherAlertSeverity } from "../utils/alertSeverity.js";

// Both moved to utils/tagNormalize (a leaf) so regionHierarchyService can use
// them without closing an import cycle through this file. Re-exported here
// because several modules already import them from this path.
export { REGION_TAG_PREFIX, stripRegionPrefix } from "../utils/tagNormalize.js";

export interface ListFilters {
  severity?: string[];
  acknowledged?: boolean;
  assetId?: string;
  region?: string[];
  search?: string;
  includeCleared?: boolean;
}

export interface ListParams {
  /** Viewer effective region tags. Empty = unrestricted (see everything). */
  viewerRegionTags: string[];
  filters?: ListFilters;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

const SORTABLE = new Set(["triggeredAt", "severity", "assetHostname", "acknowledged", "message"]);

/**
 * Build the region-scope `where` fragment. A viewer with no region tags is
 * unrestricted. Otherwise they see notifications whose snapshotted regionTags
 * intersect their tags, PLUS unscoped notifications (empty regionTags — system
 * alerts not tied to a region, which can't be region-filtered).
 */
function regionScopeWhere(viewerRegionTags: string[]): Prisma.NotificationWhereInput | undefined {
  if (!viewerRegionTags || viewerRegionTags.length === 0) return undefined;
  return {
    OR: [
      { regionTags: { isEmpty: true } },
      { regionTags: { hasSome: viewerRegionTags } },
    ],
  };
}

/**
 * Include + flatten for the automation's acknowledge-note policy.
 *
 * Every list surface has to know whether acknowledging a row needs a note
 * BEFORE the operator clicks (the modal marks the field required, the phone
 * opens a note sheet instead of one-tapping), so it rides each row as a plain
 * boolean rather than making the client fetch the automation. Rule-less rows
 * — test alerts, and rows whose automation was deleted (ruleId is SetNull) —
 * read false: there is no policy left to enforce, and refusing to let anyone
 * close them out would be worse than a missing note.
 */
const ACK_POLICY_INCLUDE = {
  // severity + severityBands ride along because the policy is per SEVERITY: a
  // band may demand a note the base severity does not (effectiveFollowUp-
  // ForSeverity resolves which). Two small columns on a page of rows, and the
  // alternative — asking the client to fetch the automation and work it out —
  // would put the same resolution in four places (Alerts tab, phone, ack page,
  // push action) and let them disagree.
  rule: { select: { requireAckNote: true, severity: true, severityBands: true } },
} as const;

type RulePolicyRow = { requireAckNote: boolean; severity: string; severityBands: unknown };
type RowWithRulePolicy = { severity: string; rule?: RulePolicyRow | null };

/** The note policy in force for ONE alert, at the severity it is sitting at.
 *  Rule-less rows (test alerts, deleted automations) read false — see the
 *  ACK_POLICY_INCLUDE note. */
export function ackNotePolicyOf(row: RowWithRulePolicy): boolean {
  if (!row.rule) return false;
  return effectiveFollowUpForSeverity(
    { severity: row.rule.severity, severityBands: parseSeverityBands(row.rule.severityBands), requireAckNote: row.rule.requireAckNote },
    row.severity,
  ).requireAckNote;
}

export function withAckPolicy<T extends RowWithRulePolicy>(row: T): Omit<T, "rule"> & { requireAckNote: boolean } {
  const requireAckNote = ackNotePolicyOf(row);
  const { rule, ...rest } = row;
  return { ...rest, requireAckNote };
}

/**
 * Does this batch need a note that wasn't supplied? Pure so the rule can be
 * tested without a database — the count comes from one indexed query.
 *
 * A batch is refused WHOLE rather than partially applied: the route takes one
 * shared note for every id, so "acknowledge the ones that don't need a note"
 * would silently leave the important half of a selection open while reporting
 * success.
 */
export function ackNoteProblem(needyCount: number, batchSize: number, note: string): string | null {
  if (note.trim().length > 0 || needyCount <= 0) return null;
  return needyCount === 1 && batchSize === 1
    ? "This alert's automation requires a note when acknowledging — say what the problem is and what the fix was."
    : `${needyCount} of these alerts come from automations that require a note when acknowledging.`;
}

export async function listNotifications(params: ListParams) {
  const { viewerRegionTags, filters = {}, sortBy = "triggeredAt", sortDir = "desc" } = params;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);

  const and: Prisma.NotificationWhereInput[] = [];
  if (!filters.includeCleared) and.push({ cleared: false });
  if (filters.severity && filters.severity.length > 0) and.push({ severity: { in: filters.severity } });
  if (typeof filters.acknowledged === "boolean") and.push({ acknowledged: filters.acknowledged });
  if (filters.assetId) and.push({ assetId: filters.assetId });
  if (filters.region && filters.region.length > 0) and.push({ regionTags: { hasSome: filters.region } });
  if (filters.search) {
    and.push({
      OR: [
        { message: { contains: filters.search, mode: "insensitive" } },
        { assetHostname: { contains: filters.search, mode: "insensitive" } },
      ],
    });
  }
  const region = regionScopeWhere(viewerRegionTags);
  if (region) and.push(region);

  const where: Prisma.NotificationWhereInput = and.length > 0 ? { AND: and } : {};
  const orderField = SORTABLE.has(sortBy) ? sortBy : "triggeredAt";

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { [orderField]: sortDir === "asc" ? "asc" : "desc" },
      take: limit,
      skip: offset,
      include: ACK_POLICY_INCLUDE,
    }),
    prisma.notification.count({ where }),
  ]);

  return { notifications: rows.map(withAckPolicy), total, limit, offset };
}

/**
 * One alert, for the acknowledge page (public/alert-ack.html).
 *
 * Region-scoped through the SAME predicate the list uses — an operator scoped
 * to a region must not reach an alert by typing its id — and returns null
 * rather than throwing when it misses, so the page can say "this alert isn't
 * here any more" instead of rendering an error. `rule.name` rides along because
 * the page shows what fired, and `requireAckNote` because it decides whether
 * the note field is optional (business rule 25 keeps the ENFORCEMENT in
 * acknowledgeNotifications; this is only what the form asks for).
 */
export async function getNotificationForViewer(
  id: string,
  viewerRegionTags: string[],
): Promise<(Record<string, unknown> & { requireAckNote: boolean }) | null> {
  const region = regionScopeWhere(viewerRegionTags);
  const row = await prisma.notification.findFirst({
    where: region ? { AND: [{ id }, region] } : { id },
    select: {
      id: true,
      message: true,
      severity: true,
      assetId: true,
      assetHostname: true,
      dimension: true,
      metric: true,
      triggeredAt: true,
      testRun: true,
      acknowledged: true,
      acknowledgedBy: true,
      acknowledgedAt: true,
      acknowledgeNote: true,
      cleared: true,
      clearedAt: true,
      // A rule-less alert (a test fire, or one whose automation was deleted —
      // ruleId is SetNull) has no note policy left to enforce.
      rule: { select: { name: true, requireAckNote: true, severity: true, severityBands: true } },
    },
  });
  if (!row) return null;
  const { rule, ...rest } = row;
  return { ...rest, ruleName: rule?.name ?? null, requireAckNote: ackNotePolicyOf(row) };
}

/**
 * Run each alert's automation reset actions before an OPERATOR clear.
 *
 * Lives here rather than in the engine because the engine owns the paths where
 * a condition recovered; this is the human one. Only alerts that are still
 * open and whose rule actually defines reset actions do any work, so the
 * common case is one extra indexed read.
 */
async function runResetActionsForCleared(ids: string[], actor: string): Promise<void> {
  const rows = await prisma.notification.findMany({
    where: { id: { in: ids }, cleared: false, ruleId: { not: null } },
    select: {
      id: true, message: true, severity: true, assetId: true, assetHostname: true,
      rule: { select: { id: true, name: true, scope: true, emailComposition: true, resetActions: true } },
    },
    take: 200,
  });
  const withActions = rows.filter((r) => Array.isArray(r.rule?.resetActions) && (r.rule!.resetActions as unknown[]).length > 0);
  if (withActions.length === 0) return;

  // Imported lazily: notificationService is imported BY the recipient service
  // (stripRegionPrefix), so a top-level import here would close the cycle.
  const [{ executeActions }, { buildTemplateContext, setRecoverySentence }, { scopeRegionTagsOf }] = await Promise.all([
    import("./automationActionService.js"),
    import("../utils/notificationTemplate.js"),
    import("./notificationRecipientService.js"),
  ]);

  for (const n of withActions) {
    const rule = n.rule!;
    const ctx = buildTemplateContext({
      asset: n.assetHostname ?? "",
      severity: "resolved",
      time: new Date(),
      ruleName: rule.name,
    });
    // Headline AND {message}: this context has no reading behind it, so without
    // the headline the email would state the severity and the hostname and
    // nothing about what happened.
    setRecoverySentence(ctx, `Resolved: ${rule.name} — ${n.assetHostname ?? "alert"} cleared by ${actor}`);
    await executeActions(n.id, rule.resetActions as never, ctx, {
      scopeRegionTags: scopeRegionTagsOf(rule.scope as never),
      assetId: n.assetId,
      ruleId: rule.id,
      ruleName: rule.name,
      ruleEmailComposition: (rule.emailComposition ?? null) as never,
      actor,
    }).catch(() => { /* one bad alert must not stop the rest of the batch */ });
  }
}

/** How an acknowledgement reached us — audit detail only, never a gate. */
export type AckSource = "ui" | "ack_page" | "web_push_action";

/**
 * Acknowledge a batch of notifications, stamping a shared optional note.
 * Skips rows already acknowledged. One updateMany; one audit Event.
 *
 * `acknowledgedBy` stays the plain actor string the Alerts surfaces render;
 * provenance rides the Event's details instead, so an emailed one-click
 * acknowledgement is distinguishable in the audit log without changing what
 * every existing reader of the column sees.
 */
export async function acknowledgeNotifications(
  ids: string[],
  actor: string,
  note?: string,
  opts?: { source?: AckSource },
): Promise<number> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError(400, "No notification ids provided");
  }
  const trimmed = (note ?? "").trim();
  // The note policy lives on the automation, so it has to be enforced HERE
  // rather than in the modal: this one function backs the Alerts tab, the
  // mobile list, the emailed one-click link and the web-push action button,
  // and three of those four can acknowledge without ever rendering a form.
  // One query, and only when no note was given. It FETCHES rather than counts
  // because the policy is per severity now (ackNotePolicyOf): "does this rule
  // demand a note" is a JSON question about the band the alert is sitting in,
  // which no SQL predicate on the rule row can answer. Bounded by the ids the
  // operator selected — not by fleet size — and it reads three small columns.
  if (trimmed.length === 0) {
    const candidates = await prisma.notification.findMany({
      where: { id: { in: ids }, acknowledged: false },
      select: { severity: true, rule: { select: { requireAckNote: true, severity: true, severityBands: true } } },
    });
    const needy = candidates.filter(ackNotePolicyOf).length;
    const problem = ackNoteProblem(needy, ids.length, trimmed);
    if (problem) throw new AppError(400, problem);
  }
  const res = await prisma.notification.updateMany({
    where: { id: { in: ids }, acknowledged: false },
    data: {
      acknowledged: true,
      acknowledgedBy: actor,
      acknowledgedAt: new Date(),
      acknowledgeNote: trimmed.length > 0 ? trimmed : null,
    },
  });
  await logEvent({
    action: "notification.acknowledged",
    resourceType: "notification",
    actor,
    message: `Acknowledged ${res.count} notification${res.count === 1 ? "" : "s"}`,
    details: { ids, count: res.count, hasNote: trimmed.length > 0, source: opts?.source ?? "ui" },
  });
  return res.count;
}

/** Soft-clear a batch (cleared=true → filtered from the default list). */
export async function clearNotifications(ids: string[], actor: string): Promise<number> {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new AppError(400, "No notification ids provided");
  }
  // An operator clearing an alert IS the alert ending, so the automation's
  // reset actions run — the recovery message names who ended it, since "it
  // recovered" and "someone closed it out" are different facts. Best-effort
  // and before the write, so the actions' deliveries attach to a live
  // notification; a failure here must never block the clear.
  await runResetActionsForCleared(ids, actor).catch(() => {});
  const res = await prisma.notification.updateMany({
    where: { id: { in: ids }, cleared: false },
    data: { cleared: true, clearedBy: actor, clearedAt: new Date() },
  });
  await logEvent({
    action: "notification.cleared",
    resourceType: "notification",
    actor,
    message: `Cleared ${res.count} notification${res.count === 1 ? "" : "s"}`,
    details: { ids, count: res.count },
  });
  return res.count;
}

/** Alerts retired by one suppression sweep. A window opening on a large
 *  schedule can only ever clear as many alerts as were already firing, so this
 *  is a runaway guard rather than a real bound; the remainder is picked up by
 *  the next 60s pass. */
const SUPPRESSION_SWEEP_CAP = 2000;

/** Why an asset's alerts are being retired — the two halves of
 *  `isSuppressedForNotifications` (business rule 16). Maintenance wins when an
 *  asset is both: it is the announced downtime the operator is looking at. */
const SUPPRESSION_CLEARED_BY = {
  maintenance: "system:maintenance",
  dependency: "system:dependency-suppressed",
} as const;

/**
 * Retire every ACTIVE alert whose asset is currently suppressed — inside a
 * maintenance window, or dependency-suppressed behind a dark parent
 * (business rule 16).
 *
 * The engine already refuses to FIRE about a suppressed asset
 * (`assetCanTrigger`), but an alert raised BEFORE the window opened was left
 * frozen: announced downtime with a live red row beside it for the whole
 * window, and nothing able to clear it, because the readings that would
 * recover it are exactly what maintenance stops collecting. Entering
 * suppression therefore ends the alert instead of freezing it.
 *
 * Handoff semantics, not recovery — the same contract the precedence carve-out
 * and the packet-loss/device-down handoff already use:
 *  - the alert is SOFT-cleared (history preserved, ack state intact);
 *  - its `NotificationRuleState` row is reset, so a condition still bad when
 *    the window closes re-earns its full debounce and fires as a NEW alert
 *    rather than resurrecting a stale one;
 *  - NO reset actions run. Nothing recovered, and mailing "resolved" about a
 *    device nobody is currently polling would be a lie.
 *
 * It is a sweep over Notification rows rather than a branch in the engine's
 * per-rule loops because **event and change alerts carry no state row at all**
 * (the event tail `createMany`s notifications directly), so a state-machine-side
 * clear would silently miss exactly the automations most likely to have fired
 * on the way into a maintenance window.
 *
 * `assetIds` scopes the sweep to the assets that just entered a window — the
 * maintenance scheduler's own call, so an ad-hoc "enter maintenance now"
 * clears the board immediately instead of a tick later. Unscoped it is the
 * 60s safety net, which is also what catches dependency suppression (owned by
 * the dependency reconciler, which has no edge of its own here).
 */
export async function clearSuppressedAlerts(assetIds?: string[]): Promise<number> {
  if (assetIds && assetIds.length === 0) return 0;
  const open = await prisma.notification.findMany({
    where: {
      cleared: false,
      // A system-scoped alert (capacity, backups) has no asset and can't be
      // suppressed by one.
      assetId: assetIds ? { in: assetIds } : { not: null },
    },
    select: { id: true, assetId: true, rule: { select: { name: true } } },
    take: SUPPRESSION_SWEEP_CAP,
  });
  if (open.length === 0) return 0;

  const suppressed = await prisma.asset.findMany({
    where: {
      id: { in: Array.from(new Set(open.map((n) => n.assetId as string))) },
      OR: [{ status: "maintenance" }, { dependencySuppressed: true }],
    },
    select: { id: true, hostname: true, status: true, dependencySuppressed: true },
  });
  if (suppressed.length === 0) return 0;

  const reasonById = new Map<string, keyof typeof SUPPRESSION_CLEARED_BY>(
    suppressed.map((a) => [a.id, a.status === "maintenance" ? "maintenance" : "dependency"] as const),
  );
  const nameById = new Map(suppressed.map((a) => [a.id, a.hostname ?? a.id]));

  const idsByReason = new Map<keyof typeof SUPPRESSION_CLEARED_BY, string[]>();
  const events: Parameters<typeof logEventsBatch>[0] = [];
  for (const n of open) {
    const reason = reasonById.get(n.assetId as string);
    if (!reason) continue;
    const list = idsByReason.get(reason);
    if (list) list.push(n.id);
    else idsByReason.set(reason, [n.id]);
    const hostname = nameById.get(n.assetId as string) ?? n.assetId;
    events.push({
      action: "notification.suppressed",
      resourceType: "notification",
      resourceId: n.id,
      resourceName: n.rule?.name ?? "alert",
      actor: "system:notification-engine",
      message: reason === "maintenance"
        ? `Cleared: ${n.rule?.name ?? "alert"} — ${hostname} entered a maintenance window`
        : `Cleared: ${n.rule?.name ?? "alert"} — ${hostname} is suppressed behind a parent that is down`,
      details: { assetId: n.assetId, reason },
    });
  }
  if (events.length === 0) return 0;

  const cleared = Array.from(idsByReason.values()).flat();
  const now = new Date();
  await prisma.$transaction([
    ...Array.from(idsByReason.entries()).map(([reason, ids]) =>
      prisma.notification.updateMany({
        where: { id: { in: ids }, cleared: false },
        data: { cleared: true, clearedBy: SUPPRESSION_CLEARED_BY[reason], clearedAt: now },
      }),
    ),
    // The state machine has to let go of the alert it just lost, or the key
    // sits `firing` with a dangling notificationId and can never fire again.
    prisma.notificationRuleState.updateMany({
      where: { notificationId: { in: cleared } },
      data: {
        state: "clear",
        conditionMetSince: null,
        recoveredSince: null,
        notificationId: null,
        bandMetSince: Prisma.DbNull,
      },
    }),
  ]);
  await logEventsBatch(events);
  return cleared.length;
}

/** How long a wizard "Test delivery" alert stays on the board before it
 *  retires itself. An hour is long enough to open the email, follow its
 *  Acknowledge link and see the row it points at, and short enough that a
 *  test is gone by the next time anyone looks at the device. */
export const TEST_ALERT_TTL_MS = 60 * 60 * 1000;

/**
 * Retire wizard test alerts older than an hour.
 *
 * A test fire is a REAL Notification row — that is what makes the delivery
 * path, the email body and the acknowledge link testable at all — so it lands
 * on the asset-details Alerts tab, in the View list and in every active-alert
 * count exactly like a fire that meant something. But nothing can ever clear
 * it: it carries `ruleId: null` by design (automationTestService, safety
 * property 1), so it sits outside every recovery path Polaris has — no state
 * row for the engine to release, no rule for `runEventRuleTimedClear` to
 * sweep, no condition that could recover. Testing one automation therefore
 * left a permanent alert on whichever device the wizard happened to pick, and
 * the only way to remove it was for an operator to recognize it as a test and
 * clear it by hand.
 *
 * So the clear is a TTL rather than a reset: nothing recovered, so no reset
 * actions run (there is no rule to define any) and no state row is touched (a
 * test never wrote one). Soft-clear keeps the history and the ack state, so an
 * acknowledge link in an old test email still resolves — the page just reports
 * the alert as closed.
 *
 * One indexed `updateMany` per tick, independent of fleet size.
 */
export async function clearExpiredTestAlerts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TEST_ALERT_TTL_MS);
  const res = await prisma.notification.updateMany({
    where: { testRun: true, cleared: false, triggeredAt: { lte: cutoff } },
    data: { cleared: true, clearedBy: "system:test-expired", clearedAt: now },
  });
  if (res.count > 0) {
    // One summary line per sweep rather than one per row: the fire itself was
    // already audited as automation.test_delivery, and this is its bookend.
    await logEvent({
      action: "notification.auto_cleared",
      resourceType: "notification",
      actor: "system:notification-engine",
      message: `Cleared ${res.count} expired test alert${res.count === 1 ? "" : "s"}`,
      details: { count: res.count, reason: "test_expired", ttlMs: TEST_ALERT_TTL_MS },
    }).catch(() => {});
  }
  return res.count;
}

export interface AssetActiveAlertSummary {
  /** The most severe active alert's severity — what the indicator is coloured by. */
  severity: string;
  /** Every uncleared alert on the asset, acknowledged ones included. */
  count: number;
  /** How many of those nobody has taken yet. Zero = the indicator stops asking. */
  unacknowledged: number;
}

/**
 * "Does this device have an active alert, and how bad is the worst one?" for a
 * page of assets — the assets list's per-row indicator.
 *
 * ONE indexed findMany over the uncleared notifications for the ids on screen
 * (covered by @@index([assetId]) + [cleared, ...]), reduced in JS. Deliberately
 * not a per-row count: the list ships up to 10 000 rows on the export path, and
 * a query per row is the shape that makes a page of assets cost a page of
 * queries.
 *
 * Two things it deliberately does NOT do. It applies no automation-relevance
 * filter — unlike the NOC widgets, whose pills answer "is there an alert about
 * the thing THIS panel measures", the list's indicator answers "is anything
 * wrong with this device", so every uncleared alert counts. And it applies no
 * region scope: the assets list itself is unscoped, so scoping only the
 * indicator would mark a row quiet that the operator can open and find noisy.
 *
 * `unacknowledged` rides along because it decides whether the indicator strobes
 * or sits still. An acknowledged alert is still active and still shown — it has
 * simply stopped needing to catch an eye.
 */
export async function activeAlertSummaryByAsset(
  assetIds: string[],
): Promise<Map<string, AssetActiveAlertSummary>> {
  const out = new Map<string, AssetActiveAlertSummary>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.notification.findMany({
    where: { assetId: { in: assetIds }, cleared: false },
    select: { assetId: true, severity: true, acknowledged: true },
  });
  for (const r of rows) {
    if (!r.assetId) continue;
    const cur = out.get(r.assetId);
    if (!cur) {
      out.set(r.assetId, {
        severity: r.severity,
        count: 1,
        unacknowledged: r.acknowledged ? 0 : 1,
      });
      continue;
    }
    cur.count += 1;
    if (!r.acknowledged) cur.unacknowledged += 1;
    cur.severity = higherAlertSeverity(cur.severity, r.severity) ?? cur.severity;
  }
  return out;
}

/**
 * The asset-details Notifications tab bundle: active (non-cleared)
 * notifications for the asset + the enabled rules whose scope matches it.
 */
export async function getAssetNotifications(assetId: string) {
  const [active, matchingRules] = await Promise.all([
    prisma.notification.findMany({
      where: { assetId, cleared: false },
      orderBy: { triggeredAt: "desc" },
      take: 200,
      include: ACK_POLICY_INCLUDE,
    }),
    findRulesMatchingAsset(assetId),
  ]);
  return { active: active.map(withAckPolicy), matchingRules };
}
