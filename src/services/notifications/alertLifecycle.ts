/**
 * src/services/notifications/alertLifecycle.ts — the alert lifecycle (CQ-B063, moved verbatim from notificationEngine.ts): fire, reset
 * and recover; grouped alerts (business rule 75) — folding members into one alert per
 * device / automation / subnet, membership snapshots, the first-send hold and the pending
 * sends; band transitions and the forecast countdown; releasing a member.
 */

import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { logEvent } from "../eventLogService.js";
import { triggerSummary, pathConditionPhrase, recoveredConditionSuffix } from "../../utils/triggerSummary.js";
import { sensorReadingDisplay } from "../alertChartService.js";
import { resolveAssetCadenceSec } from "../notificationCadenceService.js";
import { REGION_TAG_PREFIX, rootCauseAckFor, sameAssetDownAckFor, inheritableRootCauseId, inheritedAckData, type InheritedAck } from "../notificationService.js";
import { isPathMetric, type Trigger, type RuleScope, type AutomationAction, type RuleActionCarrier, expandResetActions, parseEscalationFired, severityRank, type AlertMember, type GroupChange, classifyGroupChanges, describeGroupChanges, ruleGroupsByAsset, alertScopeOf, groupKeyOf, subnetFoldTarget, automationFoldTarget, WHOLE_GROUP_FOLD_TARGET, wholeGroupSubject, countNoun, type SpanCounts, memberMatches, queueGroupChanges, refreshMemberContext, type PendingGroupChanges, mergeMembers, markMemberLeft, activeMembers, groupSeverity, primaryMember, renderMemberList, forecastLevelsOf, type ForecastLevel, scopeIsUnconstrained, isDownDetectionTrigger } from "../notificationTypes.js";
// Business rule 78 — who silenced a dependency-suppressed device, for the
// alert a down automation raises about it anyway.
import { resolveDependencyBlame } from "../dependencyTreeService.js";
import { dependencyTriggerSummary } from "../../utils/notificationTemplate.js";
import { mostSpecificContaining } from "../../utils/cidr.js";
import { logger } from "../../utils/logger.js";
import { buildTemplateContext, forecastCountdown, setRecoverySentence } from "../../utils/notificationTemplate.js";
import { type DbRule, type Reading } from "./ruleModel.js";
import { _blameCache, assetDetail } from "./assetDetail.js";
import { loadScopeAssetIds, regionSnapshot } from "./scope.js";
import { type CompositeFireInfo, readingContextParts, applyFollowUpPolicy, renderMessage, round2, ruleWantsContext, groupWantsContext, groupWantsAssetDetail, ruleWantsAssetDetail } from "./templating.js";
import { enqueueAlertActions, groupOwnersOf, groupOwnerOf, ownerActions } from "./alertActions.js";
import { CLEARED_RUNS, metSinceJson, tierForSeverity, bandNotifyOf, severityLevel } from "./severityBands.js";

// ─── Grouped alerts (business rule 75) ──────────────────────────────────────
//
// One alert may name many parts of one device, and it ends only when the last
// of them does. A CONTRIBUTION is (automation, component) on an asset.
//
// The state machine is UNCHANGED: NotificationRuleState stays keyed
// (rule, asset, dimension) and every hold, band, hysteresis, poll count and
// pin gate still runs per contribution. Only the Notification row is shared —
// many firing state rows point at one of them. That is what keeps this feature
// out of the hot path: the whole of it is behind `ruleGroupsByAsset`, false for
// every rule in an install that has not opted in.
//
// Two sources of truth, and the direction between them is load-bearing:
//   - the STATE ROWS are the live truth. "Was that the last contribution?" is
//     asked of them with a count, never of the members snapshot;
//   - `Notification.members` is a RENDER snapshot, because the email renders at
//     delivery time and the alert page renders after the clear.

/** One buffered contribution, waiting for the flush to write it. */
interface GroupFire {
  reading: Reading;
  lastValue: number | null;
  severity: string;
  actions: AutomationAction[];
  bandMetSince: Record<string, number> | null;
}

/** assetId → the contributions that crossed into firing on this tick. */
export type GroupBuffer = Map<string, GroupFire[]>;

/** What one alert spans when it holds SEVERAL devices: the registry subnet
 *  they share (a SUBNET AlertGroup), the automation they all tripped (an
 *  AUTOMATION one) or the whole group (`deviceAutomation`). Its members are
 *  devices. */
interface FoldSpan {
  kind: "subnet" | "automation" | "group";
  id: string;
  /** "Plant A (10.1.0.0/24)", or the automation's name — what the alert names
   *  in place of a device. */
  label: string;
  /** Set when an automation fold is split per COMPONENT (a Path Monitor
   *  automation: one alert per path check) — the component every device on
   *  this alert shares. Its members then name only their host. */
  component?: { key: string; label: string };
}

/** One alert's worth of a flush: the contributions that share a groupKey. */
interface FoldBucket {
  /** The groupKey target — an asset id, or the fold's own target
   *  (subnetFoldTarget / automationFoldTarget / WHOLE_GROUP_FOLD_TARGET). */
  target: string;
  /** Whether the rule's group governs these devices (else the rule's own key). */
  governs: boolean;
  /** Set only when this bucket holds several devices (subnet / automation / group). */
  span: FoldSpan | null;
  fires: GroupFire[];
}

/** What the tick still owes an alert once every rule has been evaluated.
 *
 *  Sends are drained ONCE per tick rather than once per flush, so contributions
 *  that arrive in the same tick produce ONE message however many of them there
 *  are. In this phase that only matters within a rule; it is built this way
 *  because the moment alerts can be folded ACROSS automations, a PoE fault and
 *  a temperature alarm landing together must not become a fire plus a growth. */
interface PendingSend {
  kind: "fire" | "growth";
  notificationId: string;
  rule: DbRule;
  /** The contribution the message leads with (charts, LLDP block, {value}). */
  reading: Reading;
  ctx: Record<string, string>;
  actions: AutomationAction[];
  severity: string;
  /** How many contributions the alert names as of this send. */
  count: number;
  /** What joined or came back this tick — what a growth send says changed. */
  changes?: GroupChange[];
  /** Set when a join re-opened an acknowledged alert: who had acknowledged it. */
  reopenedFrom?: string;
}

export type PendingSends = Map<string, PendingSend>;

/**
 * The TICK's index of live grouped alerts, keyed by `groupKey`.
 *
 * Only an AlertGroup needs it. A rule folding its own components can find its
 * alert in the state rows it has already loaded — a contribution and the alert
 * it belongs to are always the same automation's — but a GROUP's alert may have
 * been opened by a different member automation entirely, whose state rows this
 * rule's pass never sees.
 *
 * Built once per tick and mutated as alerts are created, so the cost is one
 * query bounded by LIVE ALERTS (tens to low thousands) rather than by fleet
 * size, and a group of five automations pays it once rather than five times.
 */
export class TickAlertIndex {
  private loaded = false;
  private byKey = new Map<string, string>();

  async keysFor(): Promise<Map<string, string>> {
    if (!this.loaded) {
      const rows = await prisma.notification.findMany({
        where: { groupKey: { not: null }, cleared: false },
        select: { id: true, groupKey: true },
      });
      for (const r of rows) if (r.groupKey) this.byKey.set(r.groupKey, r.id);
      this.loaded = true;
    }
    return this.byKey;
  }

  /** Record an alert this tick just opened, so a later member joins it rather
   *  than racing the partial unique index for a second one. */
  remember(groupKey: string, notificationId: string): void {
    this.byKey.set(groupKey, notificationId);
  }

  // ── Which subnet each device folds into (a SUBNET AlertGroup) ──────────────
  //
  // The registry is read once per tick and only when a subnet group actually
  // has fires to place, so an install without one never pays the query. Asset
  // IPs are read for the devices being placed — the firing ones, which are
  // tens even in a storm, never the fleet.
  private subnets: { id: string; name: string; cidr: string }[] | null = null;
  private subnetOfAsset = new Map<string, FoldSpan | null>();

  async subnetsOf(assetIds: string[]): Promise<Map<string, FoldSpan | null>> {
    const missing = assetIds.filter((id) => id && !this.subnetOfAsset.has(id));
    if (missing.length) {
      if (!this.subnets) {
        this.subnets = await prisma.subnet.findMany({
          where: { status: { not: "deprecated" } },
          select: { id: true, name: true, cidr: true },
        });
      }
      const rows = await prisma.asset.findMany({ where: { id: { in: missing } }, select: { id: true, ipAddress: true } });
      const ipOf = new Map(rows.map((r) => [r.id, r.ipAddress]));
      for (const id of missing) {
        const ip = ipOf.get(id);
        const hit = ip ? mostSpecificContaining(this.subnets, `${ip}/32`) : null;
        this.subnetOfAsset.set(id, hit ? { kind: "subnet", id: hit.id, label: `${hit.name} (${hit.cidr})` } : null);
      }
    }
    return new Map(assetIds.map((id) => [id, this.subnetOfAsset.get(id) ?? null]));
  }

  // ── Which devices each AlertGroup GOVERNS ─────────────────────────────────
  //
  // A group may carry a scope of its own. It narrows where the FOLD applies —
  // never what a member watches — so on a device the group does not govern,
  // that member delivers on its own exactly as an ungrouped automation would.
  //
  // Resolved through `loadScopeAssetIds`, the documented server-side resolver,
  // rather than by matching rows in memory: it is the path that decorates
  // relation-backed leaves (`interfaceName`) before evaluating them, and an
  // undecorated row would silently read as "no interfaces". Cached per GROUP
  // per tick, so five member automations resolve it once between them.
  //
  // `null` means "governs everything" — no scope, or an unconstrained one —
  // which is what every group had before the column existed.
  private groupScopes = new Map<string, Set<string> | null>();

  async governedAssetIds(alertGroupId: string): Promise<Set<string> | null> {
    if (this.groupScopes.has(alertGroupId)) return this.groupScopes.get(alertGroupId)!;
    let governed: Set<string> | null = null;
    try {
      const g = await prisma.alertGroup.findUnique({ where: { id: alertGroupId }, select: { scope: true } });
      const scope = (g?.scope ?? null) as RuleScope | null;
      if (scope && !scopeIsUnconstrained(scope)) {
        // NOT monitoredOnly: the trigger gate (business rule 37) has already
        // decided what may fire. This asks only "does the group cover it".
        governed = new Set(await loadScopeAssetIds(scope));
      }
    } catch (err) {
      // A failed resolve must not silently un-group a fleet: fall back to
      // "governs everything" (the pre-scope behaviour) and SAY SO as an Event
      // rather than a log line. The alternative failure — treating it as
      // "governs nothing" — would scatter one folded alert back into one per
      // component and per automation, which reads as the feature breaking.
      governed = null;
      await logEvent({
        action: "notification.engine_error",
        actor: "system:notification-engine",
        level: "warning",
        message: "Alert group device filter could not be resolved — the group covered every device this tick",
        details: { alertGroupId, err: (err as Error)?.message },
      }).catch(() => {});
    }
    this.groupScopes.set(alertGroupId, governed);
    return governed;
  }
}

/** assetId → the live alert a contribution from this rule should join. */
export async function liveAlertsByAsset(
  rule: DbRule,
  states: { state: string; assetId: string | null; notificationId: string | null }[],
  tickIndex: TickAlertIndex | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ruleGroupsByAsset(rule)) return out;
  if (!rule.alertGroupId) {
    // Its own alerts: free, off the snapshot the readings loop already loaded.
    for (const s of states) {
      if (s.state === "firing" && s.assetId && s.notificationId) out.set(s.assetId, s.notificationId);
    }
    return out;
  }
  // A group's alert may belong to another member automation, so the answer is
  // keyed by groupKey rather than by anything this rule can see.
  //
  // BOTH prefixes are collected: a member whose group does not govern a given
  // device keys that device's alert on itself, so the same automation can have
  // `grp:` alerts on some devices and `rule:` alerts on others at once.
  if (!tickIndex) return out;
  const byKey = await tickIndex.keysFor();
  const prefixes = [alertScopeOf(rule, true), alertScopeOf(rule, false)]
    .map((s) => `${s.scope}:${s.id}|`);
  for (const [key, id] of byKey) {
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) { out.set(key.slice(prefix.length), id); break; }
    }
  }
  return out;
}

/**
 * Does this rule's AlertGroup govern THIS device?
 *
 * True with no work at all when the rule has no group, or the group has no
 * scope — which is every group until someone narrows one, so the common path
 * costs nothing. False only when a scope exists and this device is outside it,
 * in which case the member delivers on its own.
 */
async function groupGovernsAsset(
  rule: DbRule,
  assetId: string,
  tickIndex: TickAlertIndex | null,
): Promise<boolean> {
  if (!rule.alertGroupId || !tickIndex) return true;
  const governed = await tickIndex.governedAssetIds(rule.alertGroupId);
  return governed === null || governed.has(assetId);
}

/** Turn an engine reading into the contribution stored on the alert. */
function memberOf(rule: DbRule, f: GroupFire, now: Date, span: FoldSpan | null = null): AlertMember {
  const r = f.reading;
  const own = r.dimLabel || r.dimKey;
  return {
    key: r.dimKey,
    // The LABEL, so the alert says "port12 (Indoor AP)" and nobody has to go
    // and look up which port that is. `dimension` on the row stays the KEY.
    //
    // On a subnet or automation fold the members are DEVICES, so the label
    // leads with the host — "plc-04", or "sw-02 — port12" for a per-component
    // trigger. An alert split per component names that component once, for
    // the whole alert, so its members are the bare host.
    label: span
      ? (own && !span.component ? `${r.hostname || r.assetId} — ${own}` : (r.hostname || r.assetId))
      : own,
    ruleId: rule.id,
    ruleName: rule.name,
    severity: f.severity,
    value: r.value === null || r.value === undefined
      ? undefined
      : typeof r.value === "number" ? round2(r.value) : String(r.value),
    joinedAt: now.toISOString(),
    ...(span
      ? {
        assetId: r.assetId,
        ...(span.kind === "subnet" ? { subnet: span.label } : {}),
        ...(span.kind === "group" ? { group: span.label } : {}),
        ...(span.component ? { component: span.component.label } : {}),
      }
      : {}),
  };
}

/**
 * The true size of a multi-device alert: its FIRING state rows plus this
 * tick's contributions, which are written to state only after the context is
 * built. Never the members snapshot, which stops at MAX_GROUP_MEMBERS.
 *
 * Two queries, both bounded by the alert's own contributions, and only on an
 * alert that spans devices — every other alert costs nothing.
 */
async function spanCounts(
  rule: DbRule,
  notificationId: string | null,
  fires: GroupFire[],
  /** A contribution releasing right now — still `firing` until the caller writes it. */
  excludeStateId?: string,
): Promise<SpanCounts> {
  const rows = notificationId
    ? await prisma.notificationRuleState.findMany({
      where: { notificationId, state: "firing", ...(excludeStateId ? { id: { not: excludeStateId } } : {}) },
      select: { ruleId: true, assetId: true, dimensionKey: true },
    })
    : [];
  return countSpan(rule, [
    ...rows.map((r) => ({ ruleId: r.ruleId, assetId: r.assetId, key: r.dimensionKey })),
    ...fires.map((f) => ({ ruleId: rule.id, assetId: f.reading.assetId, key: f.reading.dimKey })),
  ]);
}

/** spanCounts over an explicit list of contributions — the all-clear's, which
 *  are read off the members snapshot because no state row is firing by then. */
async function countSpan(
  rule: DbRule,
  all: { ruleId: string; assetId: string | null; key: string }[],
): Promise<SpanCounts> {
  const ruleIds = [...new Set(all.map((c) => c.ruleId))];
  const pathRules = new Set<string>(isPathMetric(ruleMetricOf(rule.trigger)) ? [rule.id] : []);
  // What each automation's condition says about a check — the default message
  // says it once when they all agree ("3 path checks are down").
  const phrases = new Set<string | null>(all.length ? [pathConditionPhrase(rule.trigger as never)] : []);
  const others = ruleIds.filter((id) => id !== rule.id);
  if (others.length) {
    const rs = await prisma.notificationRule.findMany({ where: { id: { in: others } }, select: { id: true, trigger: true } });
    for (const r of rs) {
      const t = r.trigger as unknown as Trigger;
      if (isPathMetric(ruleMetricOf(t))) pathRules.add(r.id);
      phrases.add(pathConditionPhrase(t as never));
    }
  }
  const path = all.filter((c) => pathRules.has(c.ruleId));
  const shared = phrases.size === 1 ? [...phrases][0] : null;
  return {
    devices: new Set(all.map((c) => c.assetId)).size,
    checks: new Set(path.map((c) => c.key)).size,
    automations: ruleIds.length,
    pathOnly: all.length > 0 && path.length === all.length,
    condition: shared ? { one: shared, many: pathConditionPhrase(rule.trigger as never, true)! } : null,
  };
}

/** The metric an asset_metric trigger watches, else null. */
function ruleMetricOf(trigger: Trigger | null | undefined): string | null {
  return trigger?.type === "asset_metric" ? trigger.metric : null;
}

/** The buffered contribution the primary member stands for — the reading the
 *  alert LEADS with ({value}, the email's charts). Matched on the device too
 *  when the member carries one, since a subnet fold's keys repeat per host. */
function leadFire(fires: GroupFire[], primary: AlertMember | null): GroupFire {
  return (primary && fires.find((f) => memberMatches(primary, primary.ruleId, f.reading.dimKey, f.reading.assetId)))
    ?? fires[0]!;
}

/**
 * Sort this tick's buffered contributions into the alerts they belong to.
 *
 * A device group (or an ungrouped rule) keeps one alert per device. A
 * DEVICE-AND-AUTOMATION group folds both ways at once: ONE alert for the whole
 * group, every device and every member automation in it. An
 * AUTOMATION group puts every device it governs into this automation's one
 * alert — one per PATH CHECK for a Path Monitor automation, whose components
 * are fleet-wide checks rather than parts of one device — and a SUBNET group
 * into the alert of the device's registry subnet. A device the group does not
 * govern, or (by subnet) one in no subnet, keeps its own.
 */
async function foldBuckets(rule: DbRule, buf: GroupBuffer, tickIndex: TickAlertIndex | null): Promise<FoldBucket[]> {
  const foldBy = rule.alertGroupId ? (rule.alertGroupFoldBy ?? "device") : "device";
  const bySubnet = foldBy === "subnet" && !!tickIndex;
  const subnets = bySubnet ? await tickIndex!.subnetsOf([...buf.keys()]) : null;
  const automation: FoldSpan | null = foldBy === "automation" ? { kind: "automation", id: rule.id, label: rule.name } : null;
  // Both folds at once: every device and every member automation in ONE alert,
  // the group's. Shared across automations through the group's key, as a
  // device group's per-device alert already is.
  const whole: FoldSpan | null = foldBy === "deviceAutomation" && rule.alertGroupId
    ? { kind: "group", id: rule.alertGroupId, label: rule.alertGroupName || rule.name }
    : null;
  // "This path check is failing from these hosts" is the alert a Path Monitor
  // automation watching every check means; one alert for ALL its checks would
  // fold unrelated outages together. A port, by contrast, is part of ONE
  // device — port2 on two switches is not one finding — so only path checks
  // split.
  const perComponent = !!automation && rule.trigger.type === "asset_metric" && isPathMetric(rule.trigger.metric);
  const out = new Map<string, FoldBucket>();
  for (const [assetId, fires] of buf) {
    if (!fires.length) continue;
    if (perComponent) {
      const governs = await groupGovernsAsset(rule, assetId, tickIndex);
      for (const f of fires) {
        const comp = { key: f.reading.dimKey, label: f.reading.dimLabel || f.reading.dimKey };
        const span: FoldSpan | null = governs ? { ...automation!, label: `${rule.name} — ${comp.label}`, component: comp } : null;
        const target = governs ? automationFoldTarget(rule.id, comp.key) : assetId;
        const k = `${governs ? "g" : "r"}|${target}`;
        const b = out.get(k);
        if (b) b.fires.push(f);
        else out.set(k, { target, governs, span, fires: [f] });
      }
      continue;
    }
    // Where this rule's grouped alerts live: its AlertGroup when it belongs to
    // one AND that group governs THIS device, else itself. The two scopes can
    // never collide in the partial unique index.
    //
    // The per-device test is what lets one set of automations serve several
    // groups — "Switch health — Ashfield" and "Switch health — Dock" over the
    // same checks, routed to different people. On a device no group governs,
    // the automation still folds its own components; it just does so alone.
    const governs = await groupGovernsAsset(rule, assetId, tickIndex);
    const span = !governs ? null : automation ?? whole ?? subnets?.get(assetId) ?? null;
    const target = !governs ? assetId
      : span?.kind === "subnet" ? subnetFoldTarget(span.id)
      : span?.kind === "automation" ? automationFoldTarget(rule.id)
      : span?.kind === "group" ? WHOLE_GROUP_FOLD_TARGET
      : assetId;
    const k = `${governs ? "g" : "r"}|${target}`;
    const b = out.get(k);
    if (b) b.fires.push(...fires);
    else out.set(k, { target, governs, span, fires: [...fires] });
  }
  return [...out.values()];
}

/**
 * Write this tick's buffered contributions: one alert per whatever the fold
 * makes it (foldBuckets), created or joined, with the sends recorded for the
 * end-of-tick drain.
 *
 * Ordering matters at the call site — this must land its state rows BEFORE the
 * custom-reset pass, which re-reads firing rows from the database rather than
 * from the pre-loop snapshot.
 */
export async function flushGroupFires(
  rule: DbRule,
  buf: GroupBuffer,
  liveByAsset: Map<string, string>,
  now: Date,
  pending: PendingSends,
  tickIndex: TickAlertIndex | null,
): Promise<void> {
  for (const bucket of await foldBuckets(rule, buf, tickIndex)) {
    const live = liveByAsset.get(bucket.target);
    const joined = live ? await joinGroupAlert(rule, live, bucket.fires, now, pending, bucket.span) : false;
    if (!joined) await createGroupAlert(rule, bucket, now, pending, liveByAsset, tickIndex);
  }
}

/** Open a new grouped alert for one fold bucket. */
async function createGroupAlert(
  rule: DbRule,
  bucket: FoldBucket,
  now: Date,
  pending: PendingSends,
  liveByAsset: Map<string, string>,
  tickIndex: TickAlertIndex | null,
): Promise<void> {
  const { fires, governs, span, target } = bucket;
  const members = mergeMembers([], fires.map((f) => memberOf(rule, f, now, span)), now);
  const severity = groupSeverity(members, rule.severity);
  const primary = primaryMember(members);
  // The contribution the alert LEADS with — its reading is what {value} and
  // the email's charts are about. On a multi-device fold its device is the alert's
  // `assetId`: the alert has to point somewhere, and the device that leads it
  // is the one its charts already describe.
  const lead = leadFire(fires, primary);
  const assetId = lead.reading.assetId;
  const counts = span ? await spanCounts(rule, null, fires) : null;
  const ctx = await buildGroupContext(rule, lead, members, severity, now, counts);
  const scope = alertScopeOf(rule, governs);
  const groupKey = groupKeyOf(scope.scope, scope.id, target);
  // The first send waits one polling interval of the reading that opened the
  // alert, so whatever goes down with it is in the first email (rule 75).
  // The same interval then paces its updates (releaseDueGroupSends).
  const sendIntervalSec = await firstSendHoldSec(rule, lead.reading);
  const firstSendDueAt = new Date(now.getTime() + sendIntervalSec * 1000);

  let notif: { id: string };
  try {
    notif = await prisma.notification.create({
      data: {
        ruleId: rule.id,
        assetId: assetId || null,
        firstSendDueAt,
        sendIntervalSec,
        // A subnet (or automation) fold is about the subnet (or automation), so
        // that is what every alert list names it as; `assetId` still points at
        // the leading device.
        assetHostname: span ? span.label : lead.reading.hostname,
        severity,
        message: ctx["message"] ?? "",
        regionTags: regionSnapshot(lead.reading.tags),
        dimension: primary?.key || null,
        metric: rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric"
          ? rule.trigger.metric
          : rule.trigger.type === "asset_state" ? rule.trigger.field : null,
        groupKey,
        // The group owns this alert's DELIVERY from here on — its recipients,
        // escalation chain, reminder cadence and ack-note policy, resolved at
        // delivery time through alertOwnerOf. `ruleId` above stays set to the
        // automation that OPENED it regardless (the worst contribution is what
        // `dimension` follows; provenance that moved mid-life would be worse):
        // a null-ruleId alert cannot escalate, is invisible to the NOC's
        // relevance pills and has no name.
        //
        // Stamped ONLY when the group governs this device. An alert keyed
        // `rule:` because the group's scope excluded the device must not then
        // be DELIVERED by that group — it would fold alone and still page the
        // group's recipients, which is the half-applied version of the setting
        // and the one nobody would predict from the screen.
        alertGroupId: governs ? (rule.alertGroupId ?? null) : null,
        members: members as unknown as Prisma.InputJsonValue,
        dimensionCount: activeMembers(members).length,
        // Always stored here: the held first send is built from it.
        templateCtx: ctx as any,
      },
      select: { id: true },
    });
  } catch (err: any) {
    // The partial unique index refused a second LIVE row for this group key.
    // Something else opened the alert between our snapshot and this write — an
    // overlapping tick, a retried job. Join it rather than losing the fire.
    if (err?.code !== "P2002") throw err;
    const existing = await prisma.notification.findFirst({ where: { groupKey, cleared: false }, select: { id: true } });
    if (!existing) throw err;
    liveByAsset.set(target, existing.id);
    await joinGroupAlert(rule, existing.id, fires, now, pending, span);
    return;
  }

  liveByAsset.set(target, notif.id);
  // Remember it TICK-wide too, so a later member automation of the same group
  // joins this alert instead of racing the unique index for a second one.
  tickIndex?.remember(groupKey, notif.id);
  await upsertGroupStates(rule, fires, notif.id, now);
  // No send recorded: the alert is live in the app from now, and its first
  // message goes when the hold ends (releaseDueGroupSends), naming whatever
  // has joined by then.

  // Every fire is on the record (business rule 146) — no action gates it.
  {
    await logEvent({
      action: "notification.triggered",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(severity),
      message: ctx["message"] ?? "",
      details: {
        ruleId: rule.id,
        assetId: assetId || null,
        dimension: primary?.key ?? null,
        severity,
        grouped: true,
        members: members.map((m) => (m.assetId ? m.label : m.key)),
        ...(span ? { [span.kind]: span.label } : {}),
      },
    });
  }
}

/**
 * Add contributions to an alert that is already up.
 *
 * Returns false when the alert turned out to be gone, which is not an edge
 * case: `clearNotifications` (an operator clicking Clear) deliberately does NOT
 * release the state rows, so the very first manual clear of a grouped alert
 * leaves this function looking at a cleared row. The caller then creates a new
 * alert, which is the honest answer — the operator ended that episode.
 */
async function joinGroupAlert(
  rule: DbRule,
  notificationId: string,
  fires: GroupFire[],
  now: Date,
  pending: PendingSends,
  /** Set when this alert holds several devices (a subnet or automation fold)
   *  — its members are devices. */
  span: FoldSpan | null = null,
): Promise<boolean> {
  const row = await prisma.notification.findFirst({
    where: { id: notificationId, cleared: false },
    select: {
      id: true, members: true, severity: true, acknowledged: true, acknowledgedBy: true, acknowledgeNote: true,
      firstSendDueAt: true, firstSentAt: true, sendIntervalSec: true, pendingChanges: true,
    },
  });
  if (!row) return false;
  const held = firstSendHeld(row);
  // Past its first send, an alert opened with a measured interval (every one
  // since the update cadence landed) collects its changes for the next paced
  // update instead of emailing now. One opened before keeps sending at once.
  const paced = !held && row.sendIntervalSec != null;

  const prev = (row.members ?? []) as unknown as AlertMember[];
  const joining = fires.map((f) => memberOf(rule, f, now, span));
  // Before the merge, which clears `leftAt` — the only trace of a component
  // that recovered and has now faulted again.
  const changes = classifyGroupChanges(prev, joining, now);
  const members = mergeMembers(prev, joining, now);
  const severity = groupSeverity(members, rule.severity);
  const primary = primaryMember(members);
  const lead = leadFire(fires, primary);
  const counts = span ? await spanCounts(rule, notificationId, fires) : null;
  const ctx = await buildGroupContext(rule, lead, members, severity, now, counts);

  // A contribution arriving after someone acknowledged RE-OPENS the alert:
  // acknowledging "3 ports faulted" is not acknowledging "now 9 ports". The
  // columns are cleared and the escalation/reminder clocks restart, which is
  // the whole point of re-opening; the acknowledgement itself is not lost,
  // because the Event below records who made it and what they said.
  const reopening = row.acknowledged;
  const queued = paced ? queueGroupChanges(row.pendingChanges, changes, reopening ? (row.acknowledgedBy ?? "") : undefined) : null;

  const res = await prisma.notification.updateMany({
    where: { id: notificationId, cleared: false },
    data: {
      members: members as unknown as Prisma.InputJsonValue,
      dimensionCount: activeMembers(members).length,
      severity,
      message: ctx["message"] ?? "",
      dimension: primary?.key || null,
      // Held or paced, the next email is built from this stored context.
      ...(groupWantsContext(rule) || held || paced ? { templateCtx: ctx as any } : {}),
      ...(queued ? { pendingChanges: queued as unknown as Prisma.InputJsonValue } : {}),
      ...(reopening
        ? { acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, acknowledgeNote: null, acknowledgedVia: Prisma.DbNull, escalationState: Prisma.DbNull }
        : {}),
    },
  });
  // Lost a race with a clear between the read and the write — treat it as gone.
  if (res.count === 0) return false;

  await upsertGroupStates(rule, fires, notificationId, now);
  // One send per alert per tick: everything that joined folds into one message
  // naming the whole set. A "fire" already recorded for this alert stays a
  // fire — the contributions simply ride it, with no second message.
  //
  // An alert still HOLDING its first send owes nobody an update: the joiners
  // are simply in the first message when the hold ends (releaseDueGroupSends).
  // A PACED one has queued its changes above; the next update names them.
  const existing = pending.get(notificationId);
  if (!held && !paced) pending.set(notificationId, {
    kind: existing?.kind ?? "growth",
    notificationId,
    rule,
    reading: lead.reading,
    ctx,
    actions: lead.actions,
    severity,
    count: activeMembers(members).length,
    // Accumulated, so two member automations of one AlertGroup joining in the
    // same tick both make the one update's "what changed". A fire recorded
    // this tick needs none — the contributions simply ride it.
    changes: [...(existing?.changes ?? []), ...changes],
    reopenedFrom: reopening ? (row.acknowledgedBy ?? "") : existing?.reopenedFrom,
  });

  await logEvent({
    action: reopening ? "notification.reopened" : "notification.member_joined",
    resourceType: "notification",
    resourceId: notificationId,
    resourceName: rule.name,
    actor: "system:notification-engine",
    level: severityLevel(severity),
    message: reopening
      ? `${rule.name}: ${joining.map((m) => m.label).join(", ")} joined after ${row.acknowledgedBy ?? "someone"} acknowledged it`
      : `${rule.name}: ${joining.map((m) => m.label).join(", ")} joined this alert`,
    details: {
      ruleId: rule.id,
      assetId: lead.reading.assetId || null,
      joined: span ? joining.map((m) => m.label) : fires.map((f) => f.reading.dimKey),
      severity,
      ...(reopening
        ? { priorAcknowledgedBy: row.acknowledgedBy, priorAcknowledgeNote: row.acknowledgeNote }
        : {}),
    },
  });
  return true;
}

/** Point every buffered contribution's state row at the alert. */
async function upsertGroupStates(rule: DbRule, fires: GroupFire[], notificationId: string, now: Date): Promise<void> {
  for (const f of fires) {
    await prisma.notificationRuleState.upsert({
      where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: f.reading.assetId, dimensionKey: f.reading.dimKey } },
      create: {
        ruleId: rule.id, assetId: f.reading.assetId, dimensionKey: f.reading.dimKey,
        state: "firing", firedAt: now, lastValue: f.lastValue, notificationId,
        firingSeverity: f.severity, bandMetSince: metSinceJson(f.bandMetSince),
      },
      update: {
        state: "firing", firedAt: now, lastValue: f.lastValue, notificationId,
        conditionMetSince: null, recoveredSince: null,
        firingSeverity: f.severity, bandMetSince: metSinceJson(f.bandMetSince),
      },
    });
  }
}

/** The template context for a grouped alert: the lead contribution's reading,
 *  with the member list folded over the dimension tokens. */
async function buildGroupContext(
  rule: DbRule,
  lead: GroupFire,
  members: AlertMember[],
  severity: string,
  now: Date,
  /** Set on an alert that spans devices (spanCounts). */
  counts: SpanCounts | null = null,
): Promise<Record<string, string>> {
  const detail = groupWantsAssetDetail(rule) && lead.reading.assetId ? await assetDetail(lead.reading.assetId) : null;
  const parts = readingContextParts(rule, lead.reading, now, undefined, members, counts);
  parts.severity = severity;
  applyFollowUpPolicy(parts, rule, severity);
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  await applySensorUnitToSummary(rule, lead.reading, ctx);
  ctx["message"] = renderMessage(rule, lead.reading, ctx, members, counts);
  return ctx;
}

/**
 * Drain the tick's sends — one fan-out per alert, with the final member set.
 *
 * Deliberately outside any transaction: executeActions does its own writes and
 * outbound work, and holding a pooled connection across the fan-out is how a
 * storm tick starves everything else.
 */
/** Did this alert end (or is it ending) without its first message ever going
 *  out? Asked on a clear, so one primary-key read per recovery. Read whether or
 *  not the row is already cleared: the clear may have been written first. */
async function neverAnnounced(notificationId: string): Promise<boolean> {
  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { firstSendDueAt: true, firstSentAt: true },
  });
  return !!row && firstSendHeld(row);
}

/** Is this grouped alert still waiting to send its first message? */
function firstSendHeld(row: { firstSendDueAt?: Date | null; firstSentAt?: Date | null }): boolean {
  return !!row.firstSendDueAt && !row.firstSentAt;
}

/** The engine tick (evaluateNotificationRules) — the hold used when a
 *  reading's own cadence cannot be resolved. */
const FIRST_SEND_HOLD_FALLBACK_SEC = 60;

/**
 * How long a newly opened grouped alert holds its first send: ONE polling
 * interval of the reading that opened it (business rule 75), so another device
 * or automation failing on the next poll joins the first email instead of
 * arriving as an update a minute later. A path check's interval is the
 * check's own; everything else is the device's stream cadence.
 *
 * The hold is added on top of the automation's own "for N polls" — an
 * automation waiting 3 polls of a 5-minute check opens its alert at 15
 * minutes and sends at 20.
 */
async function firstSendHoldSec(rule: DbRule, reading: Reading): Promise<number> {
  const t = rule.trigger;
  const metric = t.type === "asset_metric" || t.type === "host_metric" ? t.metric
    : t.type === "asset_state" ? t.field
    : null;
  const sec = await resolveAssetCadenceSec(reading.assetId || null, metric, reading.dimKey || null);
  return sec && sec > 0 ? sec : FIRST_SEND_HOLD_FALLBACK_SEC;
}

/**
 * Send the first message of every grouped alert whose hold has ended.
 *
 * Runs once per engine pass, before the drain, so a release and this tick's
 * sends go out together. The message is built from the alert AS IT STANDS —
 * its stored template context, members, severity and message, all kept current
 * by every join while it was held — and the actions are the band of its
 * current severity, which is what a fire at this severity would have used.
 * The group (when one governs the alert) still swaps in its own actions at the
 * drain, as for any fire.
 *
 * THEN the paced updates (business rule 75): every alert past its first send
 * that has changes queued in `pendingChanges` — devices or components that
 * joined, recovered or came back — and whose `nextUpdateDueAt` has passed gets
 * ONE [UPDATED] send naming them all, and its next update moves a whole
 * interval on. So however many hosts come and go, the reader gets at most one
 * email per polling interval of the reading that opened the alert.
 *
 * Two indexed queries (the partial indexes on held and on due rows); nothing
 * to do on a tick where no grouped alert is due, which is almost every tick.
 */
export async function releaseDueGroupSends(rulesById: Map<string, DbRule>, pending: PendingSends, now: Date): Promise<void> {
  const select = {
    id: true, ruleId: true, assetId: true, assetHostname: true, regionTags: true,
    dimension: true, severity: true, templateCtx: true, members: true,
    firstSendDueAt: true, firstSentAt: true, sendIntervalSec: true, pendingChanges: true, nextUpdateDueAt: true,
  } as const;
  const readingOf = (n: { assetId: string | null; assetHostname: string | null; regionTags: string[] | null; dimension: string | null }): Reading => ({
    assetId: n.assetId ?? "",
    hostname: n.assetHostname,
    // regionTags is the stripped snapshot; enqueueAlertActions strips again.
    tags: (n.regionTags ?? []).map((t) => REGION_TAG_PREFIX + t),
    dimKey: n.dimension ?? "",
    dimLabel: "",
    value: null,
  });
  const nextUpdate = (intervalSec: number | null) =>
    intervalSec != null ? new Date(now.getTime() + intervalSec * 1000) : null;

  const due = await prisma.notification.findMany({
    where: { cleared: false, firstSentAt: null, firstSendDueAt: { not: null, lte: now } },
    select,
  });
  for (const n of due) {
    if (!firstSendHeld(n) || n.firstSendDueAt!.getTime() > now.getTime()) continue;
    // Stamped first, and only if still held: an overlapping pass must not send
    // twice. The first update may follow one interval after this send.
    const claimed = await prisma.notification.updateMany({
      where: { id: n.id, cleared: false, firstSentAt: null },
      data: { firstSentAt: now, nextUpdateDueAt: nextUpdate(n.sendIntervalSec), pendingChanges: Prisma.DbNull },
    });
    if (claimed.count === 0) continue;
    const rule = n.ruleId ? rulesById.get(n.ruleId) : undefined;
    // The automation was disabled or deleted while the alert waited. Nothing
    // left to say it through; the alert itself stays as the record.
    if (!rule) continue;
    const ctx = (n.templateCtx ?? {}) as Record<string, string>;
    const members = (n.members ?? []) as unknown as AlertMember[];
    const reading = readingOf(n);
    pending.set(n.id, {
      kind: "fire",
      notificationId: n.id,
      rule,
      reading,
      ctx,
      actions: tierForSeverity(rule, n.severity).actions,
      severity: n.severity,
      count: activeMembers(members).length,
    });
    await logEvent({
      action: "notification.first_send_released",
      resourceType: "notification",
      resourceId: n.id,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: "info",
      message: `${rule.name}: first notification sent after the grouping hold — ${activeMembers(members).length} affected`,
      details: { ruleId: rule.id, members: activeMembers(members).map((m) => m.label) },
    });
  }

  const updates = await prisma.notification.findMany({
    where: {
      cleared: false,
      firstSentAt: { not: null },
      pendingChanges: { not: Prisma.DbNull },
      OR: [{ nextUpdateDueAt: null }, { nextUpdateDueAt: { lte: now } }],
    },
    select,
  });
  for (const n of updates) {
    // A send this pass already owns the alert (its first release just above).
    if (pending.has(n.id)) continue;
    const queued = n.pendingChanges as unknown as PendingGroupChanges | null;
    // Claimed by clearing the queue: an overlapping pass sees nothing to send.
    const claimed = await prisma.notification.updateMany({
      where: { id: n.id, cleared: false, pendingChanges: { not: Prisma.DbNull } },
      data: { pendingChanges: Prisma.DbNull, nextUpdateDueAt: nextUpdate(n.sendIntervalSec) },
    });
    if (claimed.count === 0) continue;
    const rule = n.ruleId ? rulesById.get(n.ruleId) : undefined;
    if (!rule || !queued?.changes?.length) continue;
    const members = (n.members ?? []) as unknown as AlertMember[];
    pending.set(n.id, {
      kind: "growth",
      notificationId: n.id,
      rule,
      reading: readingOf(n),
      ctx: (n.templateCtx ?? {}) as Record<string, string>,
      actions: tierForSeverity(rule, n.severity).actions,
      severity: n.severity,
      count: activeMembers(members).length,
      changes: queued.changes,
      ...(queued.reopenedFrom !== undefined ? { reopenedFrom: queued.reopenedFrom } : {}),
    });
  }
}

export async function drainPendingSends(pending: PendingSends): Promise<void> {
  // Business rule 75: a governed alert FIRES through its group, exactly as it
  // later escalates, reminds and resets through it. Without this the first
  // message went out on the member automation's own actions — and a member
  // with no notify action of its own (the normal shape inside a group) sent
  // nothing at all. One lookup for the pass, over only the grouped rules' sends.
  const grouped = [...pending.values()].filter((s) => s.rule.alertGroupId).map((s) => s.notificationId);
  const owners = await groupOwnersOf(grouped);
  for (const s of pending.values()) {
    const owner = owners.get(s.notificationId) ?? null;
    // An update says what changed. Applied to a COPY: `s.ctx` is the object
    // joinGroupAlert stored as the alert's templateCtx, which reminders and
    // escalations replay, and they must not repeat this update as news.
    const change = s.kind === "growth"
      ? describeGroupChanges(s.changes ?? [], s.reopenedFrom !== undefined ? { reopenedFrom: s.reopenedFrom } : {})
      : null;
    const ctx = change ? { ...s.ctx, "alert.change": change.sentence } : s.ctx;
    await enqueueAlertActions(
      s.notificationId, owner ? ownerActions(owner) : s.actions, ctx, s.rule, s.reading,
      s.kind === "growth" ? { growth: true, count: s.count, ...(change ? { change: change.subjectTag } : {}) } : undefined,
      owner,
    );
  }
}

export async function fire(
  rule: DbRule,
  reading: Reading,
  lastValue: number | null,
  now: Date,
  composite?: CompositeFireInfo,
  opts?: { severity?: string; actions?: AutomationAction[]; group?: GroupBuffer },
  /** Per-tier met-since runs to carry onto the firing row (banded rules). */
  bandMetSince?: Record<string, number> | null,
): Promise<void> {
  // Respect cooldown: if this (rule,asset,dim) fired within cooldownSec, skip.
  // Read only for a rule that has one (the column is dormant on every seeded
  // automation): a down-detection storm otherwise paid one state read per fire.
  if (rule.cooldownSec) {
    const existing = await prisma.notificationRuleState.findUnique({
      where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
      select: { firedAt: true },
    });
    if (existing?.firedAt && now.getTime() - existing.firedAt.getTime() < rule.cooldownSec * 1000) {
      return;
    }
  }
  // GROUPED (business rule 75): buffer the contribution and let
  // flushGroupFires do every write once it can see all of this tick's.
  //
  // The cooldown check above stays here deliberately — it is per (rule, asset,
  // dimension) suppression, i.e. about this one contribution, and remains
  // exactly as honest under grouping as it was before.
  //
  // Nothing is written here on purpose. Upserting the state row now would park
  // it `firing` with a null notificationId until the flush, and a row in that
  // shape is unreachable by every recovery path there is.
  if (opts?.group) {
    const forAsset = opts.group.get(reading.assetId) ?? [];
    forAsset.push({ reading, lastValue, severity: opts.severity ?? rule.severity, actions: opts.actions ?? rule.actions, bandMetSince: bandMetSince ?? null });
    opts.group.set(reading.assetId, forAsset);
    return;
  }
  const severity = opts?.severity ?? rule.severity;
  const actions = opts?.actions ?? rule.actions;
  // Fires are transition-guarded (rare), so the per-fire asset-detail lookup
  // is negligible even at 2000 assets — the hot evaluate path stays on the
  // tight SCOPE_SELECT.
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now, composite);
  parts.severity = severity; // band-resolved severity for the {severity} token
  // What happens if nobody acts. Resolved for the BAND-RESOLVED severity
  // above, not rule.severity, because a band declares its own escalation
  // chain — a critical alert must not advertise the warning tier's.
  applyFollowUpPolicy(parts, rule, severity);
  // Business rule 78 — a dependency reading names who silenced the device.
  // The walk is bounded and memoized per tick; a failed read still lets the
  // alert out, worded without a name, because "your PLC is dependency down"
  // beats silence even when the switch cannot be named.
  let blame: Awaited<ReturnType<typeof resolveDependencyBlame>> = null;
  if (reading.dependencyDown && reading.assetId) {
    blame = await resolveDependencyBlame(reading.assetId, _blameCache);
    const rootIsUpstream = !blame || blame.rootCause.id === blame.upstream.id;
    parts.dependency = {
      upstream: blame?.upstream.hostname ?? blame?.upstream.id ?? null,
      rootCause: rootIsUpstream ? null : (blame!.rootCause.hostname ?? blame!.rootCause.id),
      reason: blame?.rootCause.reason ?? null,
    };
    // The headline is the dependency, not "Monitor status is down": the
    // device's own probe did not decide this alert.
    parts.triggerSummary = dependencyTriggerSummary(parts.dependency);
  }
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  // State a sensor reading in the install's display unit, so the sentence
  // agrees with the chart drawn underneath it in the email.
  await applySensorUnitToSummary(rule, reading, ctx);
  const message = renderMessage(rule, reading, ctx);
  ctx["message"] = message;
  // Business rule 78a — a dependency-down alert raised after its root cause's
  // own down alert was acknowledged is born acknowledged, with that note. It
  // still DELIVERS (the plant still needs telling); the acknowledgement is
  // what keeps its reminders and acknowledge-stopped escalation quiet.
  const rootCauseId = reading.dependencyDown ? inheritableRootCauseId(blame) : null;
  // Business rule 78b — a plain down alert on a device whose outage another
  // down automation's alert already acknowledged (a down automation created
  // mid-outage, one whose hold finished later) is born acknowledged too, so a
  // new automation never makes an owned outage read as unowned again. Like
  // 78a it still delivers; the acknowledgement keeps reminders and
  // acknowledge-stopped escalation quiet.
  const sameAssetDown = !reading.dependencyDown && !!reading.assetId && isDownDetectionTrigger(rule.trigger);
  const inheritedAck: InheritedAck | null = rootCauseId
    ? await rootCauseAckFor(rootCauseId)
    : sameAssetDown ? await sameAssetDownAckFor(reading.assetId, rule.id) : null;
  const notif = await prisma.notification.create({
    data: {
      ruleId: rule.id,
      assetId: reading.assetId || null,
      assetHostname: reading.hostname,
      severity,
      message,
      regionTags: regionSnapshot(reading.tags),
      // The dimension this alert is ABOUT — the same key the state row uses.
      // For a hardware-sensor automation that's the bare sensor name, which is
      // what lets the alert email chart THAT sensor at delivery time, long
      // after this reading is gone. "" for whole-device and composite fires.
      dimension: reading.dimKey || null,
      // Which metric fired — the email leads with the chart that explains THIS
      // alert (alertChartService.chartTokenForMetric).
      metric: rule.trigger.type === "asset_metric" || rule.trigger.type === "host_metric"
        ? rule.trigger.metric
        // A state alert fires on a FIELD; same column, same purpose — it is
        // what the email leads with (monitorStatus → the probe history).
        : rule.trigger.type === "asset_state" ? rule.trigger.field : null,
      ...(ruleWantsContext(rule) ? { templateCtx: ctx as any } : {}),
      // Business rule 78 — the flavour, and who silenced it, on the row itself
      // (the sweep, the handoff and the badge all read it; none can read text).
      ...(reading.dependencyDown ? {
        dependencyDown: true,
        dependencyBlame: {
          upstream: blame ? { id: blame.upstream.id, hostname: blame.upstream.hostname } : null,
          rootCause: blame ? { id: blame.rootCause.id, hostname: blame.rootCause.hostname, reason: blame.rootCause.reason } : null,
          // Every device between them, upstream first — what the email's
          // dependency-path diagram draws (alertDependencyPathService), so the
          // picture agrees with the sentence written here even hours later.
          chain: blame ? blame.chain.map((n) => ({ id: n.id, hostname: n.hostname, reason: n.reason })) : [],
          hops: blame?.hops ?? 0,
          truncated: blame?.truncated ?? false,
          ownStatus: reading.ownMonitorStatus ?? null,
        } as Prisma.InputJsonValue,
      } : {}),
      ...(inheritedAck ? inheritedAckData(inheritedAck, now) : {}),
    },
  });
  await prisma.notificationRuleState.upsert({
    where: { ruleId_assetId_dimensionKey: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey } },
    create: { ruleId: rule.id, assetId: reading.assetId, dimensionKey: reading.dimKey, state: "firing", firedAt: now, lastValue, notificationId: notif.id, firingSeverity: severity, bandMetSince: metSinceJson(bandMetSince) },
    update: { state: "firing", firedAt: now, lastValue, notificationId: notif.id, conditionMetSince: null, recoveredSince: null, firingSeverity: severity, bandMetSince: metSinceJson(bandMetSince) },
  });
  await enqueueAlertActions(notif.id, actions, ctx, rule, reading);
  // Every fire is on the record (business rule 146): the audit Event is the
  // engine's own, as the escalation and end Events are — no action gates it.
  // (An event/change automation's alerts come from the event tail, which
  // writes none: one would feed its own trigger.)
  {
    await logEvent({
      action: "notification.triggered",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(severity),
      message: notif.message,
      details: {
        ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey, severity,
        ...(reading.dependencyDown ? {
          dependencyDown: true,
          upstreamAssetId: blame?.upstream.id ?? null,
          rootCauseAssetId: blame?.rootCause.id ?? null,
        } : {}),
      },
    });
  }
  // An acknowledgement nobody typed on THIS row is still an acknowledgement on
  // the record — unconditionally, not as a removable action.
  if (inheritedAck) {
    await logEvent({
      action: "notification.acknowledged",
      resourceType: "notification",
      resourceId: notif.id,
      resourceName: rule.name,
      actor: "system:notification-engine",
      message: rootCauseId
        ? `${reading.hostname ?? "Device"}: dependency-down alert raised acknowledged — its root cause ${inheritedAck.hostname ?? inheritedAck.assetId} was already acknowledged${inheritedAck.acknowledgedBy ? ` by ${inheritedAck.acknowledgedBy}` : ""}`
        : `${reading.hostname ?? "Device"}: down alert raised acknowledged — this outage was already acknowledged${inheritedAck.acknowledgedBy ? ` by ${inheritedAck.acknowledgedBy}` : ""} on another automation's alert`,
      details: { ids: [notif.id], count: 1, hasNote: !!inheritedAck.acknowledgeNote, inheritedFrom: [inheritedAck.notificationId] },
    });
  }
}

/** A firing alert crossed into a different band. Update its severity + message,
 *  re-notify per policy (increase always if onIncrease; decrease if onDecrease),
 *  and reset the escalation timer so the new band's escalation starts fresh. */
export async function applyBandTransition(
  rule: DbRule,
  reading: Reading,
  st: { id: string; notificationId: string | null; firingSeverity: string | null; dimensionKey?: string },
  newSeverity: string,
  now: Date,
  /** Per-tier met-since runs as of this tick (banded rules). */
  bandMetSince?: Record<string, number> | null,
): Promise<void> {
  const prevRank = severityRank(st.firingSeverity ?? rule.severity);
  const increased = severityRank(newSeverity) > prevRank;
  const policy = bandNotifyOf(rule);
  const tier = tierForSeverity(rule, newSeverity);

  // GROUPED ALERTS (business rule 75). A band change belongs to ONE
  // contribution; the alert carries the worst of all of them. So the member
  // half below always runs, and the alert is only rewritten — and only
  // re-notified, and its escalation clock only restarted — when the GROUP's
  // severity actually moved. Without the split, one port flapping between two
  // bands would restart the paging clock for the other seven every time.
  if (ruleGroupsByAsset(rule) && st.notificationId) {
    await prisma.notificationRuleState.update({
      where: { id: st.id },
      data: {
        firingSeverity: newSeverity,
        lastValue: typeof reading.value === "number" ? reading.value : null,
        recoveredSince: null,
        ...(bandMetSince !== undefined ? { bandMetSince: metSinceJson(bandMetSince) } : {}),
      },
    });
    await reconcileGroupSeverity(rule, reading, st.notificationId, st.dimensionKey ?? reading.dimKey, newSeverity, now, policy);
    return;
  }

  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const parts = readingContextParts(rule, reading, now);
  parts.severity = newSeverity;
  applyFollowUpPolicy(parts, rule, newSeverity);
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  // State a sensor reading in the install's display unit, so the sentence
  // agrees with the chart drawn underneath it in the email.
  await applySensorUnitToSummary(rule, reading, ctx);
  const message = renderMessage(rule, reading, ctx);
  ctx["message"] = message;

  // Update the live alert in place (one alert per asset). Reset the escalation
  // progress and stamp bandSince so the new band's escalation timers restart
  // from band-entry (the sweep measures tier delays from bandSince ?? triggeredAt).
  if (st.notificationId) {
    await prisma.notification.updateMany({
      where: { id: st.notificationId, cleared: false },
      data: { severity: newSeverity, message, escalationState: { tiers: {}, bandSince: now.toISOString() } as any, ...(ruleWantsContext(rule) ? { templateCtx: ctx as any } : {}) },
    });
  }
  await prisma.notificationRuleState.update({
    where: { id: st.id },
    data: {
      firingSeverity: newSeverity,
      lastValue: typeof reading.value === "number" ? reading.value : null,
      recoveredSince: null,
      ...(bandMetSince !== undefined ? { bandMetSince: metSinceJson(bandMetSince) } : {}),
    },
  });

  if ((increased && policy.onIncrease) || (!increased && policy.onDecrease)) {
    if (st.notificationId) await enqueueAlertActions(st.notificationId, tier.actions, ctx, rule, reading);
    await logEvent({
      action: increased ? "notification.escalated" : "notification.deescalated",
      resourceType: "notification",
      resourceId: st.notificationId ?? undefined,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(newSeverity),
      message,
      details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: reading.dimKey, severity: newSeverity, from: st.firingSeverity },
    }).catch(() => {});
  }
}

/**
 * Keep a live memory-forecast alert's countdown current. The alert fires once,
 * but "Days until Serious: 6" is a statement about TODAY — while the trend
 * holds, tomorrow it is 5, and a reminder, the in-app card and the alert list
 * must say so. Nothing else on a steadily-firing alert changes, so the engine's
 * ordinary "already active; suppress" path left the fire-time number in place
 * for the life of the alert.
 *
 * In place, like a band change, but QUIET: no re-notify, no escalation reset, no
 * Event (nothing about the alert changed state). One `findMany` over the
 * forecast rule's live alerts per tick, and a rebuild + write only for an
 * alert whose level or whole-day count actually moved, which is about once
 * a day per alert. Grouped alerts (business rule 75) are left to their own
 * member bookkeeping and keep the fire-time countdown.
 */
export async function refreshForecastCountdowns(
  rule: DbRule,
  live: Array<{ st: { id: string; notificationId: string | null; firingSeverity: string | null }; reading: Reading }>,
  now: Date,
): Promise<void> {
  if (rule.trigger.type !== "asset_metric") return;
  const ids = live.map((l) => l.st.notificationId).filter((x): x is string => !!x);
  if (!ids.length) return;
  const rows = await prisma.notification.findMany({
    where: { id: { in: ids }, cleared: false, groupKey: null },
    select: { id: true, severity: true, message: true, templateCtx: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const levels = forecastLevelsOf(rule.trigger, rule.severity, rule.severityBands);
  for (const { st, reading } of live) {
    const notif = st.notificationId ? byId.get(st.notificationId) : undefined;
    if (!notif || !reading.forecast) continue;
    const stored = (notif.templateCtx ?? null) as Record<string, string> | null;
    if (!forecastCountdownMoved(stored, { ...reading.forecast, levels }, notif.severity)) continue;
    const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
    const parts = readingContextParts(rule, reading, now);
    parts.severity = notif.severity;
    applyFollowUpPolicy(parts, rule, notif.severity);
    const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
    await applySensorUnitToSummary(rule, reading, ctx);
    const message = renderMessage(rule, reading, ctx);
    ctx["message"] = message;
    // The snapshot is ALWAYS written for a forecast, even on a rule that would
    // not otherwise keep one (ruleWantsContext): it is where the countdown
    // shown last is remembered, so the next tick's comparison costs no rebuild.
    await prisma.notification.updateMany({
      where: { id: notif.id, cleared: false },
      data: { message, templateCtx: ctx as any },
    });
  }
}

/**
 * Has a live forecast alert's countdown moved since it was last rendered? The
 * stored snapshot's `forecast.level` / `forecast.days` against what the trend
 * says now. A snapshot without them (an alert from before countdowns were kept
 * current, or a rule that stored none) counts as moved, once. Pure.
 */
export function forecastCountdownMoved(
  stored: Record<string, string> | null,
  forecast: { usedPct: number; slopePerDay: number; levels: ForecastLevel[] },
  severity: string,
): boolean {
  const now = forecastCountdown(forecast, severity);
  // No countdown to show (the trend stopped growing). The reading then goes
  // null and the ordinary recovery path ends the alert; nothing to rewrite.
  if (!now) return false;
  if (!stored || stored["forecast.days"] == null) return true;
  return stored["forecast.days"] !== now.days || stored["forecast.level"] !== now.level;
}

/**
 * Fold a contribution's new severity into its grouped alert.
 *
 * The alert's severity is the worst of what is still wrong, so a contribution
 * climbing raises it, one easing lowers it only if it held the top alone, and
 * a move that changes neither writes the member set and stops — keeping the
 * hot path transition-only, which is the property the whole engine is built on.
 */
async function reconcileGroupSeverity(
  rule: DbRule,
  reading: Reading,
  notificationId: string,
  dimensionKey: string,
  memberSeverity: string,
  now: Date,
  policy: ReturnType<typeof bandNotifyOf>,
): Promise<void> {
  const row = await prisma.notification.findFirst({
    where: { id: notificationId, cleared: false },
    select: { id: true, members: true, severity: true, firstSendDueAt: true, firstSentAt: true },
  });
  if (!row) return;
  const held = firstSendHeld(row);

  const members = ((row.members ?? []) as unknown as AlertMember[]).map((m) =>
    memberMatches(m, rule.id, dimensionKey, reading.assetId) && !m.leftAt ? { ...m, severity: memberSeverity } : m,
  );
  const groupSev = groupSeverity(members, rule.severity);
  const changed = groupSev !== row.severity;

  if (!changed) {
    // The alert is still as severe as it was — a worse contribution is holding
    // it there. Record the member's own band and say nothing.
    await prisma.notification.updateMany({
      where: { id: notificationId, cleared: false },
      data: { members: members as unknown as Prisma.InputJsonValue },
    });
    return;
  }

  const increased = severityRank(groupSev) > severityRank(row.severity);
  const tier = tierForSeverity(rule, groupSev);
  const detail = groupWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  // A multi-device alert's true size, as at fire (the members stop at 64).
  const counts = members.some((m) => m.assetId) ? await spanCounts(rule, notificationId, []) : null;
  const parts = readingContextParts(rule, reading, now, undefined, members, counts);
  parts.severity = groupSev;
  applyFollowUpPolicy(parts, rule, groupSev);
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  await applySensorUnitToSummary(rule, reading, ctx);
  const message = renderMessage(rule, reading, ctx, members, counts);
  ctx["message"] = message;

  await prisma.notification.updateMany({
    where: { id: notificationId, cleared: false },
    data: {
      members: members as unknown as Prisma.InputJsonValue,
      severity: groupSev,
      message,
      // The new band's escalation timers restart from band entry — but only
      // because the ALERT changed band, never because one component did.
      escalationState: { tiers: {}, bandSince: now.toISOString() } as any,
      ...(groupWantsContext(rule) || held ? { templateCtx: ctx as any } : {}),
    },
  });

  // Still holding its first send: the band change rides that first message
  // (it is built from the alert as it stands then), so saying it now would be
  // news about an alert nobody has been told of.
  if (held) return;

  if ((increased && policy.onIncrease) || (!increased && policy.onDecrease)) {
    // WHETHER to say so is the member's band policy; WHO hears it is the owner's.
    const owner = await groupOwnerOf(rule, notificationId);
    await enqueueAlertActions(notificationId, owner ? ownerActions(owner) : tier.actions, ctx, rule, reading, undefined, owner);
    await logEvent({
      action: increased ? "notification.escalated" : "notification.deescalated",
      resourceType: "notification",
      resourceId: notificationId,
      resourceName: rule.name,
      actor: "system:notification-engine",
      level: severityLevel(groupSev),
      message,
      details: { ruleId: rule.id, assetId: reading.assetId || null, dimension: dimensionKey, severity: groupSev, from: row.severity, grouped: true },
    }).catch(() => {});
  }
}

/** Resolved (below tier 0): optionally send an all-clear before recovering. */
export async function fireResolved(
  rule: DbRule,
  reading: Reading,
  st: { id: string; notificationId: string | null; firingSeverity: string | null; ruleId?: string; dimensionKey?: string },
  now: Date,
): Promise<void> {
  const policy = bandNotifyOf(rule);
  if (!policy.onResolved || !st.notificationId) return;
  // GROUPED ALERTS (business rule 75): the banded twin of recover()'s guard.
  // "Resolved" is a statement about the ALERT, and on a grouped one a middle
  // contribution recovering resolves nothing — seven ports are still faulted.
  // Guarded here rather than at the four call sites so no future one can
  // forget; the extra count runs on a recovery transition, and only for a rule
  // that groups.
  if (await stillFiringElsewhere(st, rule)) return;
  // Never announced (still holding its first send): there is nothing to resolve.
  if (ruleGroupsByAsset(rule) && await neverAnnounced(st.notificationId)) return;
  // A group has no bands and no band policy of its own, so the member's policy
  // still decides whether "Resolved" is sent — but "reuse" means reuse the
  // alert's OWN recipients, and on a governed alert those are the group's.
  // "dedicated" names actions the operator wrote for exactly this and stays.
  const owner = policy.resolvedMode === "dedicated" ? null : await groupOwnerOf(rule, st.notificationId);
  const actions = policy.resolvedMode === "dedicated"
    ? policy.resolvedActions
    : owner ? ownerActions(owner) : tierForSeverity(rule, st.firingSeverity ?? rule.severity).actions;
  if (!actions.length) return;
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const view = await allClearView(rule, st.notificationId, reading);
  const parts = readingContextParts(rule, view.reading, now, undefined, view.members, view.counts);
  parts.severity = "resolved";
  parts.conditionSuffix = recoveredConditionSuffix(parts.conditionSuffix);
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  setRecoverySentence(ctx, `Resolved: ${ctx["rule"] || rule.name} — ${ctx["asset"] ?? view.reading.hostname ?? ""} recovered`);
  await enqueueAlertActions(st.notificationId, actions, ctx, rule, reading, undefined, owner);
}

/**
 * Run the automation's RESET actions — "the alert ended, tell someone".
 *
 * Called BEFORE the notification is cleared, exactly like fireResolved: the
 * actions attach to the still-live notification id, so their delivery rows
 * (and the acknowledge tokens minted for them) hang off the alert they are
 * about rather than orphaning.
 *
 * `reason` names how it ended — the recovery message says so, because "it's
 * back" and "someone gave up and cleared it" are different facts.
 */
/**
 * A minimal Reading for a reset that has no live reading behind it — a timed
 * clear fires precisely because the condition stopped being observed, and the
 * asset may have gone silent entirely. `lastValue` is the last thing we saw,
 * which is the honest value for a recovery message.
 */
export function readingFromState(st: { assetId: string | null; dimensionKey: string; lastValue?: number | null }): Reading {
  return {
    assetId: st.assetId ?? "",
    hostname: null,
    tags: [],
    dimKey: st.dimensionKey,
    dimLabel: st.dimensionKey,
    value: st.lastValue ?? null,
  };
}

/**
 * The reset actions an alert's recovery actually runs (business rule 145) —
 * `expandResetActions` over the owner's list, reading the alert's fired tiers
 * only when some reset action asks for an escalation reset (one indexed read,
 * once per alert, never per tick).
 */
async function resetActionsToRun(
  carrier: RuleActionCarrier & { severity: string },
  notificationId: string,
): Promise<AutomationAction[]> {
  const wantsFired = (carrier.resetActions ?? []).some((a) => a.type === "notify" && !!a.resetEscalation);
  const fired = wantsFired
    ? parseEscalationFired((await prisma.notification.findUnique({ where: { id: notificationId }, select: { escalationFired: true } }))?.escalationFired)
    : [];
  return expandResetActions(carrier, fired);
}

export async function fireReset(
  rule: DbRule,
  reading: Reading,
  st: { notificationId: string | null },
  reason: string,
  now: Date,
): Promise<void> {
  if (!st.notificationId) return;
  // A grouped alert that ended while still holding its first send was never
  // announced, so its reset actions — a "Resolved" email, a ticket closed —
  // would answer something nobody was told (business rule 75).
  if (ruleGroupsByAsset(rule) && await neverAnnounced(st.notificationId)) return;
  // A governed alert's reset actions are its GROUP's (business rule 75), the
  // same answer runResetActionsForCleared gives for an operator's Clear.
  const owner = await groupOwnerOf(rule, st.notificationId);
  if (!(owner ? owner.resetActions : rule.resetActions)?.length) return;
  // Matched rows follow their trigger action live, and an escalation reset
  // adds the tiers that sent for THIS alert (business rule 145).
  const actions = await resetActionsToRun(owner ?? rule, st.notificationId);
  if (!actions.length) return;
  const detail = ruleWantsAssetDetail(rule) && reading.assetId ? await assetDetail(reading.assetId) : null;
  const view = await allClearView(rule, st.notificationId, reading);
  const parts = readingContextParts(rule, view.reading, now, undefined, view.members, view.counts);
  // "resolved" is a pseudo-severity (not in SEVERITIES) that colours the email
  // green and reads correctly in a subject line — the same one fireResolved
  // uses for a severity-band recovery. The problem in the subject flips with
  // it: "Truck Scale Central is up · 1 device", not "… is down".
  parts.severity = "resolved";
  parts.conditionSuffix = recoveredConditionSuffix(parts.conditionSuffix);
  const ctx = buildTemplateContext({ ...parts, assetDetail: detail });
  setRecoverySentence(ctx, `Resolved: ${ctx["rule"] || rule.name} — ${ctx["asset"] || view.reading.hostname || "device"} ${reason}`);
  await enqueueAlertActions(st.notificationId, actions, ctx, rule, reading, undefined, owner);
}

/**
 * What an all-clear is ABOUT: the alert as it was announced, so the "Resolved"
 * subject reads as the same alert the fire did. Two shapes went wrong without
 * it:
 *  - a GROUPED alert built its subject from the one contribution whose recovery
 *    ended it — "[RESOLVED] GRYCRT-S2212 · RGILink Auth — Path Monitor"
 *    answering "[WARNING] RGILink Auth · 1 device — Path Monitor";
 *  - a reset with no live reading (a timed clear, `readingFromState`) has no
 *    hostname and only the raw dimension key, so {asset} fell back to the
 *    asset's id and {dimension} to "hc|link".
 *
 * On a grouped alert every member counts, departed or not: by now the last one
 * has been marked left (releaseGroupMember runs first), and the alert being
 * closed covered all of them. The counts come from the same snapshot because no
 * state row is firing any more. One indexed read per all-clear, which happens
 * once per alert, never per tick.
 */
async function allClearView(
  rule: DbRule,
  notificationId: string,
  reading: Reading,
): Promise<{ reading: Reading; members: AlertMember[] | null; counts: SpanCounts | null }> {
  // Best-effort: a failed read names the alert from the reading, as before,
  // rather than losing the all-clear.
  const row = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { members: true, assetHostname: true, templateCtx: true },
  }).catch((err: unknown) => {
    logger.debug({ err: (err as Error)?.message, notificationId }, "all-clear alert lookup failed — naming it from the reading");
    return null;
  });
  if (!row) return { reading, members: null, counts: null };
  // The fire's own component label, when it snapshotted one — the state row
  // only knows the key ("port12", not "port12 (AP-1)").
  const snap = row.templateCtx && typeof row.templateCtx === "object" ? row.templateCtx as Record<string, unknown> : null;
  const firedLabel = typeof snap?.["dimension"] === "string" ? snap["dimension"] as string : "";
  const fromState = !reading.hostname && reading.dimLabel === reading.dimKey;
  const view: Reading = {
    ...reading,
    hostname: reading.hostname || row.assetHostname,
    ...(fromState && firedLabel ? { dimLabel: firedLabel } : {}),
  };
  if (!ruleGroupsByAsset(rule)) return { reading: view, members: null, counts: null };
  const members = ((row.members ?? []) as unknown as AlertMember[]).map(({ leftAt: _left, ...m }) => m);
  if (!members.length) return { reading: view, members: null, counts: null };
  const counts = members.some((m) => m.assetId)
    ? await countSpan(rule, members.map((m) => ({ ruleId: m.ruleId, assetId: m.assetId ?? null, key: m.key })))
    : null;
  return { reading: view, members, counts };
}

/**
 * Re-render `{trigger.summary}` for a hardware-sensor reading with the sensor's
 * own unit, converted to the install's display unit. Sensor readings are the
 * one metric whose unit isn't knowable from the metric alone (a "hardware
 * sensor value" is °C on one row and RPM on the next), and the email states the
 * value right above a chart that already converts.
 *
 * Best-effort: any failure leaves the unit-less sentence the context already
 * has.
 */
async function applySensorUnitToSummary(
  rule: DbRule,
  reading: Reading,
  ctx: Record<string, string>,
): Promise<void> {
  const t = rule.trigger;
  if (t.type !== "asset_metric" || t.metric !== "hwSensorValue") return;
  if (!reading.assetId || !reading.dimKey) return;
  const shown = await sensorReadingDisplay(reading.assetId, reading.dimKey, reading.value);
  ctx["trigger.summary"] = triggerSummary({
    trigger: t as never,
    value: shown.value,
    dimensionLabel: reading.dimLabel || null,
    sensorUnit: shown.unit,
  });
  if (shown.value !== null && shown.value !== undefined) ctx["value"] = String(shown.value);
}

export async function recover(
  rule: DbRule,
  st: ReleasableState,
  reading?: Reading,
  now?: Date,
): Promise<void> {
  // "condition" recovers like "auto": the reset tree (or trigger negation)
  // observed a real recovery, so clear the notification + stamp the event.
  if (rule.reset.mode === "auto" || rule.reset.mode === "condition") {
    // GROUPED ALERTS (business rule 75). Ask FIRST whether this contribution
    // was the last one, because everything below is about ending the alert —
    // and on a grouped alert a middle contribution recovering ends nothing.
    //
    // This ordering is the whole feature. `fireReset` runs before the clear so
    // its delivery rows can hang off a live notification id; left where it
    // was, the first of eight ports to come back would have mailed the alert's
    // "Resolved" while seven were still faulted.
    const { last } = await releaseGroupMember(st, rule, now ?? new Date());
    if (!last) {
      // Release this contribution's own row and leave the alert standing. Its
      // member list, count, severity and text have already been rewritten to
      // stop claiming this component is affected.
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS } });
      return;
    }
    // Reset actions run BEFORE the clear, while the notification id is still
    // live for their delivery rows to hang off. The manual/timed branch below
    // deliberately doesn't: manual leaves the alert standing for a human, and
    // timed fires its own reset from the sweep that actually clears it.
    if (reading && now) await fireReset(rule, reading, st, "recovered", now);
    await clearAlertRow(st, "system:auto-resolve");
    await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS } });
    await logEvent({
      action: "notification.auto_cleared",
      resourceType: "notification",
      resourceId: st.notificationId ?? undefined,
      resourceName: rule.name,
      actor: "system:notification-engine",
      message: `Auto-resolved: ${rule.name} condition recovered`,
      details: { ruleId: rule.id, assetId: st.assetId || reading?.assetId || null, dimension: st.dimensionKey ?? null },
    });
  } else {
    // manual / timed: re-arm the state but leave the notification for a human
    // (timed is swept by the timer pass; manual stays until cleared).
    if (rule.reset.mode === "manual") {
      // Still release the contribution: the alert stays up for a person to
      // deal with, but it must stop naming a component that has recovered.
      await releaseGroupMember(st, rule, now ?? new Date());
      await prisma.notificationRuleState.update({ where: { id: st.id }, data: { state: "clear", conditionMetSince: null, recoveredSince: null, notificationId: null, bandMetSince: Prisma.DbNull, ...CLEARED_RUNS } });
    }
  }
}

/** The state-row fields a release needs: which contribution is letting go. */
type ReleasableState = {
  id: string;
  ruleId?: string;
  dimensionKey?: string;
  notificationId: string | null;
  /** Rides the clear / member-recovered Event so it lands on the asset's
   *  Events tab (Event.assetId). Every caller passes a full state row. */
  assetId?: string | null;
};

/**
 * End this contribution's part in its alert — and the alert itself, but ONLY if
 * nothing else is still firing against it.
 *
 * This is the one chokepoint every clear path goes through: auto-recovery, the
 * timed sweeps, the carve-out handoff, the device-down handoff and the
 * vanished-state sweep. That matters more than it looks: none of those read
 * `Notification.ruleId`, but every one of them used to carry the same 1:1
 * assumption through `NotificationRuleState.notificationId`, so under grouping
 * any one of eight ports recovering would have ended the alert for all eight.
 *
 * `rule` is what keeps this free for everyone else: an ungrouped rule
 * short-circuits with NO extra query and behaviour byte-identical to before.
 */
export async function clearActiveNotification(
  st: ReleasableState,
  by: string,
  /** The rule this state row belongs to. Omitted only by a caller that has
   *  none, which by definition cannot be grouped. */
  rule?: DbRule,
): Promise<void> {
  if (!st.notificationId) return;
  const { last } = await releaseGroupMember(st, rule, new Date());
  // A contribution that was not the last one leaves the alert standing. The
  // alert's own text has already been rewritten to stop claiming this
  // component is still faulted.
  if (!last) return;
  await clearAlertRow(st, by);
}

/** Is any OTHER contribution still firing against this alert?
 *
 *  False with no query at all for an ungrouped rule — the contribution IS the
 *  alert there, so nothing else can be firing against it. */
export async function stillFiringElsewhere(
  st: { id: string; notificationId: string | null },
  rule: DbRule,
): Promise<boolean> {
  if (!st.notificationId || !ruleGroupsByAsset(rule)) return false;
  const others = await prisma.notificationRuleState.count({
    where: { notificationId: st.notificationId, state: "firing", id: { not: st.id } },
  });
  return others > 0;
}

/** Soft-clear the alert row itself. Split out of clearActiveNotification so a
 *  caller that has ALREADY released its contribution (recover, which must know
 *  whether it was the last one before it decides to send an all-clear) can end
 *  the alert without releasing twice. */
export async function clearAlertRow(st: { notificationId: string | null }, by: string): Promise<void> {
  if (!st.notificationId) return;
  await prisma.notification.updateMany({
    where: { id: st.notificationId, cleared: false },
    data: { cleared: true, clearedBy: by, clearedAt: new Date() },
  });
}

/**
 * Stamp this contribution as departed and answer whether it was the last one.
 *
 * The count is asked of the STATE ROWS, never of the members snapshot: the
 * snapshot is written for rendering and can lag, and a stale one would either
 * strand an alert nothing can clear or end one that is still firing. Note the
 * WHERE carries no ruleId — "is anything else still firing against this alert?"
 * is the right question whether the contributions came from one automation or
 * several.
 */
async function releaseGroupMember(
  st: ReleasableState,
  rule: DbRule | undefined,
  now: Date,
): Promise<{ last: boolean }> {
  // Not a grouped alert: the contribution IS the alert. Zero queries.
  if (!st.notificationId || !rule || !ruleGroupsByAsset(rule)) return { last: true };

  const others = await prisma.notificationRuleState.count({
    where: { notificationId: st.notificationId, state: "firing", id: { not: st.id } },
  });

  const row = await prisma.notification.findFirst({
    where: { id: st.notificationId, cleared: false },
    select: { id: true, members: true, firstSendDueAt: true, firstSentAt: true, sendIntervalSec: true, pendingChanges: true, templateCtx: true },
  });
  if (row) {
    const before = (row.members ?? []) as unknown as AlertMember[];
    const departing = before.find((m) => !m.leftAt && memberMatches(m, st.ruleId ?? rule.id, st.dimensionKey ?? "", st.assetId));
    const members = markMemberLeft(
      (row.members ?? []) as unknown as AlertMember[],
      st.ruleId ?? rule.id,
      st.dimensionKey ?? "",
      now,
      st.assetId,
    );
    const remaining = activeMembers(members);
    // On the LAST release we leave the text alone: the alert is about to be
    // cleared, and a message rewritten to name nothing at all would be the
    // last thing the history shows.
    if (others > 0) {
      const severity = groupSeverity(members, rule.severity);
      const primary = primaryMember(members);
      // A multi-device alert's true size, from the state rows (the members stop
      // at MAX_GROUP_MEMBERS). One indexed query, only on such an alert.
      const counts = members.some((m) => m.assetId) ? await spanCounts(rule, st.notificationId, [], st.id) : null;
      const message = regroupedMessage(rule, members, counts);
      // Paced (business rule 75): the recovery is news for the next update —
      // queued, and the stored context refreshed so that update names the
      // alert as it now stands. Held: the first send will simply not name it.
      const paced = !firstSendHeld(row) && row.sendIntervalSec != null;
      const queued = paced && departing
        ? queueGroupChanges(row.pendingChanges, [{ label: departing.label || departing.key, kind: "recovered" }])
        : null;
      const ctx = paced && row.templateCtx && typeof row.templateCtx === "object"
        ? refreshMemberContext(row.templateCtx as Record<string, string>, members, message, counts)
        : null;
      await prisma.notification.updateMany({
        where: { id: st.notificationId, cleared: false },
        data: {
          members: members as unknown as Prisma.InputJsonValue,
          dimensionCount: remaining.length,
          severity,
          dimension: primary?.key || null,
          ...(message === null ? {} : { message }),
          ...(queued ? { pendingChanges: queued as unknown as Prisma.InputJsonValue } : {}),
          ...(ctx ? { templateCtx: ctx as any } : {}),
        },
      });
      await logEvent({
        action: "notification.member_recovered",
        resourceType: "notification",
        resourceId: st.notificationId,
        resourceName: rule.name,
        actor: "system:notification-engine",
        message: `${rule.name}: ${
          members.find((m) => m.assetId && memberMatches(m, st.ruleId ?? rule.id, st.dimensionKey ?? "", st.assetId))?.label
          || st.dimensionKey || "a component"
        } recovered — ${remaining.length} still affected`,
        details: { ruleId: rule.id, assetId: st.assetId || null, dimension: st.dimensionKey ?? null, remaining: remaining.length },
      }).catch(() => {});
    } else {
      // Last one out: keep the departure in the snapshot so the cleared alert
      // still renders everything it covered.
      await prisma.notification.updateMany({
        where: { id: st.notificationId, cleared: false },
        data: { members: members as unknown as Prisma.InputJsonValue, dimensionCount: 0 },
      });
    }
  }
  return { last: others === 0 };
}

/**
 * The message for a grouped alert whose membership just shrank, or null to
 * leave the existing one alone.
 *
 * Null for a CUSTOM template, deliberately. Re-rendering one here would mean
 * rebuilding a full template context from a recovery that carries no reading —
 * no {value}, no {threshold}, no {metric} — and a sentence the operator wrote
 * would come back with half its tokens blanked. The stale component list is
 * the smaller lie, and every other surface (the member list, the count, the
 * severity) is refreshed around it.
 */
function regroupedMessage(rule: DbRule, members: AlertMember[], counts: SpanCounts | null = null): string | null {
  if (rule.messageTemplate && rule.messageTemplate.trim()) return null;
  const active = activeMembers(members);
  const list = renderMemberList(members);
  if (!list) return null;
  const count = active.length === 1 ? "" : ` (${active.length})`;
  const subnet = members.find((m) => m.subnet)?.subnet;
  const component = members.find((m) => m.component)?.component;
  const group = members.find((m) => m.group)?.group;
  const devices = countNoun(counts?.devices ?? new Set(active.map((m) => m.assetId)).size, "device");
  if (group && counts) {
    // A whole-group alert names its true size, which the capped list cannot —
    // and says what is wrong when every automation in it agrees (renderMessage).
    const what = wholeGroupSubject(counts);
    if (counts.pathOnly && counts.condition) {
      return `${what} ${counts.checks === 1 ? counts.condition.one : counts.condition.many} from ${devices} — ${list}`;
    }
    const name = counts.automations > 1 ? group : rule.name;
    return `${name}: ${what ? `${what} · ` : ""}${countNoun(counts.devices, "device")} still affected — ${list}`;
  }
  const phrase = component && members.some((m) => m.assetId) ? pathConditionPhrase(rule.trigger as never) : null;
  if (component && phrase) return `${component} ${phrase} from ${devices} — ${list}`;
  const where = subnet ? `${subnet} — ` : component ? `${component} — ` : "";
  return `${rule.name}: ${where}${list}${count} still affected`;
}

/**
 * Business rule 78 — end a live alert whose flavour no longer matches its
 * asset's suppression flag, so the caller can raise the other flavour. Same
 * handoff contract as the carve-out and the packet-loss handoffs: soft-clear,
 * release the state row, audit it, run NO reset actions.
 */
export async function handoffDependencyFlavour(
  rule: DbRule,
  st: ReleasableState & { assetId: string | null },
  toDependencyDown: boolean,
): Promise<void> {
  const reason = toDependencyDown ? "dependency-down" : "dependency-released";
  await clearActiveNotification(st, `system:${reason}`, rule);
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
    message: toDependencyDown
      ? `Cleared: ${rule.name} — the device turned dependency-down, so the alert is raised again naming the upstream device`
      : `Cleared: ${rule.name} — the upstream device is back and the device is still down, so the alert is raised again as its own outage`,
    details: { ruleId: rule.id, assetId: st.assetId, reason },
  }).catch(() => {});
}
