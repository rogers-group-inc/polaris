/**
 * src/services/notifications/scope.ts — scope → assets (CQ-B063, moved verbatim from notificationEngine.ts): loading the assets a rule covers, the dependency /
 * maintenance suppression gates, and the per-stream pin tests (interface, storage, tunnel,
 * PoE fault) a trigger needs before it may judge a component.
 */

import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { poeIsFault } from "../../utils/poePorts.js";
import { REGION_TAG_PREFIX } from "../notificationService.js";
import { type Trigger, type RuleScope, scopeCidrOf, evaluateScopeCondition } from "../notificationTypes.js";
// Business rule 78 — who silenced a dependency-suppressed device, for the
// alert a down automation raises about it anyway.
import { resolveDependencyBlame } from "../dependencyTreeService.js";
import { decorateRelationLeafHits } from "../scopeRelationIndex.js";
import { ipInCidr } from "../../utils/cidr.js";
import { type ScopeAssetRow, collectLeafRefs } from "./ruleModel.js";
import { _blameCache } from "./assetDetail.js";

// ─── Scope → assets ─────────────────────────────────────────────────────────

const SCOPE_SELECT = {
  id: true, hostname: true, assetType: true, tags: true, discoveredByIntegrationId: true,
  monitorStatus: true, status: true, consecutiveFailures: true, dependencySuppressed: true,
  quarantinedAt: true, ipAddress: true,
  // Business rule 59 — two small columns, and the only way the fortilinkStatus
  // state field can be read off the scope row like the other Asset-column
  // fields instead of needing a query of its own.
  fortilinkStatus: true, fortilinkCheckedAt: true,
  // Business rule 87 — the firmwareVsPrimary field compares off the scope row
  // too: serial prefix = platform, osVersion = what the device runs.
  serialNumber: true, osVersion: true,
  // condition-tree evaluation reads these (manufacturer/model/os); small
  // string columns, still a tight select at 2000 assets. macAddress feeds the
  // device-identifier dimension filters (applyDeviceFilters) alongside
  // hostname / ipAddress / manufacturer / model.
  manufacturer: true, model: true, os: true, macAddress: true,
  // Every interface reading is restricted to PINNED interfaces.
  monitoredInterfaces: true,
  // Every IPsec tunnel reading is restricted to PINNED tunnels (tunnelIsPinned).
  monitoredIpsecTunnels: true,
  // Every storage reading is restricted to PINNED mounts (storageIsPinned).
  monitoredStorage: true,
  // The poll anchors a CURRENT-STATE reading counts on: these fields have no
  // sample series, so "3 polls" can only mean three observations in which the
  // stream that produces them actually ran. lastMonitorAt is the probe (every
  // Asset-column field, plus the windowed-ratio metrics). The SD-WAN rule
  // readings anchor on the rule rows' own updatedAt instead (see the
  // sdwanRuleStatus case), which is written only by a successful SD-WAN read.
  lastMonitorAt: true, lastSystemInfoAt: true,
  // Business rule 118 — four timestamp columns, read off the scope row like
  // fortilinkStatus so the stream-failing fields cost no query of their own.
  lastTelemetryAttemptAt: true, telemetryFailingSince: true,
  lastSystemInfoAttemptAt: true, systemInfoFailingSince: true,
  // The gate every trigger path applies (assetCanTrigger): an automation only
  // ever fires about a device Polaris is actually polling. Kept in the select
  // as well as the WHERE because the event tail and the builder's device
  // preview read the flag per row rather than through scopeWhere.
  monitored: true,
} as const;

/**
 * Can this asset trigger an automation right now? ONE definition, applied by
 * every trigger path (threshold, composite, and the event/change tail), so a
 * device can't be alertable through one trigger type and not another.
 *
 * Two halves:
 *  - `monitored` — Polaris is polling it. An unmonitored device has no live
 *    readings, only whatever its columns froze at when polling stopped:
 *    `monitorStatus` is NOT cleared when monitoring is turned off, so before
 *    this gate a `monitorStatus == down` automation kept an alert firing
 *    forever about a device nobody had polled since the day it was shelved.
 *    The four lifecycle statuses that cannot be monitor-enabled at all
 *    (decommissioned / disabled / storage / quarantined —
 *    UNMONITORABLE_STATUSES) fold into this half rather than being retested.
 *  - not suppressed — in a maintenance window or dependency-suppressed behind
 *    a dark parent (business rule 16).
 *
 * A `monitored` that is absent (the host pseudo-asset) passes: a host_metric
 * or host-composite trigger has no device to poll.
 */
export function assetCanTrigger(a: { monitored?: boolean; status: string; dependencySuppressed: boolean }): boolean {
  if (a.monitored === false) return false;
  return !isSuppressedForNotifications(a);
}

/** Build a Prisma where from a scope, or null if the scope matches nothing.
 *  subnetCidrs can't be expressed in SQL (CIDR math over a string column) —
 *  it narrows to ipAddress-present here and match happens in loadScopeAssets. */
function scopeWhere(scope: RuleScope, monitoredOnly = false): Prisma.AssetWhereInput | null {
  const gate: Prisma.AssetWhereInput = monitoredOnly ? { monitored: true } : {};
  if (scope.allAssets) return gate;
  const and: Prisma.AssetWhereInput[] = [];
  if (scope.assetTypes?.length) and.push({ assetType: { in: scope.assetTypes } });
  if (scope.tags?.length) and.push({ tags: { hasSome: scope.tags } });
  if (scope.assetIds?.length) and.push({ id: { in: scope.assetIds } });
  if (scope.integrationIds?.length) and.push({ discoveredByIntegrationId: { in: scope.integrationIds } });
  // manufacturer / model: case-insensitive contains, OR within the list.
  if (scope.manufacturers?.length) {
    and.push({ OR: scope.manufacturers.map((m) => ({ manufacturer: { contains: m, mode: "insensitive" as const } })) });
  }
  if (scope.models?.length) {
    and.push({ OR: scope.models.map((m) => ({ model: { contains: m, mode: "insensitive" as const } })) });
  }
  if (scope.subnetCidrs?.length) and.push({ ipAddress: { not: null } });
  // A condition tree can't be expressed in SQL — it counts as a dimension
  // (so a condition-only scope loads all assets) and filters in memory below.
  if (scope.condition) and.push({});
  if (and.length === 0) return null; // no dimensions + not allAssets ⇒ nothing
  // Pushed in AFTER the dimension count so the gate can never make an
  // otherwise-empty scope look like it selected something.
  if (monitoredOnly) and.push(gate);
  return { AND: and };
}

/**
 * `monitoredOnly` is what every EVALUATION path passes — the engine tick and
 * the builder's metric/state dry-runs, which must agree with it. The raw
 * (unfiltered) form stays for the surfaces that are asking a different
 * question: the device-list preview (which reports the unmonitored remainder
 * rather than hiding it) and loadScopeAssetIds' callers — the dimension-value
 * picker and mass pinning, neither of which is about firing.
 */
/**
 * Per-TICK memo of resolved scopes, keyed on the scope itself + the monitored
 * gate. Cleared at the top of every engine pass alongside the asset-detail
 * cache (`clearAssetDetailCache`) — and ONLY populated while a pass owns it,
 * so the operator-triggered preview paths that also call loadScopeAssets keep
 * reading live.
 *
 * Every asset-scoped rule re-issued its own fleet read: the seeded baseline
 * set alone is ~30 rules, most of them `allAssets`, so one 60s tick did dozens
 * of identical `findMany`s over SCOPE_SELECT — which carries three array
 * columns (tags, monitoredInterfaces, monitoredIpsecTunnels) per row. Sharing
 * one snapshot per distinct scope also makes the rules in a pass agree with
 * each other about the fleet, where before a rule late in the loop could judge
 * a device on fresher state than an earlier one.
 */
const _scopeAssetCache = new Map<string, ScopeAssetRow[]>();

let _scopeCacheActive = false;

export function clearScopeAssetCache(active: boolean): void {
  _scopeAssetCache.clear();
  _scopeCacheActive = active;
}

export async function loadScopeAssets(scope: RuleScope, opts?: { monitoredOnly?: boolean }): Promise<ScopeAssetRow[]> {
  const monitoredOnly = opts?.monitoredOnly === true;
  const cacheKey = _scopeCacheActive ? JSON.stringify([scope ?? {}, monitoredOnly]) : null;
  if (cacheKey !== null) {
    const hit = _scopeAssetCache.get(cacheKey);
    // Returned as-is, not copied: callers filter and read but never mutate the
    // rows (the one decoration, decorateRelationLeafHits, is applied below
    // before the result is cached).
    if (hit) return hit;
  }
  const where = scopeWhere(scope, monitoredOnly);
  if (!where) return [];
  let rows: ScopeAssetRow[] = await prisma.asset.findMany({ where, select: SCOPE_SELECT });
  if (scope.subnetCidrs?.length) {
    const cidrs = scope.subnetCidrs.map(scopeCidrOf);
    rows = rows.filter((a) => a.ipAddress && cidrs.some((c) => {
      try { return ipInCidr(a.ipAddress!, c); } catch { return false; }
    }));
  }
  if (scope.condition) {
    // The one condition field backed by a relation. Resolved in SQL to per-asset
    // verdicts AFTER the cidr narrowing (so the leaf queries carry the smallest
    // id list) and never joined onto SCOPE_SELECT — at 2000 assets the interface
    // inventory is an order of magnitude larger than the fleet, and this runs
    // per rule per 60s tick. No interface leaf ⇒ no query.
    await decorateRelationLeafHits(rows, [scope.condition]);
    rows = rows.filter((a) => evaluateScopeCondition(scope.condition!, a));
  }
  if (cacheKey !== null) _scopeAssetCache.set(cacheKey, rows);
  return rows;
}

/** The asset ids a rule scope resolves to, for surfaces that need the scope's
 *  DEVICE SET without the reading machinery around it (the builder's
 *  dimension-value picker asks "what do these devices actually report?").
 *  Shares loadScopeAssets so the picker can't disagree with what the engine
 *  would evaluate.
 *
 *  `monitoredOnly` is the picker's answer to "can this value ever fire?" —
 *  since business rule 37 an unmonitored device triggers nothing, so offering
 *  a sensor / interface / mount that only unmonitored inventory reports is how
 *  an operator builds a filter, watches it match nothing, and stops trusting
 *  the picker. Mass pinning passes it OFF deliberately: pinning ports on a
 *  device before anyone monitors it is legitimate prep work. */
export async function loadScopeAssetIds(scope: RuleScope, opts?: { monitoredOnly?: boolean }): Promise<string[]> {
  return (await loadScopeAssets(scope, opts)).map((a) => a.id);
}

/** The distinct region snapshots (stripped, the form fire() writes to
 *  Notification.regionTags) carried by a scope's MONITORED devices — what
 *  recipientDeviceRegion routing could reach for this rule. Read by the
 *  all-quiet summary, which has no triggering device to route on. Devices
 *  with no region tag contribute nothing; each distinct set appears once, so
 *  2000 devices across 30 sites is 30 entries. */
export async function loadScopeRegionSnapshots(scope: RuleScope): Promise<string[][]> {
  const seen = new Map<string, string[]>();
  for (const a of await loadScopeAssets(scope, { monitoredOnly: true })) {
    const snap = regionSnapshot(a.tags ?? []);
    if (snap.length === 0) continue;
    const key = snap.map((s) => s.toLowerCase()).sort().join("\u0000");
    if (!seen.has(key)) seen.set(key, snap);
  }
  return Array.from(seen.values());
}

/**
 * Assets that must not trigger notifications right now:
 *  - status="maintenance" — inside a maintenance window (maintenanceScheduler);
 *    polling is paused so most readings would be stale anyway, and the window
 *    is announced downtime by definition.
 *  - dependencySuppressed — everything behind a down (or maintained) parent;
 *    silencing these keeps a switch's maintenance window from spraying "down"
 *    alerts for every device behind it.
 * Suppressed assets are dropped from rule evaluation and their `pending` state
 * rows reset to clear — a still-bad condition re-earns its full debounce after
 * the window. Their live ALERTS are frozen, not retired, when the cause is a
 * maintenance window (the asset's own, or a maintained parent's) — business
 * rule 16: an alert raised before the window stays live and recovers on its
 * own evidence — once polling resumes, or sooner on a reading taken during the
 * window (an agent push, a Probe Now; see frozenReadingIsFresh). Behind a parent that is genuinely DOWN
 * they are retired, by `clearSuppressedAlerts` (notificationService) rather
 * than here, because event/change alerts carry no state row at all and the
 * sweep has to run over Notification rows.
 */
export function isSuppressedForNotifications(a: { status: string; dependencySuppressed: boolean }): boolean {
  return String(a.status) === "maintenance" || a.dependencySuppressed === true;
}

/**
 * Business rule 78 stops at maintenance, upstream included: of these assets,
 * the dependency-suppressed ones whose blame chain runs through a maintenance
 * window. An opted-in down automation keeps those silent, exactly as every
 * other automation does — Dependency-Down Bypass is for an OUTAGE upstream.
 *
 * Walked through the tick's blame cache, so the fire that follows for the rest
 * re-reads nothing, and only for the suppressed handful. A failed walk claims
 * nothing (rule 78: the alert goes out unnamed rather than not at all).
 */
export async function suppressionOwedToMaintenance(assets: ScopeAssetRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  const candidates = assets.filter((a) => a.dependencySuppressed && String(a.status) !== "maintenance");
  if (candidates.length === 0) return out;
  const blames = await Promise.all(candidates.map((a) => resolveDependencyBlame(a.id, _blameCache)));
  candidates.forEach((a, i) => {
    if (blames[i]?.chain.some((n) => n.reason === "maintenance")) out.add(a.id);
  });
  return out;
}

/**
 * FROZEN, NOT DEAF (business rule 16). A suppressed asset's live alert is
 * frozen — it neither fires nor escalates — but it may still RECOVER on
 * evidence gathered during the suppression: a window stops server-driven
 * polling, not agent pushes or an operator's Probe Now, so a camera NVR that
 * powers back on before its overnight window ends is reporting `up` through
 * its agent while its Down alert sat frozen until the window closed.
 *
 * The danger is the opposite mistake — "recovering" on the last reading taken
 * BEFORE the window, re-read at every tick because nothing replaces it. So a
 * reading counts only when it was taken after the freeze began:
 *  - in maintenance: strictly after the earliest open window's `startedAt`.
 *    A maintenance status with no open window row (no start to compare
 *    against) never qualifies — the alert stays frozen, as before.
 *  - dependency-suppressed only: the asset is still probed (rule 38b), so any
 *    timestamped reading is current.
 * Pure, so the boundaries are testable without a database.
 */
export function frozenReadingIsFresh(
  readingAt: Date | null | undefined,
  inMaintenance: boolean,
  windowStartedAt: Date | null | undefined,
): boolean {
  if (!readingAt) return false;
  if (!inMaintenance) return true;
  if (!windowStartedAt) return false;
  return readingAt.getTime() > windowStartedAt.getTime();
}

/** Earliest open maintenance-window start per asset — when its polling stopped. */
async function openWindowStarts(assetIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (assetIds.length === 0) return out;
  const rows = await prisma.assetMaintenanceWindow.findMany({
    where: { assetId: { in: assetIds }, endedAt: null },
    select: { assetId: true, startedAt: true },
  });
  for (const r of rows) {
    const prev = out.get(r.assetId);
    if (!prev || r.startedAt.getTime() < prev.getTime()) out.set(r.assetId, r.startedAt);
  }
  return out;
}

/**
 * A frozenReadingIsFresh test bound to `candidates`' open windows. One window
 * query, and only for the in-window subset — callers have already narrowed to
 * assets holding a FIRING row, so this is a handful of ids however large the
 * fleet.
 */
export async function frozenFreshnessFor(
  candidates: { id: string; status: string }[],
): Promise<(assetId: string, readingAt: Date | null | undefined) => boolean> {
  const inMaint = new Set(candidates.filter((a) => String(a.status) === "maintenance").map((a) => a.id));
  const starts = await openWindowStarts([...inMaint]);
  return (assetId, readingAt) => frozenReadingIsFresh(readingAt, inMaint.has(assetId), starts.get(assetId));
}

/**
 * Is the device currently ANSWERING us? — the gate on packet-loss alerting
 * (business rule 29). Reads the five-state monitor machine, which is driven by
 * consecutiveFailures/Successes against `failureThreshold` (default 3):
 *
 *   up         → answering. Alerts.
 *   warning    → answering, with 1..threshold-1 failures behind it. ALERTS, and
 *                deliberately so: intermittent loss on a device that still
 *                replies IS the thing packet loss is meant to catch, and it is
 *                the state a lossy-but-alive device sits in (an alternating
 *                pass/fail device never reaches `down`). Gating on `up` alone
 *                would silence the feature's whole reason for existing.
 *   down       → not answering. The outage is asset-down's alert, not a second
 *                one about the probes it swallowed.
 *   recovering → came back but hasn't held for threshold successes; asset-down
 *                is still live, so this is the tail of that same outage.
 *   unknown    → never probed (UI "Pending") — nothing measured yet.
 *   passive    → no down-detection automation covers the device, so Polaris
 *                renders no verdict about it. NOT answering, for the reason
 *                this gate exists: a dark passive device sits at 100% loss
 *                indefinitely and there is no asset-down alert to supersede
 *                the loss alert (that is precisely what is missing), so
 *                admitting it would park a permanently-firing, never-clearing
 *                alert on every device an operator just told Polaris to stop
 *                judging. "Stop judging these" must not quietly become "judge
 *                them by a different metric".
 *
 * A null status is treated as not answering: it means the same thing `unknown`
 * does on a row written before the column existed.
 */
export function assetIsAnsweringProbes(a: { monitorStatus: string | null }): boolean {
  return a.monitorStatus === "up" || a.monitorStatus === "warning";
}

/**
 * Metrics whose readings only mean something while the device answers, so a
 * non-answering device produces none. Just `probeLossPct` today: its INPUT is
 * failed probes, which is what makes it the one metric that can fire about an
 * outage the asset-down alert already owns. Every other metric is derived from
 * SUCCESSFUL polls, so a dark device simply stops producing readings and its
 * alerts freeze rather than newly firing.
 */
const ANSWERING_ONLY_METRICS = new Set<string>(["probeLossPct"]);

/** Does this trigger's metric need an answering device (see above)? */
export function triggerNeedsAnsweringDevice(trigger: Trigger): boolean {
  return trigger.type === "asset_metric" && ANSWERING_ONLY_METRICS.has(trigger.metric);
}

/**
 * An outage hands off only the alerts whose INPUT is the outage (business rule
 * 29(i)). Packet loss and response time are measured from the very probes that
 * declare a device `down` — a missed response-time poll is the timeout it cost
 * (rule 67) — so while the device is dark they would only restate the
 * asset-down alert. A device that is `down` hands every such alert to
 * asset-down: cleared as superseded, no reset actions, no new fire while dark.
 * The two stream-failing fields (rule 118) count failed polls the same way, so
 * they would fire partway through every outage; they hand off too.
 *
 * Everything else FREEZES. A CPU, memory, interface, SD-WAN or forecast
 * reading is a fact the device reported before it went dark, and the outage
 * does not falsify it. Clearing it on `down` turned every flap of a WAN link
 * into a fresh alert when the device came back with the same condition — a
 * memory-forecast email resent on every bounce, about a 30-day trend the
 * outage cannot move.
 *
 * Gated on `down` alone, not "not answering": `passive` and `unknown` have no
 * asset-down alert to hand to (see assetIsAnsweringProbes), and `recovering`
 * is answering again — its readings are real.
 */
const DEVICE_DOWN_HANDOFF_METRICS = new Set<string>(["probeLossPct", "responseTimeMs"]);

const DEVICE_DOWN_HANDOFF_STATE_FIELDS = new Set<string>(["telemetryFailingMinutes", "systemInfoFailingMinutes"]);

function leafHandsOffWhenDeviceDown(leaf: { type: string; metric?: string; field?: string }): boolean {
  if (leaf.type === "asset_metric") return !!leaf.metric && DEVICE_DOWN_HANDOFF_METRICS.has(leaf.metric);
  if (leaf.type === "asset_state") return !!leaf.field && DEVICE_DOWN_HANDOFF_STATE_FIELDS.has(leaf.field);
  return false;
}

/** Does a live alert on this trigger hand off to asset-down when its device
 *  goes `down` (see above)? A composite does only when EVERY leaf would — one
 *  leaf about the outage or a held fact makes the tree about it too. */
export function triggerHandsOffWhenDeviceDown(trigger: Trigger): boolean {
  if (trigger.type === "composite") {
    return trigger.kind === "asset" && collectLeafRefs(trigger).every((r) => leafHandsOffWhenDeviceDown(r.leaf));
  }
  return leafHandsOffWhenDeviceDown(trigger);
}

/** Is the device in a confirmed outage — the state asset-down alerts on? */
export function assetIsDown(a: { monitorStatus: string | null }): boolean {
  return a.monitorStatus === "down";
}

/**
 * An interface alert only ever concerns a MONITORED interface — the pin set in
 * `Asset.monitoredInterfaces` (the same join the Down Interfaces widget uses).
 * A device reports every port it has, most of them idle or unplugged, so an
 * ungated interface rule turns one switch into a page of alerts about ports
 * nobody selected (business rule 57). The pin IS the operator's statement of which ports matter,
 * so it is the default and there is no opt-out: an interface an operator cares
 * about enough to alert on is one they pinned, and un-pinning is how alerting
 * stops (the vanished-state sweep then clears the alert).
 *
 * The interface STATE fields (ifOperStatus / ifAdminStatus / ifIpAddress /
 * poeStatus) have always gated here. The four COUNTER metrics did not: they read
 * `AssetInterfaceSample`, which became pinned-only in the 2026-08 cutover, so
 * they were gated incidentally by what the sampler writes rather than by any
 * rule of their own — which leaves the window between un-pinning an interface
 * and its last rows aging out (plus every pre-cutover row still inside the
 * lookback) able to fire an alert about a port that is no longer monitored.
 * Gating explicitly closes that and makes the rule one thing rather than a
 * property of a storage decision that could change again.
 */
export function interfaceIsPinned(asset: { monitoredInterfaces?: string[] } | undefined, ifName: string): boolean {
  return asset?.monitoredInterfaces?.includes(ifName) ?? false;
}

/**
 * The ONE carve-out from the pin gate (business rule 57): a PoE trigger that
 * names a FAULT value reads every PoE-capable port, pinned or not.
 *
 * Why this field and no other. The pin gate exists because a device reports
 * every port it has and most of them are idle, so an ungated `ifOperStatus ==
 * down` rule turns one switch into a page of alerts about ports nobody plugged
 * anything into. `poeStatus == fault` cannot do that: RFC 3621 gives an empty
 * port `searching` and an operator-disabled one `disabled`, so the only way to
 * read `fault` (or `otherFault`) is for the PSE to have detected a powered
 * device and FAILED to power it. That is the device's own alarm bit, which
 * business rule 24 says to prefer over a threshold we invented — and a port
 * faulting is exactly the event an operator cannot discover by other means,
 * because the AP or camera on the far end simply never comes up. Pinning every
 * port on every switch to catch it would defeat the pin gate everywhere else.
 *
 * Scoped to `==` deliberately. `!= delivering` also "covers" fault, but it
 * covers `searching` and `disabled` with it — every empty port in the fleet —
 * which is the alert storm the gate exists to stop. An operator who wants the
 * wider rule can still write it; it just stays pinned-only.
 *
 * Consequence, stated because rule 57 requires an un-gating to be announced
 * rather than discovered: an existing `poeStatus == fault` automation starts
 * covering unpinned ports on the next tick, with no edit. That is the intended
 * reading — "tell me when a port fails to power something" was never a
 * statement about the pin set — but it is a fleet-wide behaviour change.
 */
export function poeFaultCoversUnpinned(trigger: Trigger): boolean {
  return trigger.type === "asset_state"
    && trigger.field === "poeStatus"
    && trigger.operator === "=="
    && typeof trigger.value === "string"
    && poeIsFault(trigger.value);
}

/**
 * What an interface-dimensioned alert CALLS the port.
 *
 * The dimension KEY stays the stored `ifName` — it is the identity the state
 * row, the vanished-state sweep and `Notification.dimension` are all keyed on,
 * and none of them may drift for a caption. The LABEL is the only part a human
 * reads, and on a switch it has to name the PORT: an operator paged about
 * "Indoor AP" has to go and find which port that is before they can do
 * anything about it, and two ports described alike are indistinguishable in
 * the one line the alert gets. So the label states the interface name and
 * carries the operator's own label — SNMP `ifAlias`, the FortiOS CMDB alias —
 * beside it when the two differ, which is what makes the alert name the port
 * AND what is plugged into it instead of one or the other.
 *
 * Read off the sample row rather than joined from `AssetInterface`: the
 * resolvers already select the row, and an extra per-tick query for a caption
 * is the wrong trade at 2000 assets.
 */
export function interfaceDimLabel(ifName: string, alias?: string | null): string {
  const a = typeof alias === "string" ? alias.trim() : "";
  return a && a !== ifName ? `${ifName} (${a})` : ifName;
}

/**
 * The IPsec analogue of interfaceIsPinned: only tunnels the operator PINNED
 * (`Asset.monitoredIpsecTunnels`) may produce readings. Unlike interfaces,
 * whose sample table became pinned-only in the 2026-08 cutover, the IPsec
 * stream still writes every tunnel the gate reports on the full system-info
 * scrape (`cadence:"slow"`, 24h retention) — so without this gate an
 * `ipsecStatus`/`ipsecThroughputBps` rule fires on tunnels nobody selected
 * for monitoring, always, because those slow rows are refreshed every scrape
 * and never age past the engine's lookback. The pin is the operator's
 * statement of which tunnels may alert, same as ports. A tunnel that leaves
 * the pin set stops producing readings; the vanished-state sweep clears its
 * alert (`system:out-of-scope`).
 */
export function tunnelIsPinned(asset: { monitoredIpsecTunnels?: string[] } | undefined, tunnelName: string): boolean {
  return asset?.monitoredIpsecTunnels?.includes(tunnelName) ?? false;
}

/**
 * The storage analogue of interfaceIsPinned (business rule 57): only mounts the operator PINNED
 * (`Asset.monitoredStorage`) may produce readings, on all three storage
 * metrics (`storageUsedBytes` / `storageUsedPct` / `storageDaysUntilFull`).
 *
 * Storage is the case the IPsec gate describes, one step worse. The stream
 * walks EVERY mountpath the device reports and writes the unpinned ones
 * `cadence:"slow"` (24h retention, no rollups) — refreshed on every scrape, so
 * they are always inside the engine's lookback. Ungated, a fleet-wide
 * "disk over 90%" rule alerts on every removable volume, ISO mount, recovery
 * partition, mapped network drive and full-by-design archive share on every
 * workstation and server in the fleet, none of which anyone selected. The pin
 * IS the operator's statement of which filesystems matter (Assets → Mass
 * Pinning, the System tab, or an integration's Auto-Monitor Storage block),
 * so it is the default with no opt-out and un-pinning is how alerting stops.
 *
 * Consequence of turning this on (2026-09): a rule scoped to devices with NO
 * pinned mounts goes silent, and any alert it has firing is retired by the
 * vanished-state sweep as `system:out-of-scope` — the same cutover interfaces
 * and tunnels took. Pinning the mounts that should alert is the fix, and the
 * builder's mount-path picker has always listed exactly that set.
 */
export function storageIsPinned(asset: { monitoredStorage?: string[] } | undefined, mountPath: string): boolean {
  return asset?.monitoredStorage?.includes(mountPath) ?? false;
}

/**
 * The pin test for a trigger whose dimensions are PIN-gated (interfaces /
 * IPsec tunnels), or null when they aren't. The vanished-state sweep uses it
 * to tell a configuration edge from a collection gap: an unpinned dimension
 * produces no readings BY THE OPERATOR'S OWN HAND, so its firing row may
 * clear even on a tick where the asset reported nothing at all — without
 * this, unpinning a device's only alerting interface stranded the alert
 * forever, because the no-readings freeze (which exists for genuine scrape
 * gaps) also swallowed the unpin.
 *
 * Null for a PoE FAULT trigger (poeFaultCoversUnpinned), and it has to be: that
 * rule's readings no longer come from the pin set, so pin-testing its firing
 * rows would clear every alert about an unpinned port on the first sweep —
 * retiring the alert the carve-out exists to raise. Un-pinning therefore stops
 * a `== searching` rule and not a `== fault` one, which is the same statement
 * the resolver makes, made once more where the sweep can see it.
 */
export function pinTestForTrigger(trigger: Trigger): ((asset: ScopeAssetRow, dimKey: string) => boolean) | null {
  if (poeFaultCoversUnpinned(trigger)) return null;
  if (trigger.type === "asset_metric") {
    if (trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" || trigger.metric === "ifInErrorRate" || trigger.metric === "ifOutErrorRate") return interfaceIsPinned;
    if (trigger.metric === "ipsecThroughputBps") return tunnelIsPinned;
    if (trigger.metric === "storageUsedBytes" || trigger.metric === "storageUsedPct" || trigger.metric === "storageDaysUntilFull") return storageIsPinned;
  } else if (trigger.type === "asset_state") {
    if (trigger.field === "ifOperStatus" || trigger.field === "ifAdminStatus" || trigger.field === "ifIpAddress" || trigger.field === "poeStatus") return interfaceIsPinned;
    if (trigger.field === "ipsecStatus") return tunnelIsPinned;
  }
  return null;
}

export function regionSnapshot(tags: string[]): string[] {
  return tags
    .filter((t) => t.toLowerCase().startsWith(REGION_TAG_PREFIX))
    .map((t) => t.slice(REGION_TAG_PREFIX.length))
    .filter(Boolean);
}
