/**
 * src/services/quietTimeSummaryService.ts
 *
 * The summary that ends a quiet window (business rule 92). A quiet window
 * HOLDS the people-facing sends of the alerts it covers; this service is what
 * makes that a hold rather than a drop: once the window ends it tells every
 * reader who would have been told, in one email each, what is still broken.
 *
 * ── Two phases, both driven by the sendQuietTimeSummaries job (60 s) ───────
 *
 * CREATE (`createDueSummaries`). Held alerts still owing a summary
 * (`quietHeldAt` set, `quietSummarizedAt` null — the partial index) are
 * grouped by the source that held them. A source is DUE when the quiet
 * stretch containing its earliest held alert has ended, the policy's send time
 * (if any) has arrived, and the source is not quiet again right now — an
 * alert held at 02:00 by a 22:00–06:00 window with a 07:30 send time is
 * summarised at 07:30; if a 07:00–08:00 window had opened first, it folds
 * into THAT window's summary. For a due source one `QuietTimeSummary` row is
 * written and every held alert of the source is stamped `quietSummarizedAt`
 * in the same transaction — covered, whether or not the email names it.
 *
 * What the row says (`details`), decided once, at creation:
 *   - OUTSTANDING: the held alerts still uncleared now. A recovered alert is
 *     not listed — "an interface went down and came back" is not news at
 *     07:30 — UNLESS it recurred:
 *   - RECURRING: the same (automation, device, component) fired MORE THAN the
 *     policy's threshold times during the window. Listed with the count and
 *     every fire time, recovered or not, and not repeated under OUTSTANDING.
 *
 * Who gets it: the HELD delivery rows of the listed alerts, which are the
 * resolver's own answer to "who was this alert for" — an email row's To line
 * and Cc, a web-push row's account (reached by its email; a push preference
 * is deliberately ignored, there is no summary push). Chat rows reach no
 * person. Deduplicated by lower-cased address. A reader with no address on
 * their account is skipped with one warning Event.
 *
 * Through which channel: the policy's `summaryChannelId`, else the first
 * email channel among the held rows' own channels, else the first enabled
 * email channel in the install. None at all → the row is `unroutable` and a
 * warning Event says so; the alerts stay visible on the Active Alerts page.
 *
 * SEND (`drainPendingSummaries`). Each pending recipient gets the email
 * rendered in THEIR zone (`resolveTimeZone`: explicit → detected → install;
 * the install's zone for an address with no account) — this is the per-reader
 * digest `userTimezoneService` reserved that resolver for, and the one place
 * alert mail renders in anything but the install's zone (rule 25 is about ONE
 * message to one To line; a summary is one message PER reader). Up to
 * SUMMARY_MAX_ATTEMPTS per recipient across ticks; a row rolls up to `sent`,
 * `partial` (retrying) or `failed`, with one Event at the end.
 *
 * Scale: one indexed query per tick for the held set (bounded by a night's
 * alerts, not the fleet), one query per due source for its rows, one for its
 * users, and chunked sends. No per-row awaits in a loop over the fleet.
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { logEvent } from "./eventLogService.js";
import {
  isQuietNow,
  quietResumesAt,
  summarySendAt,
  quietSummaryAlways,
  quietHoldsFires,
  quietHoldsSend,
  quietHoldsKind,
  lastQuietStretch,
  type QuietTimeConfig,
} from "../utils/quietTime.js";
import { quietSourceConfig, parseQuietTimeConfig, type QuietSourceKind } from "./quietTimeHoldService.js";
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";
import { applyBrandLetterhead, sendEmailThroughChannel } from "./notificationDeliveryService.js";
import {
  resolveAllUsers,
  resolveUsersInAnyRegion,
  resolveUsersByRegions,
  resolveUsersByRoles,
  resolveRecipientUsersByIds,
  resolveRecipientUsers,
  scopeRegionTagsOf,
} from "./notificationRecipientService.js";
import { CHANNEL_TRANSPORT, allRuleActionRefs, scopeForTrigger, type ChannelType, type RuleActionCarrier, type RuleScope } from "./notificationTypes.js";
import { loadScopeRegionSnapshots } from "./notificationEngine.js";
import { regionLevelIndex, deviceRegionsAtLevels, type RegionLevelIndex } from "./regionHierarchyService.js";
import { isIgnoreGlobalQuietTime } from "../utils/quietTime.js";

function isChannelType(t: string): t is ChannelType {
  return Object.prototype.hasOwnProperty.call(CHANNEL_TRANSPORT, t);
}
import {
  renderQuietSummaryEmail,
  type SummaryOutstandingRow,
  type SummaryRecurringRow,
} from "../utils/quietSummaryEmailTemplate.js";

/** Per-recipient attempts across the job's 60 s ticks — ten minutes of
 *  retrying, not the drain's three: a summary is one email a night, and an
 *  SMTP host that is down for three minutes at 06:00 must not cost it. A row
 *  that still fails can be re-sent by hand (`resendSummary`). */
export const SUMMARY_MAX_ATTEMPTS = 10;
const SEND_CONCURRENCY = 4;
/** Held alerts read per tick. A night on a 2000-asset fleet is far below it;
 *  the cap only bounds a pathological storm, and the rest follows next tick. */
const HELD_BATCH = 5000;

export interface SummaryRecipient {
  address: string;
  userId?: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  error?: string;
}

interface SummaryDetails {
  outstanding: SummaryOutstandingRow[];
  recurring: SummaryRecurringRow[];
  recurrenceThreshold: number | null;
  /** The all-quiet email (`summaryAlways`): nothing listed; `heldCount` alerts
   *  fired and recovered during the stretch, 0 = none were held at all. */
  allQuiet?: boolean;
  heldCount?: number;
}

type HeldRow = Prisma.NotificationGetPayload<{ select: typeof HELD_SELECT }>;

const HELD_SELECT = {
  id: true, ruleId: true, assetId: true, assetHostname: true, severity: true, message: true,
  dimension: true, metric: true, triggeredAt: true, cleared: true, quietHeldAt: true, quietSource: true,
  rule: { select: { name: true } },
} as const;

interface SourceStamp { kind: QuietSourceKind; id: string; name?: string }

function readSource(raw: unknown): SourceStamp | null {
  const s = raw as Partial<SourceStamp> | null | undefined;
  if (!s || (s.kind !== "automation" && s.kind !== "global") || typeof s.id !== "string") return null;
  return { kind: s.kind, id: s.id, ...(typeof s.name === "string" ? { name: s.name } : {}) };
}

/**
 * Is this source's summary due, and what range does it cover? Pure, exported
 * for the tests. `config` null = the source is gone: flush now, covering up to
 * `now`.
 */
export function summaryDue(
  config: QuietTimeConfig | null,
  firstHeldAt: Date,
  now: Date,
): { due: boolean; coveredTo: Date } {
  if (!config) return { due: true, coveredTo: now };
  // The end of the quiet stretch the first hold fell in. A hold that no longer
  // sits inside a window (the policy was edited) counts as ended at the hold.
  const windowEnd = quietResumesAt(config, firstHeldAt) ?? firstHeldAt;
  const sendAt = summarySendAt(config, windowEnd);
  if (now.getTime() < sendAt.getTime()) return { due: false, coveredTo: windowEnd };
  // Quiet again already (a second window opened before the send time): fold
  // these alerts into that window's summary rather than mailing mid-silence.
  if (isQuietNow(config, now)) return { due: false, coveredTo: windowEnd };
  return { due: true, coveredTo: windowEnd };
}

/**
 * What the summary says, from the held alerts. Pure, exported for the tests:
 * the outstanding / recurring split is the whole product decision here.
 */
export function buildSummaryDetails(
  alerts: Array<{
    id: string; ruleId: string | null; assetId: string | null; assetHostname: string | null; severity: string;
    message: string; dimension: string | null; triggeredAt: Date; cleared: boolean; rule?: { name: string } | null;
  }>,
  recurrenceThreshold: number | null,
): SummaryDetails {
  const byKey = new Map<string, typeof alerts>();
  for (const a of alerts) {
    const key = `${a.ruleId ?? ""}|${a.assetId ?? ""}|${a.dimension ?? ""}`;
    const list = byKey.get(key) ?? [];
    list.push(a);
    byKey.set(key, list);
  }
  const recurring: SummaryRecurringRow[] = [];
  const recurringIds = new Set<string>();
  if (recurrenceThreshold != null && recurrenceThreshold > 0) {
    for (const list of byKey.values()) {
      if (list.length <= recurrenceThreshold) continue;
      const sorted = list.slice().sort((x, y) => x.triggeredAt.getTime() - y.triggeredAt.getTime());
      const latest = sorted[sorted.length - 1]!;
      for (const a of sorted) recurringIds.add(a.id);
      recurring.push({
        assetId: latest.assetId,
        assetHostname: latest.assetHostname,
        ruleName: latest.rule?.name ?? null,
        dimension: latest.dimension,
        severity: latest.severity,
        count: sorted.length,
        times: sorted.map((a) => a.triggeredAt.toISOString()),
        stillActive: sorted.some((a) => !a.cleared),
      });
    }
  }
  const outstanding: SummaryOutstandingRow[] = alerts
    .filter((a) => !a.cleared && !recurringIds.has(a.id))
    .sort((x, y) => x.triggeredAt.getTime() - y.triggeredAt.getTime())
    .map((a) => ({
      notificationId: a.id,
      severity: a.severity,
      assetId: a.assetId,
      assetHostname: a.assetHostname,
      ruleName: a.rule?.name ?? null,
      message: a.message,
      dimension: a.dimension,
      triggeredAt: a.triggeredAt.toISOString(),
    }));
  recurring.sort((x, y) => y.count - x.count);
  return { outstanding, recurring, recurrenceThreshold };
}

/** Addresses (lower-cased, deduped) + push accounts from a set of held rows. Pure. */
export function recipientsFromHeldRows(
  rows: Array<{ transport: string; target: string; meta: unknown }>,
): { addresses: string[]; userIds: string[] } {
  const addresses = new Set<string>();
  const userIds = new Set<string>();
  for (const r of rows) {
    const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
    if (r.transport === "email") {
      for (const a of r.target.split(",")) {
        const t = a.trim().toLowerCase();
        if (t) addresses.add(t);
      }
      for (const a of Array.isArray(meta.cc) ? meta.cc : []) {
        if (typeof a === "string" && a.trim()) addresses.add(a.trim().toLowerCase());
      }
    } else if (r.transport === "web_push") {
      if (typeof meta.userId === "string" && meta.userId) userIds.add(meta.userId);
    }
  }
  return { addresses: Array.from(addresses), userIds: Array.from(userIds) };
}

interface EmailChannelRow { id: string; type: string; enabled: boolean; config: unknown }

function isEmailChannel(c: { type: string; enabled: boolean }): boolean {
  return c.enabled && isChannelType(c.type) && CHANNEL_TRANSPORT[c.type as ChannelType] === "email";
}

/**
 * The email channel a source's summaries go through — see the module header
 * for the three-step fallback. Null when the install has no usable one.
 */
export async function resolveSummaryChannel(
  preferredId: string | null | undefined,
  heldChannelIds: Array<string | null>,
): Promise<EmailChannelRow | null> {
  const wanted = [preferredId, ...heldChannelIds].filter((x): x is string => !!x);
  if (wanted.length > 0) {
    const rows = await prisma.notificationChannel.findMany({
      where: { id: { in: Array.from(new Set(wanted)) } },
      select: { id: true, type: true, enabled: true, config: true },
    });
    for (const id of wanted) {
      const c = rows.find((r) => r.id === id);
      if (c && isEmailChannel(c)) return c;
    }
  }
  const any = await prisma.notificationChannel.findMany({
    where: { enabled: true, type: { in: ["smtp", "oauth_m365"] } },
    select: { id: true, type: true, enabled: true, config: true },
    orderBy: { createdAt: "asc" },
    take: 1,
  });
  return any[0] ?? null;
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export async function createDueSummaries(now: Date = new Date()): Promise<number> {
  const held: HeldRow[] = await prisma.notification.findMany({
    where: { quietHeldAt: { not: null }, quietSummarizedAt: null },
    select: HELD_SELECT,
    orderBy: { quietHeldAt: "asc" },
    take: HELD_BATCH,
  });

  const bySource = new Map<string, { source: SourceStamp; alerts: HeldRow[] }>();
  for (const h of held) {
    const source = readSource(h.quietSource);
    if (!source) {
      // A stamp nothing can read must not pin the alert in "owes a summary"
      // forever; it is covered by nobody and said so.
      logger.warn({ notificationId: h.id }, "held alert carries no readable quiet source — marking it summarised");
      await prisma.notification.update({ where: { id: h.id }, data: { quietSummarizedAt: now } });
      continue;
    }
    const key = `${source.kind}:${source.id}`;
    const g = bySource.get(key) ?? { source, alerts: [] };
    g.alerts.push(h);
    bySource.set(key, g);
  }

  let created = 0;
  for (const { source, alerts } of bySource.values()) {
    const found = await quietSourceConfig(source);
    const config = found?.config ?? null;
    const name = found?.name ?? source.name ?? (source.kind === "global" ? "a deleted global quiet time" : "a deleted automation");
    const firstHeld = alerts.reduce((m, a) => (a.quietHeldAt && a.quietHeldAt < m ? a.quietHeldAt : m), alerts[0]!.quietHeldAt!);
    const { due, coveredTo } = summaryDue(config, firstHeld, now);
    if (!due) continue;

    // Only alerts held up to NOW — a hold stamped a moment after the read
    // belongs to the next summary (the window it fell in is still open).
    const covered = alerts.filter((a) => a.quietHeldAt && a.quietHeldAt.getTime() <= now.getTime());
    if (covered.length === 0) continue;
    const details = buildSummaryDetails(covered, config?.recurrenceThreshold ?? null);
    const listedIds = [
      ...details.outstanding.map((o) => o.notificationId),
      // Recurring rows carry no ids of their own; their members are every
      // covered alert sharing the key, resolved below for the recipient read.
    ];
    const recurringKeys = new Set(details.recurring.map((r) => `${covered.find((c) => c.assetId === r.assetId && c.dimension === r.dimension && (c.rule?.name ?? null) === r.ruleName)?.ruleId ?? ""}|${r.assetId ?? ""}|${r.dimension ?? ""}`));
    for (const c of covered) {
      if (recurringKeys.has(`${c.ruleId ?? ""}|${c.assetId ?? ""}|${c.dimension ?? ""}`)) listedIds.push(c.id);
    }

    let recipients: SummaryRecipient[] = [];
    let channel: EmailChannelRow | null = null;
    let status = "pending";
    // Nothing to list: everything recovered under the threshold. With
    // `summaryAlways` (the default) that is still an email — the all-quiet
    // one, to everyone the covered alerts would have reached — because its
    // arriving is the point. Turned off, the row is written and nobody mailed.
    const allQuiet = listedIds.length === 0;
    if (allQuiet) {
      details.allQuiet = true;
      details.heldCount = covered.length;
    }
    if (allQuiet && !(config && quietSummaryAlways(config))) {
      status = "empty";
    } else {
      const heldRows = await prisma.notificationDelivery.findMany({
        where: { notificationId: { in: allQuiet ? covered.map((c) => c.id) : listedIds }, status: "held" },
        select: { transport: true, target: true, meta: true, channelId: true },
      });
      const { addresses, userIds } = recipientsFromHeldRows(heldRows);
      channel = await resolveSummaryChannel(config?.summaryChannelId, heldRows.map((r) => r.channelId));
      recipients = await resolveRecipients(addresses, userIds, name);
      if (!channel) {
        status = "unroutable";
        await logEvent({
          action: "quiet_time.summary_unroutable",
          resourceType: source.kind === "global" ? "quiet-time-schedule" : "notification-rule",
          resourceId: source.id,
          resourceName: name,
          actor: "system:quiet-time",
          level: "warning",
          message: `Quiet-time summary for "${name}" could not be sent: no enabled email channel. ${listedIds.length} alert(s) are still on the Active Alerts page.`,
          details: { alerts: listedIds.length, recipients: recipients.length },
        }).catch(() => {});
      } else if (recipients.length === 0) {
        status = "empty";
      }
    }

    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.quietTimeSummary.create({
        data: {
          sourceKind: source.kind,
          sourceId: source.id,
          sourceName: name,
          coveredFrom: firstHeld,
          coveredTo,
          notificationIds: covered.map((c) => c.id),
          listedCount: details.outstanding.length,
          recurringCount: details.recurring.length,
          details: details as unknown as Prisma.InputJsonValue,
          recipients: recipients as unknown as Prisma.InputJsonValue,
          channelId: channel?.id ?? null,
          status,
          ...(status === "empty" ? { sentAt: now } : {}),
        },
        select: { id: true },
      });
      await tx.notification.updateMany({
        where: { id: { in: covered.map((c) => c.id) }, quietSummarizedAt: null },
        data: { quietSummarizedAt: now },
      });
      return r;
    });
    created++;
    logger.info(
      { summaryId: row.id, source: `${source.kind}:${source.id}`, alerts: covered.length, outstanding: details.outstanding.length, recurring: details.recurring.length, recipients: recipients.length, status },
      "quiet-time summary created",
    );
  }
  created += await createAllQuietSummaries(now, new Set(bySource.keys()));
  return created;
}

// ─── THE ALL-QUIET SUMMARY ───────────────────────────────────────────────────
//
// A quiet stretch nothing was held in has no held alert to anchor a summary
// on, so nothing above ever fires for it — and the operator wants the email
// anyway: "nothing happened overnight, and the fact you are reading this
// means the quiet time and email are working". This pass walks every enabled
// source whose policy holds first alerts somewhere and has `summaryAlways`
// (the default), finds the stretch that most recently ENDED
// (`lastQuietStretch`), and when its send time has arrived writes an all-quiet
// row once per stretch. Recipients are derived from the automations the
// source covers: the static recipients of their notify actions (named users,
// typed addresses, roles, tags, regions, scope-region users), plus device-
// region routing (`recipientDeviceRegion` and its levels) resolved against
// every region the rule's monitored in-scope devices carry — the people it
// could page from any of them. A device's address-book contacts are outside
// contacts tied to that one device, not a standing audience, and stay out.

interface SourceRow {
  kind: QuietSourceKind;
  id: string;
  name: string;
  config: QuietTimeConfig;
  /** The last edit — a stretch that ended before it is not this policy's to report. */
  since: Date;
}

const RULE_RECIPIENT_SELECT = {
  id: true, name: true, enabled: true, severity: true, trigger: true, scope: true, quietTime: true, updatedAt: true,
  actions: true, escalation: true, severityBands: true, bandNotify: true, resetActions: true,
} as const;
type RuleRecipientRow = Prisma.NotificationRuleGetPayload<{ select: typeof RULE_RECIPIENT_SELECT }>;

async function createAllQuietSummaries(now: Date, handled: Set<string>): Promise<number> {
  const [schedules, rules] = await Promise.all([
    prisma.quietTimeSchedule.findMany({
      where: { enabled: true },
      select: { id: true, name: true, enabled: true, quiet: true, updatedAt: true },
    }),
    prisma.notificationRule.findMany({ where: { enabled: true }, select: RULE_RECIPIENT_SELECT }),
  ]);
  const sources: SourceRow[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const config = parseQuietTimeConfig(s.quiet);
    if (config) sources.push({ kind: "global", id: s.id, name: s.name, config, since: s.updatedAt });
  }
  for (const r of rules) {
    if (!r.enabled || r.quietTime == null || isIgnoreGlobalQuietTime(r.quietTime)) continue;
    const config = parseQuietTimeConfig(r.quietTime);
    if (config) sources.push({ kind: "automation", id: r.id, name: r.name, config, since: r.updatedAt });
  }

  let created = 0;
  for (const src of sources) {
    if (handled.has(`${src.kind}:${src.id}`)) continue;
    if (!quietSummaryAlways(src.config) || !quietHoldsFires(src.config)) continue;
    const stretch = lastQuietStretch(src.config, now);
    if (!stretch) continue;
    if (stretch.end.getTime() < src.since.getTime()) continue;
    if (now.getTime() < summarySendAt(src.config, stretch.end).getTime()) continue;
    const already = await prisma.quietTimeSummary.findFirst({
      where: { sourceKind: src.kind, sourceId: src.id, coveredTo: { gte: stretch.end } },
      select: { id: true },
    });
    if (already) continue;

    const covered = src.kind === "automation"
      ? rules.filter((r) => r.id === src.id)
      : rules.filter((r) => r.enabled && r.quietTime == null && ruleCoveredByGlobal(r, src.config));
    const { addresses, userIds } = await staticRecipientsOfRules(covered);
    const recipients = await resolveRecipients(addresses, userIds, src.name);
    const channel = await resolveSummaryChannel(src.config.summaryChannelId, []);
    const details: SummaryDetails = { outstanding: [], recurring: [], recurrenceThreshold: src.config.recurrenceThreshold ?? null, allQuiet: true, heldCount: 0 };
    let status = "pending";
    if (!channel) {
      status = "unroutable";
      await logEvent({
        action: "quiet_time.summary_unroutable",
        resourceType: src.kind === "global" ? "quiet-time-schedule" : "notification-rule",
        resourceId: src.id,
        resourceName: src.name,
        actor: "system:quiet-time",
        level: "warning",
        message: `All-quiet summary for "${src.name}" could not be sent: no enabled email channel.`,
        details: { recipients: recipients.length },
      }).catch(() => {});
    } else if (recipients.length === 0) {
      status = "empty";
    }
    const row = await prisma.quietTimeSummary.create({
      data: {
        sourceKind: src.kind,
        sourceId: src.id,
        sourceName: src.name,
        coveredFrom: stretch.start,
        coveredTo: stretch.end,
        notificationIds: [],
        listedCount: 0,
        recurringCount: 0,
        details: details as unknown as Prisma.InputJsonValue,
        recipients: recipients as unknown as Prisma.InputJsonValue,
        channelId: channel?.id ?? null,
        status,
        ...(status === "empty" ? { sentAt: now } : {}),
      },
      select: { id: true },
    });
    created++;
    logger.info({ summaryId: row.id, source: `${src.kind}:${src.id}`, recipients: recipients.length, status }, "all-quiet summary created");
  }
  return created;
}

/** Does a global policy cover this automation at all — any severity the rule
 *  can produce whose first alert it holds, and the rule's kind of alert? */
function ruleCoveredByGlobal(rule: RuleRecipientRow, config: QuietTimeConfig): boolean {
  const bands = Array.isArray(rule.severityBands) ? (rule.severityBands as Array<{ severity?: string }>) : [];
  const severities = [rule.severity, ...bands.map((b) => b.severity).filter((s): s is string => typeof s === "string")];
  if (!severities.some((s) => quietHoldsSend(config, s, "fire"))) return false;
  const trig = (rule.trigger && typeof rule.trigger === "object" ? rule.trigger : {}) as { metric?: string; field?: string };
  return quietHoldsKind(config, trig.metric ?? trig.field ?? null);
}

/** The static recipients of every notify action on these rules: addresses and
 *  account ids, deduped. Device-region routing reads the scope's regions;
 *  asset contacts are skipped (see above). */
async function staticRecipientsOfRules(rules: RuleRecipientRow[]): Promise<{ addresses: string[]; userIds: string[] }> {
  const addresses = new Set<string>();
  const userIds = new Set<string>();
  let levelIndex: RegionLevelIndex | null = null;
  for (const rule of rules) {
    const carrier: RuleActionCarrier = {
      actions: rule.actions as RuleActionCarrier["actions"],
      escalation: rule.escalation,
      severityBands: rule.severityBands as RuleActionCarrier["severityBands"],
      bandNotify: rule.bandNotify as RuleActionCarrier["bandNotify"],
      // The all-clear's recipients are not the summary's audience.
      resetActions: null,
    };
    const scopeRegions = scopeRegionTagsOf(rule.scope as never);
    // Device-region routing has no triggering device here, so it stands in
    // for every device the rule could fire on: the region snapshots of the
    // scope's monitored devices, read once per rule and only when an action
    // routes that way.
    let snapshots: string[][] | null = null;
    const regionSnapshots = async (): Promise<string[][]> => {
      snapshots ??= await loadScopeRegionSnapshots(scopeForTrigger(rule.scope as unknown as RuleScope, rule.trigger));
      return snapshots;
    };
    for (const ref of allRuleActionRefs(carrier)) {
      const a = ref.action as Record<string, unknown>;
      if (a.type !== "notify") continue;
      for (const addr of Array.isArray(a.addresses) ? (a.addresses as string[]) : []) {
        const t = addr.trim().toLowerCase();
        if (t) addresses.add(t);
      }
      const users: Array<{ id: string }> = [];
      try {
        if (a.recipientAllUsers) users.push(...(await resolveAllUsers()));
        if (a.recipientAllRegions) users.push(...(await resolveUsersInAnyRegion()));
        if (Array.isArray(a.recipientRegions) && a.recipientRegions.length) users.push(...(await resolveUsersByRegions(a.recipientRegions as string[])));
        if (Array.isArray(a.recipientRoles) && a.recipientRoles.length) users.push(...(await resolveUsersByRoles(a.recipientRoles as string[])));
        if (Array.isArray(a.recipientUserIds) && a.recipientUserIds.length) users.push(...(await resolveRecipientUsersByIds(a.recipientUserIds as string[])));
        if (Array.isArray(a.recipientTags) && a.recipientTags.length) users.push(...(await resolveRecipientUsers(a.recipientTags as string[])));
        if (a.recipientScopeRegion && scopeRegions?.length) users.push(...(await resolveRecipientUsers(scopeRegions)));
        if (a.recipientDeviceRegion) {
          // The same flattened match fire-time recipientDeviceRegion uses.
          const tags = Array.from(new Set((await regionSnapshots()).flat()));
          if (tags.length) users.push(...(await resolveRecipientUsers(tags)));
        }
        if (Array.isArray(a.recipientDeviceRegionLevels) && a.recipientDeviceRegionLevels.length) {
          levelIndex ??= await regionLevelIndex();
          const names = new Set<string>();
          for (const snap of await regionSnapshots()) {
            for (const n of deviceRegionsAtLevels(snap, a.recipientDeviceRegionLevels as number[], levelIndex)) names.add(n);
          }
          if (names.size) users.push(...(await resolveUsersByRegions(Array.from(names))));
        }
      } catch (err) {
        logger.warn({ ruleId: rule.id, err: (err as Error)?.message }, "all-quiet summary: a recipient lookup failed; continuing with the rest");
      }
      for (const u of users) userIds.add(u.id);
    }
  }
  return { addresses: Array.from(addresses), userIds: Array.from(userIds) };
}

/** Addresses → recipients with their account (for the zone), plus push
 *  accounts reached by their email. Skips an account with no address, once. */
async function resolveRecipients(addresses: string[], userIds: string[], sourceName: string): Promise<SummaryRecipient[]> {
  const users = (addresses.length > 0 || userIds.length > 0)
    ? await prisma.user.findMany({
        where: {
          OR: [
            ...(userIds.length ? [{ id: { in: userIds } }] : []),
            ...(addresses.length ? [{ email: { in: addresses, mode: "insensitive" as const } }] : []),
          ],
        },
        select: { id: true, email: true, username: true },
      })
    : [];
  const byAddress = new Map<string, SummaryRecipient>();
  for (const a of addresses) byAddress.set(a, { address: a, status: "pending", attempts: 0 });
  const noEmail: string[] = [];
  for (const u of users) {
    const addr = u.email?.trim().toLowerCase();
    if (!addr) {
      if (userIds.includes(u.id)) noEmail.push(u.username);
      continue;
    }
    const existing = byAddress.get(addr);
    if (existing) existing.userId = u.id;
    else if (userIds.includes(u.id)) byAddress.set(addr, { address: addr, userId: u.id, status: "pending", attempts: 0 });
  }
  if (noEmail.length > 0) {
    await logEvent({
      action: "quiet_time.summary_recipient_skipped",
      resourceType: "system",
      actor: "system:quiet-time",
      level: "warning",
      message: `Quiet-time summary for "${sourceName}": ${noEmail.length} recipient(s) would have been pushed but have no email address on their account — ${noEmail.join(", ")}`,
      details: { usernames: noEmail },
    }).catch(() => {});
  }
  return Array.from(byAddress.values());
}

// ─── SEND ────────────────────────────────────────────────────────────────────

export async function drainPendingSummaries(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const rows = await prisma.quietTimeSummary.findMany({
    where: { status: { in: ["pending", "partial"] } },
    select: { id: true, sourceKind: true, sourceId: true, sourceName: true, coveredFrom: true, coveredTo: true, details: true, recipients: true, channelId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const recipients = (Array.isArray(row.recipients) ? row.recipients : []) as unknown as SummaryRecipient[];
    const todo = recipients.filter((r) => r.status !== "sent" && r.attempts < SUMMARY_MAX_ATTEMPTS);
    if (todo.length === 0) {
      await finalize(row.id, row.sourceName, recipients, now);
      continue;
    }
    const channel = row.channelId
      ? await prisma.notificationChannel.findUnique({ where: { id: row.channelId }, select: { id: true, type: true, enabled: true, config: true } })
      : null;
    if (!channel || !isEmailChannel(channel)) {
      for (const r of todo) { r.status = "failed"; r.attempts = SUMMARY_MAX_ATTEMPTS; r.error = "summary email channel is missing or disabled"; }
      await finalize(row.id, row.sourceName, recipients, now, true);
      failed += todo.length;
      continue;
    }

    const userIds = todo.map((r) => r.userId).filter((x): x is string => !!x);
    const zones = new Map<string, string>();
    if (userIds.length > 0) {
      const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true, detectedTimezone: true } });
      for (const u of users) zones.set(u.id, resolveTimeZone(u.timezone, u.detectedTimezone));
    }
    const details = (row.details && typeof row.details === "object" ? row.details : { outstanding: [], recurring: [], recurrenceThreshold: null }) as unknown as SummaryDetails;

    for (const chunk of chunkArray(todo, SEND_CONCURRENCY)) {
      await Promise.all(chunk.map(async (r) => {
        r.attempts += 1;
        try {
          const zone = (r.userId && zones.get(r.userId)) || serverTimeZone();
          const rendered = renderQuietSummaryEmail({
            sourceName: row.sourceName,
            sourceKind: row.sourceKind as QuietSourceKind,
            coveredFrom: row.coveredFrom,
            coveredTo: row.coveredTo,
            zone,
            outstanding: details.outstanding ?? [],
            recurring: details.recurring ?? [],
            recurrenceThreshold: details.recurrenceThreshold ?? null,
            allQuiet: details.allQuiet === true,
            heldCount: details.heldCount ?? 0,
            now,
          });
          const msg = await applyBrandLetterhead({ to: [r.address], subject: rendered.subject, text: rendered.text, html: rendered.html });
          await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
          r.status = "sent";
          delete r.error;
          sent++;
        } catch (err) {
          r.status = "failed";
          r.error = String((err as Error)?.message ?? err).slice(0, 500);
          if (r.attempts >= SUMMARY_MAX_ATTEMPTS) failed++;
        }
      }));
    }
    await finalize(row.id, row.sourceName, recipients, now);
  }
  return { sent, failed };
}

/** Persist the recipients and roll the row's status up; one Event at the end. */
async function finalize(id: string, sourceName: string, recipients: SummaryRecipient[], now: Date, forceTerminal = false): Promise<void> {
  const sentCount = recipients.filter((r) => r.status === "sent").length;
  const retrying = !forceTerminal && recipients.some((r) => r.status !== "sent" && r.attempts < SUMMARY_MAX_ATTEMPTS);
  const failedCount = recipients.filter((r) => r.status !== "sent").length;
  const status = retrying ? "partial" : failedCount === 0 ? "sent" : sentCount > 0 ? "partial-failed" : "failed";
  const terminal = !retrying;
  await prisma.quietTimeSummary.update({
    where: { id },
    data: {
      recipients: recipients as unknown as Prisma.InputJsonValue,
      status,
      ...(terminal && sentCount > 0 ? { sentAt: now } : {}),
    },
  });
  if (!terminal) return;
  await logEvent({
    action: failedCount === 0 ? "quiet_time.summary_sent" : "quiet_time.summary_failed",
    resourceType: "quiet-time-summary",
    resourceId: id,
    resourceName: sourceName,
    actor: "system:quiet-time",
    level: failedCount === 0 ? "info" : "warning",
    message:
      `Quiet-time summary for "${sourceName}": ${sentCount} of ${recipients.length} recipient(s) emailed` +
      (failedCount > 0 ? `; ${failedCount} failed (${recipients.filter((r) => r.status !== "sent").map((r) => r.address).join(", ")})` : ""),
    details: { sent: sentCount, failed: failedCount, recipients: recipients.map((r) => ({ address: r.address, status: r.status, attempts: r.attempts, ...(r.error ? { error: r.error } : {}) })) },
  }).catch(() => {});
}

/**
 * Send a summary again, by hand (Automations → Settings → recent summaries →
 * Resend). Every recipient that was NOT reached goes back to pending with a
 * fresh attempt budget — a recipient already `sent` is left alone, so a
 * partial failure re-sends to the people who missed it and nobody else — and
 * the drain runs at once so the caller sees the outcome. The email is
 * re-rendered from the row's own `details`, i.e. it says what it would have
 * said at the time, not what is outstanding now.
 */
export async function resendSummary(id: string, actor?: string): Promise<void> {
  const row = await prisma.quietTimeSummary.findUnique({
    where: { id },
    select: { id: true, sourceName: true, status: true, recipients: true, channelId: true },
  });
  if (!row) throw new AppError(404, "Quiet-time summary not found");
  const recipients = (Array.isArray(row.recipients) ? row.recipients : []) as unknown as SummaryRecipient[];
  if (recipients.length === 0) throw new AppError(400, "This summary has no recipients to send to");
  if (!row.channelId) throw new AppError(400, "This summary has no email channel — configure one under Delivery and set it on the quiet time");
  let reset = 0;
  for (const r of recipients) {
    if (r.status === "sent") continue;
    r.status = "pending";
    r.attempts = 0;
    delete r.error;
    reset++;
  }
  if (reset === 0) throw new AppError(400, "Every recipient of this summary has already been reached");
  await prisma.quietTimeSummary.update({
    where: { id },
    data: { recipients: recipients as unknown as Prisma.InputJsonValue, status: "pending" },
  });
  await logEvent({
    action: "quiet_time.summary_resent",
    resourceType: "quiet-time-summary",
    resourceId: id,
    resourceName: row.sourceName,
    actor,
    message: `Quiet-time summary for "${row.sourceName}" queued again for ${reset} recipient(s)`,
    details: { recipients: reset },
  }).catch(() => {});
  await drainPendingSummaries();
}

/** One tick: create what is due, then send what is pending. */
export async function runQuietTimeSummaries(now: Date = new Date()): Promise<{ created: number; sent: number; failed: number }> {
  const created = await createDueSummaries(now);
  const { sent, failed } = await drainPendingSummaries(now);
  return { created, sent, failed };
}
