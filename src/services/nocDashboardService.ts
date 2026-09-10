/**
 * src/services/nocDashboardService.ts
 *
 * Fleet-wide aggregates backing the NOC dashboard widgets (the SolarWinds
 * wall-display recreation). Each function answers one widget's question over
 * the whole monitored fleet. The route layer (dashboard.ts /noc-summary) goes
 * through getNocSummaryPayload(), which resolves the requested feed subset
 * (?feeds=a,b — widgets fetch individually so each renders as soon as its own
 * data exists), permission-filters per section, and serves every feed through
 * a short per-feed TTL cache so N widgets / browsers / kiosk walls don't
 * recompute the same hypertable scans.
 *
 * Scale: every query here is designed to stay flat from 100 to 2000 monitored
 * assets — groupBy / count / one windowed raw aggregate / one bounded findMany,
 * never a per-row await loop. The sample tables (asset_telemetry_samples,
 * asset_monitor_samples) are TimescaleDB hypertables: we ONLY read them, and
 * the time-window predicate keeps each scan inside recent (chunk-excluded)
 * data.
 *
 * TIMEZONE RULE for raw window predicates: Prisma maps DateTime to
 * `timestamp` WITHOUT time zone and stores UTC wall-clock values. Comparing
 * that naive column against bare `now()` (a timestamptz) makes Postgres
 * interpret the stored values in the SERVER's TimeZone — on a RHEL-native
 * install that defaults to the system zone (e.g. America/Chicago), which
 * silently shifts every "last N minutes" window by the UTC offset (a
 * 15-minute packet-loss window becomes ~5¼ hours and counts a long-recovered
 * outage; positive-offset zones would instead make windows match nothing).
 * Always write `(now() AT TIME ZONE 'UTC')` — naive-UTC vs naive-UTC — in
 * raw SQL against Prisma-written timestamp columns. Prisma-bound Date
 * parameters are unaffected.
 */

import { EXCLUDED_LIFECYCLE_STATUSES } from "../utils/assetInvariants.js";
import { BUILT_IN_ASSET_TYPES } from "../utils/assetTypes.js";
import { prisma } from "../db.js";
import { resolveMonitorSettings } from "./monitoringService.js";
import { computeStorageForecast } from "./storageForecastService.js";
import { queryProbeLossRatios } from "./probeLossQuery.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { ALERT_SEVERITY_RANK } from "../utils/alertSeverity.js";

// Asset types treated as "infrastructure" for the uptime % gauge — mirrors the
// SolarWinds Fortinet-only uptime tile. These are the built-in network-gear
// types; custom operator types fall outside the gauge by design.
const INFRA_ASSET_TYPES = ["firewall", "switch", "router", "access_point"];

// An asset inside a maintenance window (scheduler-held status="maintenance")
// has its polling paused and monitorStatus FROZEN at whatever it was on window
// entry — a device taken down for planned work stays monitorStatus="down" for
// the whole window. Every down/warning/stale surface here must exclude the
// maintenance set or planned downtime reads as an outage (the Status Map
// widget paints these purple for the same reason). Spread into asset wheres;
// mirrored as `AND "status" <> 'maintenance'` in the raw-SQL feeds.
const NOT_IN_MAINTENANCE = { status: { not: "maintenance" as const } };

// monitorAlerts (and therefore the active-alert count) is defined as monitored
// assets currently in warning/down that aren't dependency-suppressed — kept
// byte-identical to the /summary monitorAlerts where-clause so the tile count
// and the alert list never disagree.
const ALERT_WHERE = {
  monitored: true,
  monitorStatus: { in: ["warning", "down"] },
  dependencySuppressed: false,
  ...NOT_IN_MAINTENANCE,
};

/**
 * /summary "assetTypeCounts" section — live-asset count per assetType
 * (decommissioned/disabled excluded).
 */
export async function getAssetTypeCountRows(): Promise<Array<{ assetType: string; _count: { _all: number } }>> {
  return prisma.asset.groupBy({
    by: ["assetType"],
    _count: { _all: true },
    where: { status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
  });
}

/**
 * /summary "monitorAlerts" section — monitored assets currently in
 * warning/down, newest transition first. Shares ALERT_WHERE with the NOC
 * active-alert tile count so the list and the tile can never disagree
 * (previously duplicated in dashboard.ts with a keep-in-lockstep comment).
 * Returns up to cap+1 rows so the caller can detect overflow.
 */
export async function getMonitorAlertRows(cap: number) {
  return prisma.asset.findMany({
    where: ALERT_WHERE,
    select: {
      id: true,
      hostname: true,
      ipAddress: true,
      assetType: true,
      monitorStatus: true,
      monitorStatusChangedAt: true,
      discoveredByIntegration: { select: { name: true, type: true } },
    },
    // Newest transitions first; nulls (unknown transition time, typically
    // pre-backfill assets) sink to the bottom.
    orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
    take: cap + 1,
  });
}

// The built-in asset types the per-widget asset-type filter toggles. Read from
// the registry constant rather than re-listing them: this file derives the
// HIDDEN set as (built-ins - the enabled ones the widget sent), so a private
// copy that misses a name silently makes that type unfilterable — which is how
// `hypervisor` and `kubernetes_cluster` stayed off the filter after being added
// to the registry. The widgets' own copy (public/js/widgets/index.js) is the
// third member of this lockstep; see polaris-change-impact -> services/assets-inventory.md (assetTypeService).
const BUILTIN_ASSET_TYPES: readonly string[] = BUILT_IN_ASSET_TYPES;

// Sentinel the widgets send in ?fortigates= for the "(No FortiGate)" picker
// entry — matches assets with NO gate association (no sighting rows and a
// learnedLocation that isn't any known gate's name), so standalone
// switches/APs that were never FortiGate-managed remain selectable. Double
// underscores keep it collision-proof against real device hostnames.
export const FORTIGATE_NONE_SENTINEL = "__none__";

/**
 * Resolve a per-widget filter into the set of matching asset ids, or null when
 * no filter is active (callers then skip the constraint entirely — the default
 * unfiltered path). Three dimensions:
 *   - hideAssetTypes: the types the widget wants EXCLUDED, named outright
 *     (`assetType NOT IN hidden`). This is the dimension the grid writes today,
 *     and the only one that can hide a CUSTOM (operator-added) type: naming the
 *     hidden set rather than the enabled one means a type added to the registry
 *     after a config was saved is not in that config's hidden list, so it stays
 *     visible until the operator says otherwise.
 *   - assetTypes: the LEGACY dimension — the ENABLED built-in types, from a
 *     stored config (or a cached older bundle) written before the grid learned
 *     the registry. Hidden = built-ins NOT enabled, so custom types always show
 *     through it. Sent together with hideAssetTypes the two union.
 *   - regionNames: the user's region names ("My regions"). An asset matches if
 *     it carries the `region:<name>` tag for any of them. Empty = all regions.
 *   - fortigateNames: FortiGate device names ("Selected FortiGates" — the
 *     per-site narrowing below regions). An asset matches if it sits behind
 *     any of them: `learnedLocation` equals the name (managed FortiSwitches /
 *     FortiAPs carry their controller gate there, firewalls their own
 *     hostname, endpoints the gate that leased them) OR any
 *     AssetFortigateSighting row names it — the same two haystacks the
 *     tag/maintenance "Behind FortiGate" criteria matches, but exact-only
 *     (the picker offers concrete device names, not patterns). The
 *     FORTIGATE_NONE_SENTINEL entry instead matches assets with NO gate
 *     association: zero sighting rows AND a learnedLocation that isn't any
 *     known gate's name (null, or a non-gate value like an AD OU path) — so
 *     never-FortiGate-managed switches/APs stay selectable alongside gates.
 * Returns [] (not null) when a filter is active but nothing matches — feeds
 * then correctly show nothing.
 */
export async function resolveFilteredAssetIds(opts: {
  assetTypes?: string[] | null;
  hideAssetTypes?: string[] | null;
  regionNames?: string[] | null;
  fortigateNames?: string[] | null;
}): Promise<string[] | null> {
  const where: Record<string, unknown> = {};
  let active = false;
  const hidden = new Set<string>((opts.hideAssetTypes || []).filter(Boolean));
  if (Array.isArray(opts.assetTypes)) {
    for (const t of BUILTIN_ASSET_TYPES) if (!opts.assetTypes.includes(t)) hidden.add(t);
  }
  if (hidden.size > 0) { where.assetType = { notIn: [...hidden] }; active = true; }
  const regionNames = (opts.regionNames || []).filter(Boolean);
  if (regionNames.length > 0) {
    where.tags = { hasSome: regionNames.map((n) => "region:" + n) };
    active = true;
  }
  const fortigateNames = (opts.fortigateNames || []).filter(Boolean);
  if (fortigateNames.length > 0) {
    const named = fortigateNames.filter((n) => n !== FORTIGATE_NONE_SENTINEL);
    // Top-level OR ANDs with the dimensions above: (types) AND (regions) AND
    // (behind any selected gate / gate-less).
    const or: Record<string, unknown>[] = named.flatMap((n) => [
      { learnedLocation: { equals: n, mode: "insensitive" } },
      { fortigateSightings: { some: { fortigateDevice: { equals: n, mode: "insensitive" } } } },
    ]);
    if (fortigateNames.includes(FORTIGATE_NONE_SENTINEL)) {
      // "(No FortiGate)": no sighting rows AND learnedLocation isn't a known
      // gate name. The gate list is every firewall's learnedLocation (any
      // status — a decommissioned gate's name still marks an association),
      // compared verbatim: both sides are stamped by the same discovery
      // writers, so exact values agree. notIn excludes NULL rows in SQL,
      // hence the explicit null arm.
      const gateRows = await prisma.asset.findMany({
        where: { assetType: "firewall", learnedLocation: { not: null } },
        select: { learnedLocation: true },
        distinct: ["learnedLocation"],
      });
      const gates = gateRows.map((r) => r.learnedLocation).filter((n): n is string => Boolean(n));
      or.push({
        AND: [
          gates.length > 0
            ? { OR: [{ learnedLocation: null }, { learnedLocation: { notIn: gates } }] }
            : {},
          { fortigateSightings: { none: {} } },
        ],
      });
    }
    where.OR = or;
    active = true;
  }
  if (!active) return null;
  const rows = await prisma.asset.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

// Spread into a Prisma asset `where` to constrain by the resolved id set.
// null → no constraint (default unfiltered path).
function idWhere(assetIds: string[] | null): Record<string, unknown> {
  return assetIds ? { id: { in: assetIds } } : {};
}

// ─── Active-alert severity join ──────────────────────────────────────────────
// Widgets sort SEVERITY-FIRST: a row whose asset carries an active (uncleared)
// automation alert floats above unalerted rows, ordered by the alert's
// severity; within the same severity each feed keeps its own order (value /
// outage recency / overdue-ness — the sorts below are stable).
//
// The rank map moved to utils/alertSeverity.ts when the assets list grew its
// own active-alert indicator — two services ranking severities from two copies
// of the same object is how they end up disagreeing about `serious`. Re-exported
// here because it was exported from this module first and the widget tests
// import it by that name.
export { ALERT_SEVERITY_RANK } from "../utils/alertSeverity.js";

// ─── Widget ↔ automation relevance ───────────────────────────────────────────
// A row shows a severity pill ONLY when the asset carries an active alert whose
// AUTOMATION is about the same thing the widget measures. A firewall answering
// probes in 6ms should not wear a "serious" pill just because it has an
// unrelated disk-full alert — the CPU/latency widgets classify CPU/latency, so
// their pills reflect only CPU/latency automations. `any` keeps the legacy
// "highest active alert of any kind" behavior (used by nothing metric-specific);
// `none` suppresses the pill entirely (widgets with no matching automation, e.g.
// stale polls). The pill's color/label is the firing automation's own severity.
export type AlertRelevance =
  | { kind: "metric"; metrics: readonly string[] } // asset_metric / host_metric leaves
  | { kind: "state"; fields: readonly string[] }   // asset_state leaves
  | { kind: "event"; actions: readonly string[] }  // event triggers (glob actionPattern)
  | { kind: "any" }
  | { kind: "none" };

const metricRel = (...metrics: string[]): AlertRelevance => ({ kind: "metric", metrics });
const stateRel = (...fields: string[]): AlertRelevance => ({ kind: "state", fields });
const eventRel = (...actions: string[]): AlertRelevance => ({ kind: "event", actions });

/** Anchored glob (`*` only) → RegExp, for matching an event trigger's
 *  actionPattern against a concrete action the widget cares about. */
function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + esc + "$");
}

/** Does a rule trigger pertain to a widget's dimension? Walks the trigger,
 *  recursing into composite groups/leaves — a composite counts if ANY leaf
 *  matches. A rule-less notification (rule deleted → SetNull) matches nothing
 *  but `any`. */
function triggerMatchesRelevance(trigger: unknown, rel: AlertRelevance): boolean {
  if (rel.kind === "any") return true;
  if (rel.kind === "none") return false;
  let matched = false;
  const visit = (node: unknown): void => {
    if (matched || !node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const t = n.type;
    if ((t === "asset_metric" || t === "host_metric") && rel.kind === "metric") {
      if (typeof n.metric === "string" && rel.metrics.includes(n.metric)) matched = true;
    } else if (t === "asset_state" && rel.kind === "state") {
      if (typeof n.field === "string" && rel.fields.includes(n.field)) matched = true;
    } else if (t === "event" && rel.kind === "event") {
      if (typeof n.actionPattern === "string") {
        const re = globToRegExp(n.actionPattern);
        if (rel.actions.some((a) => re.test(a))) matched = true;
      }
    }
    // composite trigger + nested condition groups both carry a `children` array.
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  visit(trigger);
  return matched;
}

/** Highest active-alert severity per asset, considering ONLY alerts whose
 *  automation is relevant to the caller's widget (see AlertRelevance). One
 *  bounded findMany over the uncleared notifications joined to their rule's
 *  trigger; covered by @@index([assetId]) + [cleared, ...].
 *
 *  The winner also NAMES itself (`id`) and says whether someone already has it
 *  (`acknowledged`), so a widget row can offer the acknowledge verb for the
 *  same alert its severity pill is showing instead of re-deriving which of an
 *  asset's alerts that was. Ties break toward the UNACKNOWLEDGED one: at equal
 *  severity the choice is invisible to the pill, and it is the only one that
 *  keeps "already acknowledged" meaning every relevant alert is handled. */
export async function activeAlertSeverityByAsset(
  assetIds: string[] | null,
  relevance: AlertRelevance = { kind: "any" },
): Promise<Map<string, { severity: string; rank: number; id: string; acknowledged: boolean }>> {
  if (relevance.kind === "none") return new Map();
  const rows = await prisma.notification.findMany({
    where: { cleared: false, assetId: assetIds ? { in: assetIds } : { not: null } },
    select: { id: true, assetId: true, severity: true, acknowledged: true, rule: { select: { trigger: true } } },
  });
  const out = new Map<string, { severity: string; rank: number; id: string; acknowledged: boolean }>();
  for (const r of rows) {
    if (!r.assetId) continue;
    if (!triggerMatchesRelevance(r.rule?.trigger, relevance)) continue;
    const rank = ALERT_SEVERITY_RANK[r.severity] ?? 0;
    const acknowledged = r.acknowledged === true;
    const cur = out.get(r.assetId);
    const wins = !cur || rank > cur.rank || (rank === cur.rank && cur.acknowledged && !acknowledged);
    if (wins) out.set(r.assetId, { severity: r.severity, rank, id: r.id, acknowledged });
  }
  return out;
}

/** Decorate feed rows with the owning asset's highest RELEVANT active-alert
 *  severity. One severity fetch bounded to the rows' own asset ids (feeds are
 *  capped, so this stays small at 2000 assets).
 *
 *  `withAlertRef` additionally names that alert on the row (`alertId` +
 *  `alertAcknowledged`), for a feed whose rows are ACTED on rather than only
 *  read — Down Assets, whose click-through offers Acknowledge. Opt-in so the
 *  other feeds' payload shapes are untouched. */
async function attachAlertSeverity<T extends object>(
  rows: T[],
  idOf: (r: T) => string | null | undefined,
  relevance: AlertRelevance = { kind: "any" },
  withAlertRef = false,
): Promise<Array<T & { alertSeverity?: string; alertRank: number; alertId?: string; alertAcknowledged?: boolean }>> {
  const ids = Array.from(new Set(rows.map(idOf).filter((x): x is string => !!x)));
  if (ids.length === 0 || relevance.kind === "none") return rows.map((r) => ({ ...r, alertRank: 0 }));
  const sev = await activeAlertSeverityByAsset(ids, relevance);
  return rows.map((r) => {
    const id = idOf(r);
    const s = id ? sev.get(id) : undefined;
    return {
      ...r,
      ...(s ? { alertSeverity: s.severity } : {}),
      ...(s && withAlertRef ? { alertId: s.id, alertAcknowledged: s.acknowledged } : {}),
      alertRank: s?.rank ?? 0,
    };
  });
}

/** Stable severity-first sort — equal ranks keep the feed's own order. */
function severityFirst<T extends { alertRank: number }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.alertRank - a.alertRank);
}

async function topNWithSeverity(rows: TopNRow[], relevance: AlertRelevance): Promise<TopNRow[]> {
  return severityFirst(await attachAlertSeverity(rows, (r) => r.id, relevance));
}

export interface StatusSummary {
  statusCounts: { total: number; up: number; down: number; warning: number; unknown: number; recovering: number; passive: number; maintenance: number };
  uptimePercent: number | null;
  activeAlertCount: number;
}

/**
 * Feed 1 — status tiles. Two groupBys + two counts, all backed by
 * @@index([monitored]). Constant query cost regardless of fleet size.
 * Maintenance-window assets get their own bucket (they still count into
 * `total`): their frozen monitorStatus must not feed the Up/Down/Warning
 * tiles or the uptime gauge.
 */
export async function getStatusSummary(assetIds: string[] | null = null): Promise<StatusSummary> {
  const idf = idWhere(assetIds);
  const [byStatus, infraByStatus, activeAlertCount, maintenanceCount] = await Promise.all([
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, ...NOT_IN_MAINTENANCE, ...idf },
    }),
    prisma.asset.groupBy({
      by: ["monitorStatus"],
      _count: { _all: true },
      where: { monitored: true, assetType: { in: INFRA_ASSET_TYPES }, ...NOT_IN_MAINTENANCE, ...idf },
    }),
    prisma.asset.count({ where: { ...ALERT_WHERE, ...idf } }),
    prisma.asset.count({ where: { monitored: true, status: "maintenance", ...idf } }),
  ]);

  // `passive` needs its own bucket or the `key in counts` fallback below funnels
  // it into `unknown`, which the UI renders as "Pending / never probed" — a lie
  // about a device that is being polled perfectly well and simply has no
  // down-detection automation covering it.
  const counts = { total: maintenanceCount, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, passive: 0, maintenance: maintenanceCount };
  for (const row of byStatus) {
    const n = row._count._all;
    counts.total += n;
    const key = (row.monitorStatus ?? "unknown") as keyof typeof counts;
    if (key in counts && key !== "total" && key !== "maintenance") counts[key] += n;
    else counts.unknown += n;
  }

  // Uptime % over the infra subset: up / (up + down). Excludes warning /
  // recovering / unknown / passive so the gauge reflects hard reachability,
  // matching the SolarWinds infra uptime tile. Passive belongs in neither half
  // by construction: a device Polaris renders no verdict about has no uptime to
  // report. Null when there's no infra to measure.
  let infraUp = 0;
  let infraDown = 0;
  for (const row of infraByStatus) {
    if (row.monitorStatus === "up") infraUp += row._count._all;
    else if (row.monitorStatus === "down") infraDown += row._count._all;
  }
  const denom = infraUp + infraDown;
  const uptimePercent = denom === 0 ? null : Math.round((infraUp / denom) * 1000) / 10;

  return { statusCounts: counts, uptimePercent, activeAlertCount };
}

export interface DownNode {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  site: string;
  division: string | null;
  monitorStatus: string | null;
  monitorStatusChangedAt: Date | null;
  // True when the asset's own probe is failing but a parent is down as well, so
  // the outage is upstream ("Dep. Down" in the assets table). Always present;
  // only ever true when the caller asked for the suppressed rows.
  dependencySuppressed: boolean;
  alertSeverity?: string;
  alertRank?: number;
  // The alert the severity pill is showing, NAMED so the widget's row menu can
  // offer Acknowledge for that same alert — plus whether it is already handled,
  // which is what decides whether the menu is offered at all (an alert someone
  // already owns is nothing to act on, so the click just opens the device).
  alertId?: string;
  alertAcknowledged?: boolean;
}

function siteOf(a: { location: string | null; learnedLocation: string | null; snmpLocation: string | null }): string {
  return a.location || a.learnedLocation || a.snmpLocation || "(unknown)";
}

/**
 * Feed 2 — down assets. One indexed findMany over the (small) down subset;
 * site coalesce done in JS because Prisma groupBy can't COALESCE three
 * nullable columns. dependencySuppressed:false so a down parent's suppressed
 * children don't show as independent outages — one dead gate is one outage,
 * not one per device behind it. `includeDependencyDown` drops that filter for
 * the operator who wants the full blast radius instead (the widget's gear
 * toggle); the rows carry the flag so they stay tellable apart on screen.
 * Ordered youngest outage first
 * (monitorStatusChangedAt desc) — the freshest state change is the one a NOC
 * operator needs to react to; nulls (unknown transition time) sink to the
 * bottom. The order matters at the cap too: when >limit nodes are down, the
 * newest outages are the ones kept.
 */
export async function getDownNodes(
  limit: number | null = 100,
  assetIds: string[] | null = null,
  includeDependencyDown = false,
): Promise<{ nodes: DownNode[]; total: number }> {
  const where = {
    monitored: true,
    monitorStatus: "down",
    ...(includeDependencyDown ? {} : { dependencySuppressed: false }),
    ...NOT_IN_MAINTENANCE,
    ...idWhere(assetIds),
  };
  // `total` is the TRUE down count (indexed count over the same where), not
  // rows.length — the findMany is capped by `limit`, and the widget's header
  // pill must show the overall number even when the list is clipped.
  const [rows, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      select: {
        id: true, hostname: true, ipAddress: true, assetType: true,
        location: true, learnedLocation: true, snmpLocation: true,
        department: true, monitorStatus: true, monitorStatusChangedAt: true,
        dependencySuppressed: true,
      },
      orderBy: [{ monitorStatusChangedAt: { sort: "desc", nulls: "last" } }],
      take: limit ?? undefined,
    }),
    prisma.asset.count({ where }),
  ]);
  const nodes: DownNode[] = rows.map((a) => ({
    id: a.id,
    hostname: a.hostname,
    ipAddress: a.ipAddress,
    assetType: a.assetType,
    site: siteOf(a),
    division: a.department,
    monitorStatus: a.monitorStatus,
    monitorStatusChangedAt: a.monitorStatusChangedAt,
    dependencySuppressed: a.dependencySuppressed,
  }));
  // Severity-first: alerted nodes float to the top; within a severity (and for
  // unalerted nodes) the youngest-outage order above holds (stable sort).
  return { nodes: severityFirst(await attachAlertSeverity(nodes, (n) => n.id, stateRel("monitorStatus"), true)), total };
}

export interface DownInterface {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  ifName: string;
  ifLabel: string | null;
  gate: string;
  lastUpAt: Date | null;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * The "gate" an interface lives on. For a FortiGate firewall the interface is
 * physically on the device itself → its hostname. For a managed FortiSwitch /
 * FortiAP (and other discovered gear) `learnedLocation` carries the parent
 * FortiGate device name — the same field the Down Assets site grouping surfaces
 * as the gate. Fall back to the remaining site fields, then "(unknown)".
 */
function gateOf(a: { assetType: string; hostname: string | null; learnedLocation: string | null; location: string | null; snmpLocation: string | null }): string {
  if (a.assetType === "firewall") return a.hostname || a.learnedLocation || a.location || a.snmpLocation || "(unknown)";
  return a.learnedLocation || a.hostname || a.location || a.snmpLocation || "(unknown)";
}

/**
 * Feed 2b — down interfaces. Interfaces that are administratively UP but
 * operationally DOWN (a real link fault, not an operator-disabled port),
 * restricted to interfaces SELECTED FOR MONITORING (the asset's pinned
 * `monitoredInterfaces` list — the full system-info scrape samples every
 * interface, so without the pin filter every idle unpinned port would show as
 * an outage), grouped by the gate they live on. Two queries, flat at 2000
 * assets:
 *   1. ONE windowed single-pass CTE over asset_interface_samples joined to
 *      assets on `ifName = ANY(monitoredInterfaces)` (the pin filter runs
 *      BEFORE the window + LIMIT so pinned-down rows can't be crowded out by
 *      unpinned noise): latest sample per (asset, ifName) via row_number(),
 *      plus each interface's last "up" timestamp via a filtered window
 *      aggregate (for the "down for" duration). The time window keeps the
 *      hypertable scan inside recent (chunk-excluded) data; interface samples
 *      only exist for interface-polled assets (a network-gear subset), so the
 *      scan stays small. The 4h default window comfortably contains the latest
 *      full interface scrape at the default 600s systemInfo cadence even when
 *      an operator slows it.
 *   2. ONE findMany over the (small) set of assets that own a down interface,
 *      scoped to monitored + non-suppressed — an interface whose owning asset
 *      is unmonitored / suppressed / decommissioned drops out here (those assets
 *      stop being monitored, so only stale samples linger).
 */
// The windowed current-state CTE both down-feeds share: latest sample per
// (asset, <dim>) via row_number + the dimension's last-"up" timestamp via a
// filtered window max, with the pin-array JOIN running BEFORE the window +
// LIMIT so pinned-down rows can't be crowded out by unpinned noise. Every
// slot is a compile-time literal from the two call sites — nothing
// user-supplied enters the SQL text.
function downFeedSql(q: {
  table: string;       // sample hypertable
  dimCol: string;      // per-asset dimension column (ifName / tunnelName)
  pinCol: string;      // Asset pin array the JOIN filters on
  statusCol: string;   // the up/down column
  selectExtra: string; // extra projected columns ("" for none; trailing comma per line)
  downWhere: string;   // the rn=1 "down" predicate on the outer select
  selectOuter: string; // outer column list
  idClause: string;
}): string {
  return `WITH win AS (
       SELECT s."assetId" AS "assetId", s."${q.dimCol}" AS "${q.dimCol}",
              ${q.selectExtra}s."${q.statusCol}" AS "${q.statusCol}",
              row_number() OVER (PARTITION BY s."assetId", s."${q.dimCol}" ORDER BY s."timestamp" DESC) AS rn,
              max(s."timestamp") FILTER (WHERE s."${q.statusCol}" = 'up')
                OVER (PARTITION BY s."assetId", s."${q.dimCol}") AS "lastUpAt"
       FROM "${q.table}" s
       JOIN "assets" a ON a."id" = s."assetId" AND s."${q.dimCol}" = ANY(a."${q.pinCol}")
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${q.idClause}
     )
     SELECT ${q.selectOuter}
     FROM win
     WHERE rn = 1 AND ${q.downWhere}
     ORDER BY "lastUpAt" ASC NULLS FIRST
     LIMIT $2`;
}

// The shared owner hydrate: one findMany over the (small) set of assets that
// own a down row, scoped monitored + non-suppressed + not-in-maintenance so
// stale samples from stopped assets drop out.
async function hydrateDownFeedOwners(assetIds: string[]) {
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds }, monitored: true, dependencySuppressed: false, ...NOT_IN_MAINTENANCE },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true,
      location: true, learnedLocation: true, snmpLocation: true,
    },
  });
  return new Map(assets.map((a) => [a.id, a]));
}

export async function getDownInterfaces(limit: number | null = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownInterface[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; ifName: string; ifLabel: string | null; lastUpAt: Date | null }>>(
    downFeedSql({
      table: "asset_interface_samples",
      dimCol: "ifName",
      pinCol: "monitoredInterfaces",
      statusCol: "operStatus",
      selectExtra: `COALESCE(NULLIF(s."alias", ''), NULLIF(s."description", '')) AS "ifLabel",
              s."adminStatus" AS "adminStatus",
              `,
      downWhere: `"operStatus" = 'down' AND "adminStatus" = 'up'`,
      selectOuter: `"assetId", "ifName", "ifLabel", "lastUpAt"`,
      idClause,
    }),
    ...params,
  );
  if (rows.length === 0) return [];
  const byId = await hydrateDownFeedOwners(Array.from(new Set(rows.map((r) => r.assetId))));
  const out: DownInterface[] = [];
  for (const r of rows) {
    const a = byId.get(r.assetId);
    if (!a) continue;
    out.push({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      assetType: a.assetType,
      ifName: r.ifName,
      ifLabel: r.ifLabel,
      gate: gateOf(a),
      lastUpAt: r.lastUpAt,
    });
  }
  return severityFirst(await attachAlertSeverity(out, (r) => r.assetId, stateRel("ifOperStatus")));
}

export interface DownIpsecTunnel {
  assetId: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  tunnelName: string;
  parentInterface: string | null;
  remoteGateway: string | null;
  gate: string;
  lastUpAt: Date | null;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * Feed 2c — down IPsec tunnels. Phase-1 tunnels whose every phase-2 selector is
 * down (status='down'), restricted to tunnels SELECTED FOR MONITORING (the
 * asset's pinned `monitoredIpsecTunnels` list — same rationale and same SQL
 * shape as getDownInterfaces' pin filter: the scrape samples every configured
 * tunnel, including CMDB-synthesized rows for tunnels whose parent link is
 * dead, so without the pin gate an unpinned expected-down tunnel shows as an
 * outage forever), grouped by the gate they live on, each carrying the
 * parent physical interface the tunnel rides (the FortiOS phase1-interface WAN
 * port) so a NOC operator sees which uplink took the tunnel down. Same
 * shape/scale as getDownInterfaces: one windowed single-pass CTE over
 * asset_ipsec_tunnel_samples joined to assets on
 * `tunnelName = ANY(monitoredIpsecTunnels)` (pin filter BEFORE the window +
 * LIMIT), then a monitored/non-suppressed hydrate findMany. FortiGate-only
 * data; the 4h window covers the system-info scrape cadence. `partial`/`dynamic`
 * tunnels are intentionally excluded — only a fully-down tunnel is an outage.
 */
export async function getDownIpsecTunnels(limit: number | null = 100, sinceMinutes = 240, assetIds: string[] | null = null): Promise<DownIpsecTunnel[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; tunnelName: string; parentInterface: string | null; remoteGateway: string | null; lastUpAt: Date | null }>>(
    downFeedSql({
      table: "asset_ipsec_tunnel_samples",
      dimCol: "tunnelName",
      pinCol: "monitoredIpsecTunnels",
      statusCol: "status",
      selectExtra: `s."parentInterface" AS "parentInterface", s."remoteGateway" AS "remoteGateway",
              `,
      downWhere: `"status" = 'down'`,
      selectOuter: `"assetId", "tunnelName", "parentInterface", "remoteGateway", "lastUpAt"`,
      idClause,
    }),
    ...params,
  );
  if (rows.length === 0) return [];
  const byId = await hydrateDownFeedOwners(Array.from(new Set(rows.map((r) => r.assetId))));
  const out: DownIpsecTunnel[] = [];
  for (const r of rows) {
    const a = byId.get(r.assetId);
    if (!a) continue;
    out.push({
      assetId: a.id,
      hostname: a.hostname,
      ipAddress: a.ipAddress,
      assetType: a.assetType,
      tunnelName: r.tunnelName,
      parentInterface: r.parentInterface,
      remoteGateway: r.remoteGateway,
      gate: gateOf(a),
      lastUpAt: r.lastUpAt,
    });
  }
  return severityFirst(await attachAlertSeverity(out, (r) => r.assetId, stateRel("ipsecStatus")));
}

export interface TopNRow { id: string; hostname: string | null; ipAddress: string | null; value: number; detail?: string; site?: string; usedPct?: number; alertSeverity?: string; alertRank?: number }

// Hydrate a list of assetIds (preserving the incoming order) with display
// names in ONE findMany — never a per-row lookup. `site` uses the same
// location > learnedLocation > snmpLocation coalesce as Down Assets so the
// top-N widgets' "Group by: Site" buckets match across widgets.
async function hydrateNames(ordered: Array<{ assetId: string; value: number }>): Promise<TopNRow[]> {
  if (ordered.length === 0) return [];
  const ids = ordered.map((r) => r.assetId);
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  return ordered
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: r.value, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
}

// Default per-asset sample count the top-N averages smooth over. The widgets'
// "Average over" gear control overrides it per request (?samples=, 1..MAX).
export const DEFAULT_TOPN_SAMPLE_COUNT = 10;
export const MAX_TOPN_SAMPLE_COUNT = 100;

// The averaging window must comfortably contain sampleCount samples at any
// realistic cpuMemory cadence, while staying tight enough for TimescaleDB
// chunk exclusion. The historical 1h-for-10-samples budget = 6 min/sample.
function topNWindowMinutes(baseMinutes: number, sampleCount: number): number {
  return Math.max(baseMinutes, sampleCount * 6);
}

function clampSampleCount(n: number | null | undefined): number {
  if (!Number.isFinite(n as number) || (n as number) <= 0) return DEFAULT_TOPN_SAMPLE_COUNT;
  return Math.min(Math.trunc(n as number), MAX_TOPN_SAMPLE_COUNT);
}

/**
 * Feed 3a — highest CPU, averaged over each asset's most-recent `sampleCount`
 * samples (default 10 — smooths the single-spike ranking the DISTINCT-ON
 * latest-value version surfaced; 1 = rank on the latest sample only). The time
 * predicate keeps the scan inside recent Timescale chunks (~one telemetry
 * sample per asset per cadence); row_number()<=N takes the newest N per asset.
 */
export async function getHighestCpu(limit: number | null = 100, sinceMinutes = 60, assetIds: string[] | null = null, sampleCount: number = DEFAULT_TOPN_SAMPLE_COUNT): Promise<TopNRow[]> {
  const samples = clampSampleCount(sampleCount);
  const idClause = assetIds ? ` AND s."assetId" = ANY($4::text[])` : "";
  const params: unknown[] = [String(topNWindowMinutes(sinceMinutes, samples)), limit, samples];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId", s."cpuPct" AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval AND s."cpuPct" IS NOT NULL${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= $3
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return topNWithSeverity(await hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 }))), metricRel("cpuPct"));
}

/**
 * Feed 3b — highest memory, averaged over each asset's most-recent
 * `sampleCount` samples (same windowed pattern as CPU). Prefers memPct; falls
 * back to bytes ratio when only absolute bytes were reported (same preference
 * as sampleHistoryService).
 */
export async function getHighestMemory(limit: number | null = 100, sinceMinutes = 60, assetIds: string[] | null = null, sampleCount: number = DEFAULT_TOPN_SAMPLE_COUNT): Promise<TopNRow[]> {
  const samples = clampSampleCount(sampleCount);
  const idClause = assetIds ? ` AND s."assetId" = ANY($4::text[])` : "";
  const params: unknown[] = [String(topNWindowMinutes(sinceMinutes, samples)), limit, samples];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; value: number }>>(
    `WITH recent AS (
       SELECT s."assetId" AS "assetId",
              COALESCE(s."memPct", s."memUsedBytes"::float / NULLIF(s."memTotalBytes", 0) * 100) AS v,
              row_number() OVER (PARTITION BY s."assetId" ORDER BY s."timestamp" DESC) AS rn
       FROM "asset_telemetry_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND (s."memPct" IS NOT NULL OR (s."memUsedBytes" IS NOT NULL AND s."memTotalBytes" IS NOT NULL))${idClause}
     )
     SELECT "assetId", avg(v)::float AS value
     FROM recent WHERE rn <= $3 AND v IS NOT NULL
     GROUP BY "assetId"
     ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  return topNWithSeverity(await hydrateNames(rows.map((r) => ({ assetId: r.assetId, value: Math.round(r.value * 10) / 10 }))), metricRel("memPct", "memUsedBytes"));
}

/**
 * Feed 4 — slowest response. Reads the already-maintained
 * Asset.lastResponseTimeMs (stamped by recordProbeResult) — fresher and far
 * cheaper than scanning the monitor-sample hypertable.
 */
export async function getSlowestResponse(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 360): Promise<TopNRow[]> {
  // Average of each asset's most-recent 10 response times (smooths the single-
  // probe spikes the instantaneous lastResponseTimeMs ranking surfaced). The
  // time window bounds the hypertable scan to recent chunks (TimescaleDB chunk
  // exclusion) so this stays cheap at 2000 assets; 6h comfortably contains 10
  // probes for any realistic cadence, and row_number()<=10 takes the newest 10.
  const idClause = assetIds ? ` AND "assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; avg_ms: number }>>(
    `WITH recent AS (
       SELECT "assetId", "responseTimeMs",
              row_number() OVER (PARTITION BY "assetId" ORDER BY "timestamp" DESC) AS rn
       FROM "asset_monitor_samples"
       WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND "responseTimeMs" IS NOT NULL
         AND ("probeKind" IS NULL OR "probeKind" = 'primary')${idClause}
     )
     SELECT "assetId", avg("responseTimeMs")::float AS avg_ms
     FROM recent
     WHERE rn <= 10
     GROUP BY "assetId"
     ORDER BY avg_ms DESC
     LIMIT $2`,
    ...params,
  );
  const ordered = rows.map((r) => ({ assetId: r.assetId, value: Math.round(Number(r.avg_ms) * 10) / 10 }));
  return topNWithSeverity(await hydrateNames(ordered), metricRel("responseTimeMs"));
}

/**
 * Feed 4b — highest disk usage, PER VOLUME (one row per (asset, mountPath) at
 * its latest sample's used %). Ranks the fullest filesystems across the fleet
 * so a NOC operator sees what's about to fill up. Each row's `detail` carries
 * the mount path (the bar widget shows it beside the hostname). DISTINCT-ON
 * latest-per-(asset,mount) over asset_storage_samples; the window is wide (48h
 * default) because the full storage scrape rides the 24h "slow" cadence.
 */
export async function getHighestDiskUsage(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 2880): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; mountPath: string; pct: number }>>(
    `SELECT "assetId", "mountPath", pct FROM (
       SELECT DISTINCT ON (s."assetId", s."mountPath")
              s."assetId" AS "assetId", s."mountPath" AS "mountPath",
              s."usedBytes"::float / s."totalBytes"::float * 100 AS pct
       FROM "asset_storage_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND s."usedBytes" IS NOT NULL AND s."totalBytes" IS NOT NULL AND s."totalBytes" > 0${idClause}
       ORDER BY s."assetId", s."mountPath", s."timestamp" DESC
     ) latest ORDER BY pct DESC LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  // Hydrate names in ONE findMany (an asset appears once per volume, so dedupe
  // the id set for the lookup), then attach hostname + mount-path detail.
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = rows
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: Math.round(r.pct * 10) / 10, detail: r.mountPath, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
  return topNWithSeverity(out, metricRel("storageUsedPct"));
}

/**
 * Feed 4c — highest temperature, PER SENSOR (one row per (asset, sensorName) at
 * its latest sample's reading). Ranks the hottest hardware sensors across the
 * fleet; each row's `detail` carries the sensor name. DISTINCT-ON latest-per-
 * (asset,sensor) over asset_hardware_sensor_samples scoped to
 * sensorClass='temperature' — that class is always °C (classifyHardwareSensor),
 * so values compare directly. The 4h window comfortably contains the latest
 * scrape at the default temperature-stream cadence even when an operator
 * slows it, while keeping the hypertable scan chunk-excluded.
 */
export async function getHighestTemperature(limit: number | null = 100, assetIds: string[] | null = null, sinceMinutes = 240): Promise<TopNRow[]> {
  const idClause = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(sinceMinutes), limit];
  if (assetIds) params.push(assetIds);
  const rows = await prisma.$queryRawUnsafe<Array<{ assetId: string; sensorName: string; value: number }>>(
    `SELECT "assetId", "sensorName", value FROM (
       SELECT DISTINCT ON (s."assetId", s."sensorName")
              s."assetId" AS "assetId", s."sensorName" AS "sensorName", s."value" AS value
       FROM "asset_hardware_sensor_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval
         AND s."sensorClass" = 'temperature' AND s."value" IS NOT NULL${idClause}
       ORDER BY s."assetId", s."sensorName", s."timestamp" DESC
     ) latest ORDER BY value DESC LIMIT $2`,
    ...params,
  );
  if (rows.length === 0) return [];
  // Hydrate names in ONE findMany (an asset appears once per sensor, so dedupe
  // the id set for the lookup), then attach hostname + sensor-name detail.
  const ids = Array.from(new Set(rows.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = rows
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return { id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, value: Math.round(r.value * 10) / 10, detail: r.sensorName, site: siteOf(a) };
    })
    .filter((r): r is TopNRow => r !== null);
  return topNWithSeverity(out, metricRel("hwSensorValue"));
}

/**
 * Feed 5 (data-gap Option A) — packet loss = failed-probe ratio over the
 * window. One windowed groupBy over asset_monitor_samples; no schema change.
 * (True per-probe loss% via multi-ping is a documented follow-up.)
 *
 * Assets at 100% loss (zero successful probes in the window) are excluded —
 * that's a hard-down asset, already surfaced by the Down Assets widget, and
 * listing it here as "packet loss" is redundant noise. The shared query keeps
 * only assets with at least one success and the HAVING adds at least one
 * failure, so only genuinely lossy (intermittent) assets qualify. Loss is
 * counted from each asset's first successful probe in the window, so a node
 * recovering from an outage drops off this list on its next clean probe rather
 * than topping it for a full window (probeLossQuery's header explains why).
 */
export async function getPacketLoss(limit: number | null = 100, sinceMinutes = 15, assetIds: string[] | null = null): Promise<TopNRow[]> {
  // includeFullyDown: a device that answered nothing in the window pegs at 100%
  // rather than dropping off the widget (which would read as "no loss"). Display
  // only — the engine path must not, or a loss automation would double-alert an
  // outage asset-down already owns.
  // `includeFullyDown` retired 2026-09-01: with the first-success anchor gone
  // every row in the window counts, so an asset with no successful probe reads
  // 100% naturally instead of needing an opt-in to avoid vanishing.
  const rows = await queryProbeLossRatios({ sinceMinutes, assetIds, onlyLossy: true, limit });
  const ordered = rows.map((r) => ({
    assetId: r.assetId,
    value: Math.round((Number(r.failed) / Number(r.total)) * 1000) / 10,
  }));
  return topNWithSeverity(await hydrateNames(ordered), metricRel("probeLossPct"));
}

/**
 * Feed 4d — storage forecast: days until each growing filesystem fills, from
 * the shared 30-day trend (storageForecastService — regr_slope over detail +
 * daily-rollup day buckets; growing mounts with ≥7 points only). Row value =
 * projected days (LOWER is worse — the widget inverts its thresholds), detail
 * = mount path, usedPct = latest fill level. Severity-first like every feed;
 * within a severity band soonest-full leads.
 */
export async function getStorageForecast(limit: number | null = 100, assetIds: string[] | null = null): Promise<TopNRow[]> {
  const fc = await computeStorageForecast(assetIds);
  const capped = limit != null ? fc.slice(0, limit) : fc;
  if (capped.length === 0) return [];
  const ids = Array.from(new Set(capped.map((r) => r.assetId)));
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: { id: true, hostname: true, ipAddress: true, location: true, learnedLocation: true, snmpLocation: true },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out = capped
    .map((r): TopNRow | null => {
      const a = byId.get(r.assetId);
      if (!a) return null;
      return {
        id: a.id, hostname: a.hostname, ipAddress: a.ipAddress,
        value: r.daysUntilFull, detail: r.mountPath, site: siteOf(a),
        usedPct: r.usedPct ?? undefined,
      };
    })
    .filter((r): r is TopNRow => r !== null);
  return topNWithSeverity(out, metricRel("storageDaysUntilFull"));
}

export interface StalePoll { id: string; hostname: string | null; ipAddress: string | null; lastPolledAt: Date | null; expectedIntervalSec: number; alertSeverity?: string; alertRank?: number }

/**
 * Feed 6 — stale polls (overdue for their next response-time probe). Two-stage:
 * Stage A is an indexed findMany over candidates that are clearly stale by a
 * coarse floor (uses @@index([monitored, lastMonitorAt])); Stage B resolves
 * the exact per-asset cadence via resolveMonitorSettings (its tier loaders are
 * cached, so the candidate set's few distinct integration×type combos cost
 * almost nothing) and keeps only the genuinely overdue ones.
 *
 * @param grace multiplier on the resolved interval before "stale" (default 3×)
 */
export async function getStalePolls(grace = 3, limit: number | null = 50, assetIds: string[] | null = null): Promise<StalePoll[]> {
  // Coarse pre-filter: anything not polled within COARSE_FLOOR can't be fresh
  // for any realistic interval. Bounds Stage B's candidate set.
  const COARSE_FLOOR_MS = 5 * 60 * 1000; // 5 min — below the shortest sane cadence × grace
  const now = Date.now();
  const candidates = await prisma.asset.findMany({
    where: {
      monitored: true,
      // Maintenance windows pause polling entirely — without this exclusion
      // every in-window asset drifts into "stale polls" once past the grace.
      ...NOT_IN_MAINTENANCE,
      OR: [{ lastMonitorAt: null }, { lastMonitorAt: { lt: new Date(now - COARSE_FLOOR_MS) } }],
      ...idWhere(assetIds),
    },
    select: {
      id: true, hostname: true, ipAddress: true, lastMonitorAt: true,
      assetType: true, discoveredByIntegrationId: true,
      discoveredByIntegration: { select: { type: true } },
      monitorIntervalSec: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      systemInfoIntervalSec: true, lldpIntervalSec: true, storageIntervalSec: true,
      probeTimeoutMs: true, dependencySuppressed: true,
    },
    orderBy: { lastMonitorAt: { sort: "asc", nulls: "first" } },
    take: limit == null ? undefined : 500,
  });

  const out: StalePoll[] = [];
  for (const a of candidates) {
    const eff = await resolveMonitorSettings({
      assetType: a.assetType,
      discoveredByIntegrationId: a.discoveredByIntegrationId,
      discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
      monitorIntervalSec: a.monitorIntervalSec,
      cpuMemoryIntervalSec: a.cpuMemoryIntervalSec,
      temperatureIntervalSec: a.temperatureIntervalSec,
      systemInfoIntervalSec: a.systemInfoIntervalSec,
      lldpIntervalSec: a.lldpIntervalSec,
      storageIntervalSec: a.storageIntervalSec,
      probeTimeoutMs: a.probeTimeoutMs,
    });
    // Suppressed assets probe at 2× their interval (same rule as monitorAssets).
    const intervalSec = eff.intervalSeconds * (a.dependencySuppressed ? 2 : 1);
    const overdueMs = grace * intervalSec * 1000;
    const last = a.lastMonitorAt ? a.lastMonitorAt.getTime() : null;
    if (last === null || now - last >= overdueMs) {
      out.push({ id: a.id, hostname: a.hostname, ipAddress: a.ipAddress, lastPolledAt: a.lastMonitorAt, expectedIntervalSec: intervalSec });
      if (limit != null && out.length >= limit) break;
    }
  }
  // No automation dimension corresponds to "overdue for polling", so a stale-
  // poll row never wears a severity pill (kind:"none" short-circuits the join).
  return severityFirst(await attachAlertSeverity(out, (r) => r.id, { kind: "none" }));
}

export interface RebootRow { id: string; hostname: string | null; ipAddress: string | null; rebootedAt: Date; alertSeverity?: string; alertRank?: number }

/**
 * Feed 7 — recent reboots. Reads device.reboot Events emitted by the probe
 * path when an asset's sysUptime drops (see monitoringService reboot
 * detection). Event-backed so the widget never scans the hypertable.
 */
export async function getRecentReboots(sinceHours = 72, limit: number | null = 20, assetIds: string[] | null = null): Promise<RebootRow[]> {
  const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const events = await prisma.event.findMany({
    where: {
      action: "device.reboot",
      timestamp: { gte: cutoff },
      // device.reboot events carry resourceId = assetId; scope to the filtered set.
      ...(assetIds ? { resourceId: { in: assetIds } } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit ?? undefined,
  });
  const out: RebootRow[] = events.map((e) => {
    const details = (e.details ?? {}) as Record<string, unknown>;
    return {
      id: e.resourceId ?? "",
      hostname: e.resourceName ?? (typeof details.hostname === "string" ? details.hostname : null),
      ipAddress: typeof details.ipAddress === "string" ? details.ipAddress : null,
      rebootedAt: e.timestamp,
    };
  });
  return severityFirst(await attachAlertSeverity(out, (r) => r.id || null, eventRel("device.reboot")));
}

export interface AlertRow {
  id: string;
  /** The alerting asset, for the widget's click-through to its details
   *  slide-in. Null on a host/system-scoped alert (one about Polaris itself)
   *  and on an alert whose asset has since been deleted. */
  assetId: string | null;
  hostname: string | null;
  /** The sub-asset the alert is ABOUT — a port, sensor, mount or tunnel
   *  (Notification.dimension). Null for whole-device / composite / event
   *  alerts. Carried because one per-interface automation raises one alert per
   *  pinned port, same minute and same message template: without it a switch
   *  that loses its uplinks fills the widget with rows that differ in nothing. */
  dimension: string | null;
  message: string;
  severity: string;
  raisedAt: Date;
  ruleName: string | null;
  /** The KIND of automation behind the alert — the raising rule's
   *  `trigger.type` (`asset_metric` | `asset_state` | `host_metric` | `event` |
   *  `change` | `composite`), null when the rule is gone or its trigger is
   *  unreadable. Carried for the widget's "event-triggered alerts" toggle: an
   *  event rule fires off an audit Event (`agent.disconnected`, a failed sync)
   *  rather than off a reading, so an operator watching device health wants
   *  them out of the feed while the operator watching integrations wants them
   *  in. Read from the rule, not stored on the Notification, because the
   *  automation is where the kind lives — a rule retyped after the alert was
   *  raised is still the rule the alert belongs to. */
  triggerType: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
}

export interface ActiveAlerts {
  alerts: AlertRow[];
  /** Uncleared alerts matching the filter BEFORE the row cap — so the widget
   *  can say "30 of 214" instead of silently ending at its limit. Free: the
   *  ordering already requires fetching the whole set. */
  total: number;
}

/**
 * Feed 8 — active alerts. The UNCLEARED `Notification` rows, severity-first
 * (the automation ladder in ALERT_SEVERITY_RANK) then newest.
 *
 * This reads ALERTS, not Events — the distinction is the whole point of the
 * feed. It previously listed every `Event` at levelRank >= 1, which made the
 * widget wrong in both directions: raw discovery/sync failures nobody had
 * written an automation for showed up as permanent "alerts" (nothing clears an
 * Event, so they sat there for the full 7-day retention), while the severity
 * pill came from `Event.level` — and `severityLevel()` in notificationEngine
 * collapses critical AND serious into "error", so a `serious` automation
 * displayed as "error". Reading the Notification row instead means an alert
 * appears only because an automation raised it, carries that automation's own
 * severity, disappears when it clears, and shows who acknowledged it.
 *
 * Severity ordering can't ride an index (severity is a string, not a rank
 * column), so the uncleared set is fetched with a tight select and ordered in
 * memory — the same posture as `activeAlertSeverityByAsset` above, which
 * already reads that whole set on every pill decoration. `cleared: false` is
 * covered by @@index([cleared, acknowledged]).
 *
 * `assetHostname` is snapshotted on the Notification, so a row still names its
 * device after the asset is deleted.
 *
 * An asset filter (region / type / gate) narrows to its id set but KEEPS the
 * assetId-null rows — an alert about Polaris itself (a host_metric rule, a
 * system-scoped event) belongs on every wallboard, because no asset filter can
 * say anything about it and a Polaris outage matters in every region. These
 * used to drop out "mirroring the Event-sourced feeds", but that analogy was
 * weak: those feeds are per-asset by construction, so they have no such rows.
 *
 * `total` is the uncleared count before the cap. The widget's whole promise is
 * that an active alert appears in it, so where the cap bites has to be visible
 * — one automation on a switch raises one alert per pinned port, and a fleet
 * losing a gate can produce hundreds in a minute.
 */
export async function getRecentAlerts(limit: number | null = 100, assetIds: string[] | null = null): Promise<ActiveAlerts> {
  const rows = await prisma.notification.findMany({
    where: {
      cleared: false,
      ...(assetIds ? { OR: [{ assetId: { in: assetIds } }, { assetId: null }] } : {}),
    },
    select: {
      id: true, ruleId: true, assetId: true, assetHostname: true, dimension: true, message: true,
      severity: true, triggeredAt: true,
      acknowledged: true, acknowledgedBy: true, rule: { select: { name: true } },
    },
    orderBy: { triggeredAt: "desc" },
  });
  const triggerTypeByRule = await triggerTypesFor(rows);
  const out: AlertRow[] = rows.map((n) => ({
    id: n.id,
    assetId: n.assetId ?? null,
    hostname: n.assetHostname ?? null,
    dimension: n.dimension ?? null,
    message: n.message,
    severity: n.severity,
    raisedAt: n.triggeredAt,
    ruleName: n.rule?.name ?? null,
    triggerType: (n.ruleId && triggerTypeByRule.get(n.ruleId)) || null,
    acknowledged: n.acknowledged,
    acknowledgedBy: n.acknowledgedBy ?? null,
  }));
  out.sort((a, b) => {
    const d = (ALERT_SEVERITY_RANK[b.severity] ?? 0) - (ALERT_SEVERITY_RANK[a.severity] ?? 0);
    if (d !== 0) return d;
    const t = b.raisedAt.getTime() - a.raisedAt.getTime();
    if (t !== 0) return t;
    // Same automation, same minute, one alert per port: order the dimension
    // NUMERICALLY so port2 precedes port10 (the asset Alerts tab's tiebreak).
    return compareDimensions(a.dimension, b.dimension);
  });
  return { alerts: limit === null ? out : out.slice(0, limit), total: out.length };
}

/**
 * ruleId → `trigger.type`, for the alert rows just fetched.
 *
 * One extra query over the DISTINCT rules present, not a `rule: { trigger }`
 * join on the notification select: `trigger` is a JSON column carrying a whole
 * condition tree (a composite rule's runs to kilobytes), and the join would
 * ship one copy PER ALERT. A fleet of 2000 assets losing a gate has thousands
 * of uncleared rows behind a handful of automations, so the join is megabytes
 * of duplicate JSON on a feed that ticks every 30s; the id set is tens of rows.
 */
async function triggerTypesFor(rows: { ruleId: string | null }[]): Promise<Map<string, string>> {
  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((id): id is string => !!id))];
  if (!ruleIds.length) return new Map();
  const rules = await prisma.notificationRule.findMany({
    where: { id: { in: ruleIds } },
    select: { id: true, trigger: true },
  });
  const out = new Map<string, string>();
  for (const r of rules) {
    const t = (r.trigger as { type?: unknown } | null)?.type;
    if (typeof t === "string") out.set(r.id, t);
  }
  return out;
}

/** Natural-order compare for a dimension label (port2 < port10). Nulls last. */
function compareDimensions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export interface SiteWithIssues {
  site: string;
  division: string | null;
  downCount: number;
  warningCount: number;
  total: number;
  lat: number | null;
  lng: number | null;
  nodes: Array<{ id: string; hostname: string | null; monitorStatus: string | null }>;
  alertSeverity?: string;
  alertRank?: number;
}

/**
 * Feed 9 — sites with issues. One raw COALESCE groupBy over the monitored set
 * for the per-site counts + avg coordinates, then ONE bounded findMany to
 * attach the affected nodes. Two queries total, flat at 2000 assets.
 */
export async function getSitesWithIssues(maxSites: number | null = 25, assetIds: string[] | null = null): Promise<SiteWithIssues[]> {
  const idClause = assetIds ? ` AND "id" = ANY($2::text[])` : "";
  const siteParams: unknown[] = [maxSites];
  if (assetIds) siteParams.push(assetIds);
  const siteRows = await prisma.$queryRawUnsafe<Array<{
    site: string; down: bigint; warning: bigint; total: bigint; lat: number | null; lng: number | null;
  }>>(
    `SELECT COALESCE(NULLIF("location", ''), NULLIF("learnedLocation", ''), NULLIF("snmpLocation", ''), '(unknown)') AS site,
            count(*) FILTER (WHERE "monitorStatus" = 'down'    AND "status" <> 'maintenance') AS down,
            count(*) FILTER (WHERE "monitorStatus" = 'warning' AND "status" <> 'maintenance') AS warning,
            count(*) AS total,
            round(avg("latitude")::numeric, 4)::float8  AS lat,
            round(avg("longitude")::numeric, 4)::float8 AS lng
     FROM "assets"
     WHERE "monitored" = true AND "dependencySuppressed" = false${idClause}
     GROUP BY 1
     HAVING count(*) FILTER (WHERE "monitorStatus" IN ('down', 'warning') AND "status" <> 'maintenance') > 0
     ORDER BY down DESC, warning DESC
     LIMIT $1`,
    ...siteParams,
  );
  if (siteRows.length === 0) return [];

  // Pull the affected (down/warning) nodes for these sites in one query, then
  // bucket by site. Bounded by the issue set, not the whole fleet.
  const nodeRows = await prisma.asset.findMany({
    where: { monitored: true, dependencySuppressed: false, monitorStatus: { in: ["down", "warning"] }, ...NOT_IN_MAINTENANCE, ...idWhere(assetIds) },
    select: {
      id: true, hostname: true, monitorStatus: true,
      location: true, learnedLocation: true, snmpLocation: true, department: true,
    },
  });
  const nodesBySite = new Map<string, SiteWithIssues["nodes"]>();
  const divisionBySite = new Map<string, string | null>();
  for (const n of nodeRows) {
    const s = siteOf(n);
    if (!nodesBySite.has(s)) { nodesBySite.set(s, []); divisionBySite.set(s, n.department); }
    nodesBySite.get(s)!.push({ id: n.id, hostname: n.hostname, monitorStatus: n.monitorStatus });
  }

  const sites: SiteWithIssues[] = siteRows.map((r) => ({
    site: r.site,
    division: divisionBySite.get(r.site) ?? null,
    downCount: Number(r.down),
    warningCount: Number(r.warning),
    total: Number(r.total),
    lat: r.lat,
    lng: r.lng,
    nodes: nodesBySite.get(r.site) ?? [],
  }));
  // Per-site severity = the highest active alert across the site's affected
  // nodes; sites with alerted nodes lead, then the down/warning ordering holds.
  const sev = await activeAlertSeverityByAsset(nodeRows.map((n) => n.id), stateRel("monitorStatus"));
  for (const s of sites) {
    let best: { severity: string; rank: number } | null = null;
    for (const n of s.nodes) {
      const x = sev.get(n.id);
      if (x && (!best || x.rank > best.rank)) best = x;
    }
    if (best) { s.alertSeverity = best.severity; s.alertRank = best.rank; }
    else s.alertRank = 0;
  }
  return sites.slice().sort((a, b) => (b.alertRank ?? 0) - (a.alertRank ?? 0));
}

export interface FilterOptions {
  assetTypes: Array<{ name: string; label: string }>;
  regions: string[];
  fortigates: Array<{ name: string; regions: string[] }>;
}

/**
 * Options for the NOC dashboard's global filters:
 *   - assetTypes: `{name, label}` entries for the per-widget asset-type grid —
 *     every built-in (canonical order, so the grid is stable on a fleet that
 *     happens to own no printers) followed by every CUSTOM type the
 *     AssetTypeDef registry carries, UNIONED with any custom name still worn
 *     by a live asset whose registry row is gone, by label. Labels come from
 *     the registry, which is why the grid can name a custom type instead of
 *     printing its snake_case value. The custom half was present-only until
 *     2026-09 — a type the operator had just created in Server Settings had
 *     no checkbox until something was typed as it, which reads as the grid
 *     not knowing about the type at all (reported that way). The registry is
 *     the vocabulary an operator sees, so it is the vocabulary the grid
 *     offers, matching the Assets page's Type filter (`/asset-types`); the
 *     present-set union is what keeps a retired-but-still-stamped name
 *     switchable rather than stranding it in a config's off-list with no way
 *     to switch it back on. The widgets used to get a bare `string[]` of
 *     built-ins here and never read it — the grid was drawn from a static
 *     list, so a custom type could not be filtered at all.
 *   - regions: distinct `region:<name>` tag values across the live fleet, the
 *     same tags the `regionTags` filter matches. Sorted.
 *   - fortigates: `{name, regions}` entries for the "Selected FortiGates"
 *     picker — name = the `learnedLocation` of a live firewall asset
 *     (Fortinet discovery stamps a firewall's own FMG/device hostname there,
 *     the same name managed switches / APs / endpoints reference), so every
 *     offered option is guaranteed to match at least the gate itself;
 *     regions = the gate's own `region:<name>` tags, letting the picker
 *     narrow its list to the widget's selected regions client-side.
 *     Non-Fortinet operator-typed firewalls carry no learnedLocation and are
 *     naturally excluded. Sorted by name.
 * Four cheap queries; safe for a read-only NOC kiosk token.
 */
export async function getFilterOptions(): Promise<FilterOptions> {
  const [typeRows, registryRows, regionRows, fortigateRows] = await Promise.all([
    prisma.asset.findMany({
      where: { status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { assetType: true },
      distinct: ["assetType"],
    }),
    prisma.assetTypeDef.findMany({ select: { name: true, label: true } }),
    prisma.$queryRaw<Array<{ region: string }>>`
      SELECT DISTINCT substring(t from 8) AS region
      FROM "assets", unnest("tags") AS t
      WHERE t LIKE 'region:%'
        AND "status" NOT IN ('decommissioned', 'disabled')
      ORDER BY region`,
    prisma.asset.findMany({
      where: {
        assetType: "firewall",
        learnedLocation: { not: null },
        status: { notIn: EXCLUDED_LIFECYCLE_STATUSES },
      },
      select: { learnedLocation: true, tags: true },
      distinct: ["learnedLocation"],
    }),
  ]);
  const present = new Set(typeRows.map((r) => r.assetType));
  const labels = new Map(registryRows.map((r) => [r.name, r.label]));
  // A registry row is the label source; a type with no row (a name still on
  // assets after its row was deleted) gets its snake_case value humanized.
  const labelFor = (name: string) =>
    labels.get(name) || name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  // Registry first (the vocabulary Server Settings shows, whether or not the
  // fleet owns one yet), then any orphan name still stamped on a live asset.
  const customNames = new Set<string>();
  for (const name of [...registryRows.map((r) => r.name), ...present]) {
    if (name && !(BUILTIN_ASSET_TYPES as readonly string[]).includes(name)) customNames.add(name);
  }
  const customTypes = [...customNames]
    .map((name) => ({ name, label: labelFor(name) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    assetTypes: BUILTIN_ASSET_TYPES.map((name) => ({ name, label: labelFor(name) })).concat(customTypes),
    regions: regionRows.map((r) => r.region).filter(Boolean),
    fortigates: fortigateRows
      .filter((r): r is typeof r & { learnedLocation: string } => Boolean(r.learnedLocation))
      .map((r) => ({
        name: r.learnedLocation,
        regions: (r.tags || [])
          .filter((t) => t.startsWith("region:"))
          .map((t) => t.slice("region:".length)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─── Per-feed payload assembly + short-TTL cache ─────────────────────────────

export const NOC_FEED_NAMES = [
  "status", "downNodes", "downInterfaces", "downIpsecTunnels",
  "topCpu", "topMemory", "slowestResponse", "packetLoss", "diskUsage", "temperature",
  "storageForecast", "stalePolls", "sitesWithIssues", "recentReboots", "activeAlerts",
] as const;
export type NocFeedName = (typeof NOC_FEED_NAMES)[number];

const EMPTY_STATUS: StatusSummary = {
  statusCounts: { total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, passive: 0, maintenance: 0 },
  uptimePercent: null,
  activeAlertCount: 0,
};

/**
 * Feed registry. Per feed:
 *   gate    — which read permission covers it (asset- vs Event-sourced)
 *   empty   — the value a denied caller gets (filter-don't-403 contract)
 *   run     — compute the response value; L(n) resolves the caller's row cap
 *             (?limit=N clamped by the route) against the feed's default;
 *             `samples` is the caller's per-asset averaging count (?samples=,
 *             default DEFAULT_TOPN_SAMPLE_COUNT) — only the usesSamples feeds
 *             consume it (and only those include it in their cache key)
 *             `depDown` is the caller's include-dependency-down choice, on the
 *             same terms: only the usesDepDown feed reads it or keys on it
 *   flatten — map the feed value onto response keys. Default is {[feed]: v};
 *             `status` fans out to three top-level keys and `downNodes`
 *             unwraps `.nodes`, both preserved from the pre-feeds response
 *             shape so existing consumers (and the kiosk token) see no change.
 */
const NOC_FEEDS: Record<NocFeedName, {
  gate: "assets" | "events" | "alerts";
  empty: unknown;
  usesSamples?: true;
  usesDepDown?: true;
  run: (L: (n: number) => number | null, assetIds: string[] | null, samples: number, depDown: boolean) => Promise<unknown>;
  flatten?: (value: unknown) => Record<string, unknown>;
}> = {
  status: {
    gate: "assets",
    empty: EMPTY_STATUS,
    run: (_L, ids) => getStatusSummary(ids),
    flatten: (v) => {
      const s = v as StatusSummary;
      return { statusCounts: s.statusCounts, uptimePercent: s.uptimePercent, activeAlertCount: s.activeAlertCount };
    },
  },
  downNodes: {
    gate: "assets",
    empty: { nodes: [], total: 0 },
    usesDepDown: true,
    run: (L, ids, _samples, depDown) => getDownNodes(L(100), ids, depDown),
    // downNodesTotal is the TRUE down count (uncapped) for the widget's
    // header pill; downNodes[] stays the capped list (legacy key unchanged).
    flatten: (v) => {
      const d = v as { nodes: DownNode[]; total: number };
      return { downNodes: d.nodes, downNodesTotal: d.total };
    },
  },
  downInterfaces:   { gate: "assets", empty: [], run: (L, ids) => getDownInterfaces(L(100), 240, ids) },
  downIpsecTunnels: { gate: "assets", empty: [], run: (L, ids) => getDownIpsecTunnels(L(100), 240, ids) },
  topCpu:           { gate: "assets", empty: [], usesSamples: true, run: (L, ids, samples) => getHighestCpu(L(100), 60, ids, samples) },
  topMemory:        { gate: "assets", empty: [], usesSamples: true, run: (L, ids, samples) => getHighestMemory(L(100), 60, ids, samples) },
  slowestResponse:  { gate: "assets", empty: [], run: (L, ids) => getSlowestResponse(L(100), ids) },
  packetLoss:       { gate: "assets", empty: [], run: (L, ids) => getPacketLoss(L(100), 15, ids) },
  diskUsage:        { gate: "assets", empty: [], run: (L, ids) => getHighestDiskUsage(L(100), ids) },
  temperature:      { gate: "assets", empty: [], run: (L, ids) => getHighestTemperature(L(100), ids) },
  storageForecast:  { gate: "assets", empty: [], run: (L, ids) => getStorageForecast(L(100), ids) },
  stalePolls:       { gate: "assets", empty: [], run: (L, ids) => getStalePolls(3, L(50), ids) },
  sitesWithIssues:  { gate: "assets", empty: [], run: (L, ids) => getSitesWithIssues(L(25), ids) },
  recentReboots:    { gate: "events", empty: [], run: (L, ids) => getRecentReboots(72, L(20), ids) },
  activeAlerts: {
    gate: "alerts",
    empty: { alerts: [], total: 0 },
    run: (L, ids) => getRecentAlerts(L(100), ids),
    // activeAlertsTotal is the TRUE uncleared count (pre-cap) for the widget's
    // overflow cue; activeAlerts[] stays the capped list (legacy key unchanged,
    // so a pre-upgrade cached payload / kiosk token reads the same shape).
    flatten: (v) => {
      const d = v as ActiveAlerts;
      return { activeAlerts: d.alerts, activeAlertsTotal: d.total };
    },
  },
};

// 10s: below the frontend's 15s memo, so a widget's own refresh timer never
// sees data older than ~25s, while every concurrent viewer (multiple NOC
// walls / operator tabs) shares one computation of each hypertable scan.
export const NOC_FEED_CACHE_TTL_MS = 10_000;
const nocFeedCache = createTtlCache<unknown>({ ttlMs: NOC_FEED_CACHE_TTL_MS, maxEntries: 512 });

/** Test hook — drop every cached feed/filter entry. */
export function clearNocFeedCache(): void {
  nocFeedCache.invalidate();
}

function filterCacheKey(
  assetTypes: string[] | null,
  hideAssetTypes: string[] | null,
  regionNames: string[] | null,
  fortigateNames: string[] | null,
): string {
  const t = (assetTypes ?? []).slice().sort().join(",");
  const h = (hideAssetTypes ?? []).slice().sort().join(",");
  const r = (regionNames ?? []).slice().sort().join(",");
  const f = (fortigateNames ?? []).slice().sort().join(",");
  return t + "|" + h + "|" + r + "|" + f;
}

/**
 * Assemble the /noc-summary response. `feeds` narrows to the named subset
 * (unknown names are dropped silently, mirroring the source-type param
 * convention); null = every feed (the pre-feeds full payload, byte-identical
 * shape). Permission-denied feeds come back as their empty value, never 403.
 * Each (feed, filter, cap[, samples]) computation goes through the shared TTL
 * cache, as does the filter→assetIds resolution.
 */
export async function getNocSummaryPayload(opts: {
  feeds: string[] | null;
  canAssets: boolean;
  canEvents: boolean;
  canAlerts: boolean;
  assetTypes: string[] | null;
  hideAssetTypes?: string[] | null;
  regionNames: string[] | null;
  fortigateNames?: string[] | null;
  capLimit: number | null;
  sampleCount?: number | null;
  includeDependencyDown?: boolean;
}): Promise<Record<string, unknown>> {
  const requested: NocFeedName[] = opts.feeds === null
    ? [...NOC_FEED_NAMES]
    : opts.feeds.filter((f): f is NocFeedName => Object.prototype.hasOwnProperty.call(NOC_FEEDS, f));

  const fortigateNames = opts.fortigateNames ?? null;
  const hideAssetTypes = opts.hideAssetTypes ?? null;
  const fKey = filterCacheKey(opts.assetTypes, hideAssetTypes, opts.regionNames, fortigateNames);
  // `alerts` is the activeAlerts feed's gate — it reads Notification rows, so
  // events:read has no claim on it. No caller loses the feed by the switch:
  // migration 20260628000000 seeded `notifications: read` (renamed to `alerts`
  // by 20260721000000) onto EVERY role missing it, the seeded api-* kiosk token
  // roles included. A role an operator has since set to `alerts: none` is
  // deliberately denied here even when it still holds events:read.
  const allowed = (gate: "assets" | "events" | "alerts") =>
    gate === "assets" ? opts.canAssets
      : gate === "alerts" ? opts.canAlerts
        : opts.canEvents;

  // Resolve the per-widget filter to asset ids once (cached — the id set backs
  // every feed sharing the filter). Skipped when no feed will run.
  let assetIds: string[] | null = null;
  if (requested.some((f) => allowed(NOC_FEEDS[f].gate))) {
    assetIds = (await nocFeedCache.getOrCompute("ids|" + fKey, () =>
      resolveFilteredAssetIds({
        assetTypes: opts.assetTypes,
        hideAssetTypes,
        regionNames: opts.regionNames,
        fortigateNames,
      }),
    )) as string[] | null;
  }

  const L = (n: number): number | null => opts.capLimit ?? n;
  const samples = clampSampleCount(opts.sampleCount);
  const depDown = opts.includeDependencyDown === true;
  const out: Record<string, unknown> = {};
  await Promise.all(requested.map(async (feed) => {
    const def = NOC_FEEDS[feed];
    // Only sample-averaged feeds key on `samples`, so a ?samples= request
    // doesn't fragment the cache for feeds the param can't affect.
    const key = feed + "|" + (opts.capLimit ?? "") + "|" + (def.usesSamples ? samples : "")
      + "|" + (def.usesDepDown && depDown ? "dep" : "") + "|" + fKey;
    const value = allowed(def.gate)
      ? await nocFeedCache.getOrCompute(key, () => def.run(L, assetIds, samples, depDown))
      : def.empty;
    Object.assign(out, def.flatten ? def.flatten(value) : { [feed]: value });
  }));
  return out;
}
