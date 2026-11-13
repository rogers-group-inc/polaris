/**
 * src/services/notifications/readings.ts — the reading resolvers (CQ-B063, moved verbatim from notificationEngine.ts): for each trigger metric, the value(s) an
 * asset or component currently reads — host metrics, interfaces, storage, sensors, SD-WAN,
 * IPsec, path checks — from samples and current-state tables.
 */

import { prisma } from "../../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { loadPrimaryFirmwareImages, firmwareVsPrimary } from "../firmwareRepositoryService.js";
import { pathCheckIdsInMaintenance } from "../maintenanceScheduleService.js";
import { type Trigger, type ResetConfig, hwSensorFilterMatches, probeLossWindowSec, readingAtOrAboveCeiling, forecastDaysOf, forecastLevelsOf, type ForecastLevel, DEVICE_FILTER_DIMENSIONS, deviceFilterMatch, type DeviceFilterAsset, downRecoveryConsumesSustain, DOWN_ALERT_HOLDING_STATES, triggerHoldPolls, triggerWindowPolls, rollingAggregate, prepareResponseTimeWindow, parseMemberIpFilter, memberIpPasses, interfacePatternMatch, interfaceTagMatch, priorityTagSubjectOf } from "../notificationTypes.js";
import { bareInterfaceIp } from "../../utils/cidr.js";
import { isPathMetric } from "../notificationTypes.js";
import { FC_RATE_METRICS, fcErrorsFrom, isFcRateMetric } from "../../utils/fibreChannel.js";
import { sdwanDimensionTerms } from "../../utils/sdwanDimensions.js";
import { PRIORITY_TAGS, prioritySeverityOf, type PrioritySeverity } from "../../utils/priorityTags.js";
import { computeStorageForecast } from "../storageForecastService.js";
import { computeMemoryForecastDetail, computeMemoryProjection, forecastLevelReading } from "../memoryForecastService.js";
import { queryProbeLossRatios } from "../probeLossQuery.js";
import { logger } from "../../utils/logger.js";
import { alarmStatusToFlag } from "../../utils/hardwareSensors.js";
import { median } from "../../utils/stats.js";
import { coreVector, coreConditionIsBelow, coreSeries, coresToName, formatCoreList } from "../../utils/cpuCores.js";
import { sdwanDimensionMatch, sdwanChildrenYielding } from "../../utils/sdwanDimensions.js";
import { SERIES_CAP, lookbackMsFor, aggregateSinceMs, aggregateFallbackSinceMs, type DbRule, type ScopeAssetRow, type Reading, compareNum, compareValue } from "./ruleModel.js";
import { assetIsAnsweringProbes, interfaceIsPinned, poeFaultCoversUnpinned, interfaceDimLabel, tunnelIsPinned, storageIsPinned } from "./scope.js";

// ─── Reading resolvers ──────────────────────────────────────────────────────

function substringMatch(haystack: string | null, needle?: string): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/**
 * The device-identifier dimensions (hostname / IP / MAC / manufacturer /
 * model — DEVICE_FILTER_DIMENSIONS): narrow the ASSET SET before any sample
 * query runs. Every asset_metric and asset_state trigger takes them — they
 * name the device rather than a sub-asset, and they exist so a composite tree
 * can mix device-specific branches in one automation. The predicate itself is
 * notificationTypes.deviceFilterMatch, shared with getMetricSeverityTiers so
 * chart shading can't disagree with what evaluates. No patterns set = no
 * filtering (skipped without allocating). Exported for unit tests.
 */
export function applyDeviceFilters<T extends DeviceFilterAsset>(
  assets: T[],
  df: Parameters<typeof deviceFilterMatch>[0],
): T[] {
  if (!df) return assets;
  const rec = df as Record<string, string | undefined>;
  if (!DEVICE_FILTER_DIMENSIONS.some((d) => rec[d])) return assets;
  return assets.filter((a) => deviceFilterMatch(df, a));
}

/**
 * Reduce sample rows to the latest per dimension key, or aggregate over window.
 *
 * `windowPolls` (business rule 66) switches the window from time to a COUNT of
 * readings: every row fetched is still a member of the series, but the value —
 * and the series the hold is counted off — become the ROLLING aggregate over the
 * last N valued readings, recomputed at each one.
 */
/**
 * The aggregation a reducer applies, and the oldest sample a TIME-windowed
 * aggregate may include. The fetch can reach further back than the window (a
 * poll-counted hold or clear needs its N readings in the series), so the
 * window is stated here rather than inferred from what was fetched.
 */
interface AggregationWindow {
  kind: string;
  sinceMs: number;
  /** Rule 178: the newest reading at or after this stands in for an empty window. -Infinity = no stand-in. */
  fallbackSinceMs?: number;
}

function reduceReadings(
  rows: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (row: any) => string,
  dimLabelFn: (row: any) => string,
  valueFn: (row: any) => number | null,
  agg: AggregationWindow,
  windowPolls = 0,
  /** COUNT-WINDOW ONLY. Given this group's series newest-first (each entry
   *  carrying its source row), return the values the window should be built
   *  from — the seam response time uses to fill misses with their timeout and
   *  to truncate at an outage (business rule 67). Every other metric passes
   *  none and its raw values are used as they are. */
  prepare?: (series: Array<{ ts: number; v: number | null; row: any }>) => Array<number | null>,
): Reading[] {
  const aggregation = agg.kind;
  // group by assetId|dimKey
  const groups = new Map<string, { asset: ScopeAssetRow; dimKey: string; dimLabel: string; values: number[]; series: Array<{ ts: number; v: number | null; row: any }>; latest: { ts: number; v: number | null }; latestValued: { ts: number; v: number | null } }>();
  for (const row of rows) {
    const asset = assetIndex.get(row.assetId);
    if (!asset) continue;
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const v = valueFn(row);
    let g = groups.get(key);
    if (!g) {
      g = { asset, dimKey, dimLabel: dimLabelFn(row), values: [], series: [], latest: { ts: -1, v: null }, latestValued: { ts: -1, v: null } };
      groups.set(key, g);
    }
    const ts = row.timestamp.getTime();
    // Inside the trigger's own window only: older rows are fetched for the run
    // counts (the series below), never for the aggregate.
    if (v !== null && (agg.sinceMs === -Infinity || ts >= agg.sinceMs)) g.values.push(v);
    // Every sample, not just the newest: a poll-counted hold is the leading run
    // of qualifying readings, so their ORDER is the reading and a reduced value
    // cannot answer it. Sorted on the way out — rows arrive in whatever order
    // the query returned them.
    g.series.push({ ts, v, row });
    if (ts > g.latest.ts) g.latest = { ts, v };
    if (v !== null && ts > g.latestValued.ts) g.latestValued = { ts, v };
  }
  const out: Reading[] = [];
  for (const g of groups.values()) {
    g.series.sort((a, b) => b.ts - a.ts);
    if (windowPolls > 0) {
      // COUNT WINDOW. The series handed on is the sequence of ROLLING
      // aggregates, newest-first, so a `forPolls` hold counts recalculations
      // of the window rather than raw samples over the line — the composition
      // the time-window branch below deliberately refuses. Empty when the
      // device has not yet produced N valued readings, which reads downstream
      // exactly like a device that has produced none: no reading, no fire.
      const prepared = prepare ? prepare(g.series) : g.series.map((x) => x.v);
      const rolled = rollingAggregate(prepared, windowPolls, aggregation);
      if (!rolled.length) continue;
      out.push({
        assetId: g.asset.id, hostname: g.asset.hostname, tags: g.asset.tags,
        dimKey: g.dimKey, dimLabel: g.dimLabel, value: rolled[0]!,
        series: rolled.slice(0, SERIES_CAP),
        readingAt: g.latest.ts >= 0 ? new Date(g.latest.ts) : null,
      });
      continue;
    }
    // Rule 178: a stated window shorter than the polling interval can hold no
    // reading; the newest one (if recent enough) stands in for it.
    if (aggregation !== "latest" && g.values.length === 0 && g.latestValued.v !== null
      && agg.fallbackSinceMs !== undefined && agg.fallbackSinceMs !== -Infinity && g.latestValued.ts >= agg.fallbackSinceMs) {
      g.values.push(g.latestValued.v);
    }
    let value: number | null;
    if (aggregation === "avg") value = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : null;
    else if (aggregation === "median") value = median(g.values);
    else if (aggregation === "min") value = g.values.length ? Math.min(...g.values) : null;
    else if (aggregation === "max") value = g.values.length ? Math.max(...g.values) : null;
    else value = g.latest.v; // latest
    out.push({
      assetId: g.asset.id, hostname: g.asset.hostname, tags: g.asset.tags, dimKey: g.dimKey, dimLabel: g.dimLabel, value,
      // RAW readings, never the aggregate: a TIME-windowed trigger has no hold
      // to count (its window IS the period), and a `latest` one needs exactly
      // these values in exactly this order.
      series: g.series.slice(0, SERIES_CAP).map((x) => x.v),
      readingAt: g.latest.ts >= 0 ? new Date(g.latest.ts) : null,
    });
  }
  return out;
}

/**
 * `saturated` (optional, out-param): asset ids whose reading was DROPPED for
 * sitting at or above the trigger's `ignoreAtOrAbove` ceiling. The threshold
 * path passes one so it can CLEAR those assets' live alerts rather than let
 * them freeze — a dropped reading is indistinguishable from "stopped
 * reporting" to clearVanishedStates, and freezing an alert through an outage
 * is exactly what business rule 29 exists to prevent. Composite leaves and the
 * preview pass nothing: they only need the reading gone.
 */
/**
 * SD-WAN member IP address (business rule 98): keep only the member readings
 * whose member interface's CURRENT address passes `dimensionFilter.sdwanMemberIp`
 * ("!= 0.0.0.0" keeps a WAN with no address out of the condition). The member
 * is the `link` half of the `healthCheck|link` key, joined to its interface by
 * name — the SD-WAN tab's join.
 *
 * A dropped member produces NO reading, the same contract as an unpinned
 * interface: a live alert on it is retired by clearVanishedStates, and one is
 * never raised. A member whose address is unknown (no interface row, or a
 * gate whose scrape collected no address on ANY interface) is KEPT, and so is
 * every member when the read fails — the filter removes members it has
 * evidence about, never ones it could not check.
 *
 * Rule 98(a): since rule 126 every interface write stores an unaddressed
 * interface ("0.0.0.0", link-local) as a null address, so a null on a member
 * row is "unaddressed" whenever the same gate's scrape carried an address on
 * some interface — that is the evidence the collector reads addresses at all.
 * A member holding only an IPv6 address is addressed. Two reads on
 * AssetInterface narrowed to the gates in play (the member rows, and which
 * gates have any address), none at all when the filter is unset.
 */
/**
 * Business rule 133(g): the port test for `dimensionFilter.ifTag` — does this
 * (asset, interface) carry one of the named tags? Returns a pass-all predicate
 * with no query when the filter is unset. Otherwise ONE indexed read of
 * AssetInterfaceTag, narrowed in SQL to the scoped assets and the named tags
 * (manual and auto rows alike), so at 2000 assets it returns only the tagged
 * ports, never the whole tag table. A port that fails produces no reading —
 * the unpinned-interface contract: clearVanishedStates retires a live alert
 * once its port loses the tag. A failed read throws, like the sample query
 * beside it; failing open would raise a "critical" rule on every port.
 */
async function loadInterfaceTagFilter(
  df: { ifTag?: string } | undefined,
  ids: string[],
): Promise<(assetId: string, ifName: string) => boolean> {
  const terms = sdwanDimensionTerms(df?.ifTag);
  if (terms.length === 0) return () => true;
  if (ids.length === 0) return () => false;
  const rows = await prisma.assetInterfaceTag.findMany({
    where: { assetId: { in: ids }, OR: terms.map((t) => ({ tag: { equals: t, mode: "insensitive" as const } })) },
    select: { assetId: true, ifName: true, tag: true },
  });
  const byPort = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.assetId}|${r.ifName}`;
    const list = byPort.get(key) ?? [];
    list.push(r.tag);
    byPort.set(key, list);
  }
  return (assetId, ifName) => interfaceTagMatch(byPort.get(`${assetId}|${ifName}`), df?.ifTag);
}

/**
 * Business rule 136(e): whose Priority tag this rule's severity follows —
 * "device" (monitor status is down), "interface" (interface oper status is
 * down) — or null when the rule takes its severity the ordinary way.
 */
export function rulePrioritySubject(rule: Pick<DbRule, "severityFromPriorityTag" | "trigger">): "device" | "interface" | null {
  return rule.severityFromPriorityTag ? priorityTagSubjectOf(rule.trigger) : null;
}

/** Port → its Priority tags, for the ports of `ids`. ONE read narrowed in SQL
 *  to the five Priority names (case-insensitive), so at 2000 assets it returns
 *  the prioritised ports, not the tag table. */
async function loadPortPriorityTags(ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.assetInterfaceTag.findMany({
    where: { assetId: { in: ids }, OR: PRIORITY_TAGS.map((p) => ({ tag: { equals: p.name, mode: "insensitive" as const } })) },
    select: { assetId: true, ifName: true, tag: true },
  });
  for (const r of rows) {
    const key = `${r.assetId}|${r.ifName}`;
    const list = out.get(key) ?? [];
    list.push(r.tag);
    out.set(key, list);
  }
  return out;
}

/**
 * Business rule 136(e): the Priority severity of each reading, keyed
 * `assetId|dimKey`, with every reading whose device (or port) carries no
 * Priority tag DROPPED — an untagged subject is not this automation's to
 * alert on, and a live alert on one retires through clearVanishedStates
 * (its `tagGateGone` carve-out). The device's tags ride the scope row (no
 * query); a port's take one read (loadPortPriorityTags). A no-op returning
 * null for an ordinary rule.
 */
export async function applyPrioritySeverity(
  rule: DbRule,
  readings: Reading[],
  assetIndex: Map<string, ScopeAssetRow>,
): Promise<{ readings: Reading[]; severityByKey: Map<string, PrioritySeverity> } | null> {
  const subject = rulePrioritySubject(rule);
  if (!subject) return null;
  const portTags = subject === "interface"
    ? await loadPortPriorityTags(Array.from(new Set(readings.map((r) => r.assetId).filter(Boolean))))
    : null;
  const severityByKey = new Map<string, PrioritySeverity>();
  const kept: Reading[] = [];
  for (const r of readings) {
    const sev = portTags
      ? prioritySeverityOf(portTags.get(`${r.assetId}|${r.dimKey}`))
      : prioritySeverityOf(assetIndex.get(r.assetId)?.tags);
    if (!sev) continue;
    severityByKey.set(`${r.assetId || ""}|${r.dimKey}`, sev);
    kept.push(r);
  }
  return { readings: kept, severityByKey };
}

/**
 * The tag half of clearVanishedStates' no-readings carve-out (business rules
 * 133(g) and 136(e)). A device that produced NO readings for a rule is frozen
 * there, because a collection gap is not recovery. But a reading dropped
 * because its port lost the filtered tag, or its device / port lost every
 * Priority tag, is a configuration edge, like an unpin: without this, the
 * alert on a switch's ONLY Critical port would fire forever once the tag came
 * off. Returns the state-row ids whose subject no longer passes the rule's
 * tag gates. Runs only over the frozen candidates, so the steady-state tick
 * pays nothing; at most one port-tag read.
 */
export async function tagGateGone(
  rule: DbRule,
  rows: SweepStateRow[],
  assetIndex: Map<string, ScopeAssetRow>,
): Promise<Set<string>> {
  const gone = new Set<string>();
  if (rows.length === 0) return gone;
  const ifTag = (rule.trigger as { dimensionFilter?: { ifTag?: string } }).dimensionFilter?.ifTag;
  const subject = rulePrioritySubject(rule);
  const portRows = rows.filter((st) => st.dimensionKey && (ifTag || subject === "interface"));
  let portTags: Map<string, string[]> | null = null;
  if (portRows.length > 0) {
    portTags = new Map();
    const tagRows = await prisma.assetInterfaceTag.findMany({
      where: {
        OR: portRows.map((st) => ({ assetId: st.assetId as string, ifName: st.dimensionKey })),
      },
      select: { assetId: true, ifName: true, tag: true },
    });
    for (const r of tagRows) {
      const key = `${r.assetId}|${r.ifName}`;
      portTags.set(key, [...(portTags.get(key) ?? []), r.tag]);
    }
  }
  for (const st of rows) {
    const tagsOnPort = portTags?.get(`${st.assetId}|${st.dimensionKey}`);
    if (ifTag && st.dimensionKey && !interfaceTagMatch(tagsOnPort, ifTag)) gone.add(st.id);
    else if (subject === "interface" && st.dimensionKey && !prioritySeverityOf(tagsOnPort)) gone.add(st.id);
    else if (subject === "device" && !prioritySeverityOf(assetIndex.get(st.assetId as string)?.tags)) gone.add(st.id);
  }
  return gone;
}

async function filterByMemberIp(
  df: { sdwanMemberIp?: string } | undefined,
  readings: Reading[],
): Promise<Reading[]> {
  const filter = parseMemberIpFilter(df?.sdwanMemberIp);
  if (!filter || readings.length === 0) return readings;
  const assetIds = Array.from(new Set(readings.map((r) => r.assetId)));
  const names = Array.from(new Set(readings.map(sdwanMemberOf)));
  let rows: Array<{ assetId: string; ifName: string; ipAddress: string | null; ipv6Address: string | null }>;
  let addressed: Array<{ assetId: string }>;
  try {
    [rows, addressed] = await Promise.all([
      prisma.assetInterface.findMany({
        where: { assetId: { in: assetIds }, ifName: { in: names } },
        select: { assetId: true, ifName: true, ipAddress: true, ipv6Address: true },
      }),
      prisma.assetInterface.findMany({
        where: { assetId: { in: assetIds }, OR: [{ ipAddress: { not: null } }, { ipv6Address: { not: null } }] },
        select: { assetId: true },
        distinct: ["assetId"],
      }),
    ]);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "SD-WAN member IP lookup failed — keeping every member");
    return readings;
  }
  const readsAddresses = new Set(addressed.map((a) => a.assetId));
  const ipOf = new Map(rows.map((r) => [
    `${r.assetId}|${r.ifName}`,
    r.ipAddress ?? r.ipv6Address ?? (readsAddresses.has(r.assetId) ? "0.0.0.0" : null),
  ]));
  return readings.filter((r) => memberIpPasses(filter, ipOf.get(`${r.assetId}|${sdwanMemberOf(r)}`) ?? null) !== false);
}

/**
 * cpuCorePct readings (business rule 89): ONE reading per device, whose hold is
 * counted PER CORE — "over 90% for 3 polls" means the same core on three
 * consecutive polls, which is what a single-threaded application pinning one
 * core looks like (three different cores each spiking once is ordinary load).
 *
 * `utils/cpuCores.coreSeries` does the work: `series` is an envelope whose
 * leading run under any threshold equals the longest single-core run, so the
 * ordinary hold, band and tier counting below needs no per-core knowledge;
 * `clearSeries` is the most extreme core of each poll, so recovery waits until
 * EVERY core has stayed back under the line. The label names the cores whose
 * own run reached the hold (coresToName). Dimension key "": the label changes
 * as cores heat and cool, and state is keyed per device.
 */
function reduceCoreReadings(
  rows: Array<{ assetId: string; timestamp: Date; cpuCorePcts: unknown }>,
  assetIndex: Map<string, ScopeAssetRow>,
  trigger: Extract<Trigger, { type: "asset_metric" }>,
  windowPolls: number,
): Reading[] {
  const byAsset = new Map<string, Array<{ ts: number; vec: number[] }>>();
  for (const r of rows) {
    const vec = coreVector(r.cpuCorePcts);
    if (!vec || !assetIndex.has(r.assetId)) continue;
    let list = byAsset.get(r.assetId);
    if (!list) byAsset.set(r.assetId, (list = []));
    list.push({ ts: r.timestamp.getTime(), vec });
  }
  const below = coreConditionIsBelow(trigger.operator);
  const holdPolls = triggerHoldPolls(trigger);
  const out: Reading[] = [];
  for (const [assetId, list] of byAsset) {
    list.sort((a, b) => b.ts - a.ts);
    const cs = coreSeries(list.map((x) => x.vec), { aggregation: trigger.aggregation, windowPolls, below }, rollingAggregate);
    if (!cs) continue;
    const asset = assetIndex.get(assetId)!;
    out.push({
      assetId, hostname: asset.hostname, tags: asset.tags, dimKey: "",
      dimLabel: formatCoreList(coresToName(cs, (v) => readingMeets(trigger, v), holdPolls, below)),
      value: cs.value,
      series: cs.series.slice(0, SERIES_CAP),
      clearSeries: cs.clearSeries.slice(0, SERIES_CAP),
      readingAt: new Date(list[0]!.ts),
    });
  }
  return out;
}

/** The SD-WAN member a `healthCheck|link` reading is about. FortiOS object
 *  names admit no `|`, so the first separator splits it. */
const sdwanMemberOf = (r: Reading): string => r.dimKey.slice(r.dimKey.indexOf("|") + 1);

/** How far back an IPsec tunnel sample may be to name the port the tunnel
 *  rides. The phase-1 `interface` is configuration, not state — it only moves
 *  when someone re-homes the tunnel — so a day-old full scrape is still true. */
const SDWAN_PARENT_LOOKBACK_HOURS = 48;

/**
 * Business rule 90 — the port each SD-WAN member rides, for the members
 * named: `${assetId}|${member}` → parent name. Two sources, both already
 * collected:
 *  - an overlay member IS an IPsec phase-1 interface, and its sample row
 *    carries the phase-1 `interface` (`AssetIpsecTunnelSample.parentInterface`
 *    — "Overlay-3" rides "wan2");
 *  - a VLAN sub-interface names its physical port (`AssetInterface.ifParent`
 *    on an `ifType = "vlan"` row), so a tunnel homed on "wan1.100" still
 *    reaches wan1. Only VLAN rows: the aggregate back-fill writes ifParent on
 *    a trunk's MEMBER ports pointing at the trunk, which is the opposite
 *    direction (the trunk rides the ports, not the other way round).
 * Called only for the gates that have a reading over the line this tick, so a
 * healthy fleet costs no query at all.
 */
async function loadSdwanParents(assetIds: string[], names: string[]): Promise<Map<string, string>> {
  const [tunnels, vlans] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ assetId: string; tunnelName: string; parentInterface: string }>>(
      `SELECT DISTINCT ON ("assetId", "tunnelName") "assetId", "tunnelName", "parentInterface"
         FROM "asset_ipsec_tunnel_samples"
        WHERE "assetId" = ANY($1::text[]) AND "tunnelName" = ANY($2::text[])
          AND "parentInterface" IS NOT NULL
          AND "timestamp" > now() - make_interval(hours => $3::int)
        ORDER BY "assetId", "tunnelName", "timestamp" DESC`,
      assetIds, names, SDWAN_PARENT_LOOKBACK_HOURS,
    ),
    prisma.assetInterface.findMany({
      where: { assetId: { in: assetIds }, ifType: "vlan", ifParent: { not: null } },
      select: { assetId: true, ifName: true, ifParent: true },
    }),
  ]);
  const out = new Map<string, string>();
  for (const v of vlans) if (v.ifParent) out.set(`${v.assetId}|${v.ifName}`, v.ifParent);
  // A tunnel's own phase-1 wins over anything an interface row says about it.
  for (const t of tunnels) out.set(`${t.assetId}|${t.tunnelName}`, t.parentInterface);
  return out;
}

/** Members carrying a LIVE alert on this condition (`target` = the metric or
 *  field the alert stamped), from ANY automation: `${assetId}|${member}`. The
 *  alert's dimension is the `healthCheck|link` key, so the member is its tail.
 *  Acknowledged still counts — acknowledging an alert does not end it. */
async function liveSdwanAlertMembers(assetIds: string[], target: string): Promise<Set<string>> {
  const rows = await prisma.notification.findMany({
    where: { assetId: { in: assetIds }, metric: target, cleared: false, testRun: false, ruleId: { not: null } },
    select: { assetId: true, dimension: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.assetId || !r.dimension || r.dimension.indexOf("|") < 0) continue;
    out.add(`${r.assetId}|${r.dimension.slice(r.dimension.indexOf("|") + 1)}`);
  }
  return out;
}

/**
 * Business rule 90 — the parents that are DOWN outright, whatever the
 * automation's own filter or condition: `${assetId}|${name}` for every
 * ancestor named in `parentOf` whose port is operationally down
 * (`AssetInterface.operStatus`), or whose newest health-check read calls it
 * dead on ANY health check. A dead wan2 explains everything wrong with the
 * overlays riding it — the state, the loss, the latency — even when the
 * automation is narrowed to health checks wan2 is not a member of, or wan2 is
 * in no health check at all. Without this, an automation filtered to the
 * overlay health checks ("Metrocenter|Flexential") never sees the underlay and
 * pages once per overlay for one dead circuit.
 */
async function downSdwanParents(assetIds: string[], parentOf: Map<string, string>): Promise<Set<string>> {
  const names = Array.from(new Set(parentOf.values()));
  const out = new Set<string>();
  if (names.length === 0) return out;
  const since = new Date(Date.now() - SDWAN_PARENT_DOWN_LOOKBACK_MS);
  const [ports, sla] = await Promise.all([
    prisma.assetInterface.findMany({
      where: { assetId: { in: assetIds }, ifName: { in: names }, operStatus: "down" },
      select: { assetId: true, ifName: true },
    }),
    prisma.assetPerfSlaSample.findMany({
      where: { assetId: { in: assetIds }, link: { in: names }, timestamp: { gte: since } },
      orderBy: { timestamp: "desc" },
      select: { assetId: true, healthCheck: true, link: true, state: true },
    }),
  ]);
  for (const p of ports) out.add(`${p.assetId}|${p.ifName}`);
  // Newest read per (gate, health check, member) — dead on any one is down.
  const newest = new Set<string>();
  for (const r of sla) {
    const k = `${r.assetId}|${r.healthCheck}|${r.link}`;
    if (newest.has(k)) continue;
    newest.add(k);
    if (r.state === "down") out.add(`${r.assetId}|${r.link}`);
  }
  return out;
}

/** How far back a parent's health-check read may be to call it dead — a few
 *  SD-WAN scrapes; a member no longer reported says nothing either way. */
const SDWAN_PARENT_DOWN_LOOKBACK_MS = 15 * 60_000;

/**
 * Business rule 90 — a member riding a parent that is itself over the line
 * takes no reading: the parent's alert is the one that names the cause. A
 * lossy wan2 makes Overlay-3 and Overlay-4 lossy too; without this an operator
 * reads three alerts about one circuit.
 *
 * "Over the line" is the SAME condition (utils/sdwanDimensions →
 * sdwanChildrenYielding): a meeting reading on the parent in this automation
 * this tick, or an uncleared alert any automation raised on this metric/field
 * about the parent — or the parent is DOWN outright (downSdwanParents: an
 * oper-down port, or dead on any health check, whatever this automation's
 * filter). Only a reading that MEETS yields — a child that has come
 * back under the line keeps its reading and recovers normally.
 *
 * Applied ONLY when the caller passes `yielded` — the threshold path, which
 * collects `${assetId}|${dimKey}` → parent there and retires the child's live
 * alert as superseded rather than letting it read as "no longer reported".
 * Every other caller keeps every reading, and must: a reset leaf is the
 * trigger INVERTED, so "meets" there means recovered, and yielding a
 * recovered child to its recovered parent would strand the child's alert with
 * no reading to reset on; a composite leaf folds per device, where the parent
 * reading already carries the device. A failed lookup keeps every reading —
 * the rule removes readings it has evidence about, never ones it could not
 * check.
 */
async function yieldToSdwanParents(
  trigger: Trigger,
  target: string,
  readings: Reading[],
  yielded?: Map<string, string>,
): Promise<Reading[]> {
  if (!yielded) return readings;
  const meets = (r: Reading) => readingMeets(trigger, r.value);
  const hot = readings.filter(meets);
  if (hot.length === 0) return readings;
  const assetIds = Array.from(new Set(hot.map((r) => r.assetId)));
  const names = Array.from(new Set(hot.map(sdwanMemberOf)));
  let parentOf: Map<string, string>;
  let live: Set<string>;
  try {
    [parentOf, live] = await Promise.all([loadSdwanParents(assetIds, names), liveSdwanAlertMembers(assetIds, target)]);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "SD-WAN parent lookup failed — keeping every member reading");
    return readings;
  }
  if (parentOf.size === 0) return readings;
  try {
    for (const k of await downSdwanParents(assetIds, parentOf)) live.add(k);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "SD-WAN parent down lookup failed — yielding on same-condition evidence only");
  }
  const out = sdwanChildrenYielding(
    readings.map((r) => ({ assetId: r.assetId, member: sdwanMemberOf(r), dimKey: r.dimKey, meets: meets(r) })),
    parentOf,
    live,
  );
  if (out.size === 0) return readings;
  for (const [k, v] of out) yielded.set(k, v);
  return readings.filter((r) => !out.has(`${r.assetId}|${r.dimKey}`));
}

export async function resolveAssetMetricReadings(
  trigger: Extract<Trigger, { type: "asset_metric" }>,
  assets: ScopeAssetRow[],
  saturated?: Set<string>,
  /** Business rule 90 out-param — see yieldToSdwanParents. */
  sdwanYielded?: Map<string, string>,
  /** memForecastPct only: the rule's levels (base + bands, `forecastLevelsOf`).
   *  Absent — a forecast leaf inside a multi-condition tree — means the
   *  trigger's own threshold is the one level. */
  forecastLevels?: ForecastLevel[],
): Promise<Reading[]> {
  const df = trigger.dimensionFilter ?? {};
  // The device-identifier dimensions narrow the ASSET set before any sample
  // query — every metric takes them (they name the device rather than a
  // sub-asset), which is what lets a composite tree mix device-specific branches.
  assets = applyDeviceFilters(assets, df);
  const ids = assets.map((a) => a.id);
  if (ids.length === 0) return [];
  const index = new Map(assets.map((a) => [a.id, a]));
  // Wide enough to SEE a poll-counted hold's N readings (lookbackMsFor).
  // …and a poll-counted CLEAR's (withRecoveryLookback). A time-windowed
  // aggregate is still taken over the fire side's window alone, so widening the
  // fetch for the reset's sake never changes the value the trigger compares.
  const nowMs = Date.now();
  const since = new Date(nowMs - lookbackMsFor(trigger));
  const agg: AggregationWindow = { kind: trigger.aggregation, sinceMs: aggregateSinceMs(trigger, nowMs), fallbackSinceMs: aggregateFallbackSinceMs(trigger, nowMs) };
  // 0 unless this trigger states a COUNT window (business rule 66). Passed to
  // every reducer below rather than to the response-time one alone: an
  // operator smoothing interface errors or a temperature sensor is asking the
  // same question about the same kind of holed series.
  const winPolls = triggerWindowPolls(trigger);
  const num = (b: bigint | null | undefined): number | null => (b === null || b === undefined ? null : Number(b));

  switch (trigger.metric) {
    case "cpuPct": case "memPct": case "memUsedBytes": case "sessionCount": {
      const rows = await prisma.assetTelemetrySample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, sessionCount: true } });
      const pick = (r: any) => trigger.metric === "memUsedBytes" ? num(r.memUsedBytes) : (r[trigger.metric] ?? null);
      return reduceReadings(rows, index, () => "", () => "", pick, agg, winPolls);
    }
    case "memDaysUntilFull": {
      // Forecast metric: the shared 30-day trend (memoryForecastService), the
      // memory twin of storageDaysUntilFull below. aggregation/windowSec don't
      // apply — the daily averages already smooth; an asset whose memory isn't
      // growing (or has <7 daily points) produces NO reading, so "days <= N"
      // rules stay silent for healthy hosts. One reading per device.
      // A host REBOOTED inside the lookback restarts its fit (the reboot
      // emptied memory) and, until it has a forecast again, reads null, so
      // a live alert on it ends instead of freezing at the pre-reboot count.
      const fc = await computeMemoryForecastDetail(ids);
      const readings: Reading[] = fc.rows.map((r) => {
        const a = index.get(r.assetId)!;
        return { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value: r.daysUntilFull };
      });
      for (const id of fc.restartedWithoutForecast) {
        const a = index.get(id);
        if (a) readings.push({ assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value: null });
      }
      return readings;
    }
    case "memForecastPct": {
      // Forecast metric over the trigger's horizon (FORECAST_HORIZON_METRICS):
      // the base threshold and every severity band are LEVELS, and the alert
      // counts down to the next one the host has not reached — "Days until
      // Serious", then past serious "Days until Critical" — within
      // `forecastDays`. `forecastLevelReading` places the value so the ordinary
      // tier ladder lands on that level. Null (recovered — a live alert ends)
      // when memory is not growing, every level is passed, or the next is out
      // of reach; a host with <7 daily points reads nothing. One per device.
      const horizon = forecastDaysOf(trigger);
      const levels = forecastLevels ?? forecastLevelsOf(trigger, "warning", null);
      const proj = await computeMemoryProjection(ids, horizon);
      return proj.map((r) => {
        const a = index.get(r.assetId)!;
        return {
          assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "",
          value: forecastLevelReading(r.usedPct, r.slopePctPerDay, horizon, levels),
          forecast: { usedPct: r.usedPct, slopePerDay: r.slopePctPerDay },
        };
      });
    }
    case "cpuCorePct": {
      // One reading per DEVICE (dimension ""), valued at each sample's hottest
      // core, then labelled with the cores that are over the line — so a
      // 64-core host with three hot cores raises one alert naming three cores,
      // not three alerts. Only rows that carry a vector are read: every other
      // telemetry source leaves the column null, and a device with no per-core
      // data has no reading rather than a zero.
      const rows = await prisma.assetTelemetrySample.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since }, cpuCorePcts: { not: Prisma.DbNull } },
        select: { assetId: true, timestamp: true, cpuCorePcts: true },
      });
      return reduceCoreReadings(rows, index, trigger, winPolls);
    }
    case "responseTimeMs": case "uptimeSec": {
      // Response-time poll only (probeKind): the ICMP loss sampler writes a
      // NULL responseTimeMs and never reads uptime, so its rows would only add
      // scan cost — and an automation on response time must never see another
      // transport's timing.
      //
      // A COUNT-windowed response-time trigger needs two more columns — what a
      // miss cost and whether it was the outage — so it can fill and truncate
      // (business rule 67). Selected only for that case: at 2000 assets these
      // are two extra columns on the heaviest query an automation runs, and
      // every other trigger here has no use for them.
      const wantsProbeContext = trigger.metric === "responseTimeMs" && winPolls > 0;
      const rows = await prisma.assetMonitorSample.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
        select: {
          assetId: true, timestamp: true, responseTimeMs: true, uptimeSec: true,
          ...(wantsProbeContext ? { timeoutMs: true, assetDown: true } : {}),
        },
      });
      if (!wantsProbeContext) {
        return reduceReadings(rows, index, () => "", () => "", (r) => r[trigger.metric] ?? null, agg, winPolls);
      }
      // The raw value carried through reduceReadings is the RTT; `prepare`
      // re-reads the row for the fill and the reset, which is why it is handed
      // the rows rather than the values.
      return reduceReadings(
        rows, index, () => "", () => "",
        (r) => r.responseTimeMs ?? null, agg, winPolls,
        (series) => prepareResponseTimeWindow(series.map((x) => ({
          responseTimeMs: x.row.responseTimeMs ?? null,
          timeoutMs: (x.row as { timeoutMs?: number | null }).timeoutMs ?? null,
          assetDown: (x.row as { assetDown?: boolean | null }).assetDown === true,
        }))),
      );
    }
    case "probeLossPct": {
      // Probe-failure ratio over the window — the same shared query the
      // dashboard Packet Loss widget uses (probeLossQuery.queryProbeLossRatios;
      // the widget runs it in onlyLossy mode), so it works for ANY monitored
      // asset (switch/AP/server), not just SD-WAN. A windowed ratio:
      // `aggregation` doesn't apply (the window IS the measurement interval).
      // One grouped aggregate (1 row per asset), not a fetch-all — stays cheap
      // at 2000 assets on the 60s engine tick. The window is windowSec,
      // floored at DEFAULT_LOOKBACK (15m) — the widget's window.
      // ONLY devices that are currently answering (up / warning) produce a loss
      // reading — a down or recovering device's failures are its outage, and
      // asset-down alerts on that (business rule 29, assetIsAnsweringProbes).
      // Filtered here rather than at the caller so the composite-trigger path
      // gets the same gate from the same place; evaluateThresholdRule
      // separately clears any live loss alert on the assets this drops.
      const answering = assets.filter(assetIsAnsweringProbes).map((a) => a.id);
      if (answering.length === 0) return [];
      // `windowSec` IS the measurement period here (the wizard calls it History),
      // so the 15-minute DEFAULT_LOOKBACK floor every other metric needs — to be
      // sure a `latest` reading finds a recent sample — must NOT apply: it would
      // silently measure a 5-minute History over 15. Use the configured window
      // exactly, floored only at PROBE_LOSS_MIN_WINDOW_SEC so a ratio always has
      // a few probes behind it, and defaulted when the trigger carries none
      // (pre-History rules, where the minutes went to forDurationSec instead,
      // and hand-written ones).
      const lossWindowSec = probeLossWindowSec(trigger.windowSec);
      const sinceMinutes = lossWindowSec / 60;
      const rows = await queryProbeLossRatios({ sinceMinutes, assetIds: answering });
      // Emit the true ratio for every asset the query returns a row for,
      // INCLUDING 0% (no failures) so an auto-clear/hysteresis rule recovers.
      // The ratio covers the WHOLE window with one exclusion: probes taken
      // while the device was already `down` are the outage rather than the
      // link, so they are stamped `assetDown` at write time and stepped over
      // (business rule 29h, and see probeLossQuery's header). That is what
      // stops a device reading the outage back as loss for a whole window's
      // worth of ticks AFTER it recovered — the case the answering gate above
      // cannot see, because by then the device is answering again.
      return rows.map((r): Reading | null => {
        const a = index.get(r.assetId);
        if (!a) return null;
        const total = Number(r.total); const failed = Number(r.failed);
        const value = total > 0 ? Math.round((failed / total) * 1000) / 10 : null;
        // A windowed RATIO is recomputed from scratch every tick — there is no
        // series of ratios to count, so a poll-counted hold on one counts
        // observations against the probe's own anchor instead.
        // SATURATION CEILING (business rule 29). At or above it the number has
        // stopped describing a lossy link and started describing an outage —
        // which the down automation already owns — so it is not a reading at
        // all. Recorded rather than silently dropped so the caller can clear.
        if (readingAtOrAboveCeiling(trigger, value)) {
          saturated?.add(a.id);
          return null;
        }
        return { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: "", dimLabel: "", value, readingAt: a.lastMonitorAt ?? null };
      }).filter((r): r is Reading => r !== null);
    }
    case "hwSensorValue": {
      const rows = await prisma.assetHardwareSensorSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}) }, select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, value: true } });
      // sensorNamePattern narrows to ONE named sensor (or a family of them) —
      // ANDed with the class filter above (already applied in SQL), substring-
      // matched like the other *Pattern dimensions. Uses the shared predicate so
      // the asset chart's tier lookup can't drift from what actually fires.
      const filtered = df.sensorNamePattern ? rows.filter((r) => hwSensorFilterMatches(df, r)) : rows;
      return reduceReadings(filtered, index, (r) => r.sensorName, (r) => `${r.sensorName} (${r.sensorClass})`, (r) => r.value ?? null, agg, winPolls);
    }
    case "hwSensorAlarm": {
      // The device's OWN alarm bit, read off the column the hardware-sensor
      // collectors already populate — no extra walk, no operator configuration,
      // and it works on every transport that fills it (FortiOS REST sensor-info
      // and the SNMP fgHwSensorTable alike). Same per-sensor dimension and the
      // same dimensionFilter predicate as hwSensorValue, so a rule can target one
      // named sensor or a whole class.
      const rows = await prisma.assetHardwareSensorSample.findMany({
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(df.sensorClass ? { sensorClass: df.sensorClass } : {}),
          // Sources that publish no alarm bit (ENTITY-SENSOR-MIB, the FortiAP
          // controller path) leave this NULL. Excluded in SQL so those sensors
          // produce no readings at all rather than being mapped to a value —
          // see alarmStatusToFlag's contract.
          alarmStatus: { not: null },
        },
        select: { assetId: true, timestamp: true, sensorName: true, sensorClass: true, alarmStatus: true },
      });
      const filtered = df.sensorNamePattern ? rows.filter((r) => hwSensorFilterMatches(df, r)) : rows;
      return reduceReadings(
        filtered,
        index,
        (r) => r.sensorName,
        (r) => `${r.sensorName} (${r.sensorClass})`,
        (r) => alarmStatusToFlag(r.alarmStatus),
        agg,
        winPolls,
      );
    }
    case "storageUsedBytes": case "storageUsedPct": {
      const rows = await prisma.assetStorageSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, mountPath: true, usedBytes: true, totalBytes: true } });
      // Pinned mounts only (storageIsPinned) — the sample table carries every
      // mountpath the device reports (unpinned rows ride cadence="slow", 24h,
      // rewritten every scrape so they never age out of the lookback), so the
      // gate has to live here, same as the interface and tunnel resolvers.
      const filtered = rows.filter((r) => storageIsPinned(index.get(r.assetId), r.mountPath) && substringMatch(r.mountPath, df.mountPathPattern));
      const valueFn = (r: any) => {
        if (trigger.metric === "storageUsedBytes") return num(r.usedBytes);
        const used = num(r.usedBytes); const total = num(r.totalBytes);
        return used !== null && total ? (used / total) * 100 : null;
      };
      return reduceReadings(filtered, index, (r) => r.mountPath, (r) => r.mountPath, valueFn, agg, winPolls);
    }
    case "storageDaysUntilFull": {
      // Forecast metric: the shared 30-day trend (storageForecastService).
      // aggregation/windowSec don't apply — the trend already smooths; a mount
      // that isn't growing (or has <7 daily points) produces NO reading, so
      // "days <= N" rules stay silent for healthy filesystems. Pin-gated like
      // the other two storage metrics (storageIsPinned) — the forecast service
      // is shared with the NOC dashboard, which asks a different question, so
      // the gate is applied HERE rather than inside it.
      const fc = await computeStorageForecast(ids);
      return fc
        .filter((r) => storageIsPinned(index.get(r.assetId), r.mountPath) && substringMatch(r.mountPath, df.mountPathPattern))
        .map((r) => {
          const a = index.get(r.assetId)!;
          return { assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey: r.mountPath, dimLabel: r.mountPath, value: r.daysUntilFull };
        });
    }
    case "sdwanLatencyMs": case "sdwanJitterMs": case "sdwanPacketLoss": {
      const col = trigger.metric === "sdwanLatencyMs" ? "latencyMs" : trigger.metric === "sdwanJitterMs" ? "jitterMs" : "packetLoss";
      const rows = await prisma.assetPerfSlaSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, select: { assetId: true, timestamp: true, healthCheck: true, link: true, latencyMs: true, jitterMs: true, packetLoss: true } });
      // Any-of over "|"-joined terms (utils/sdwanDimensions) — a single
      // pattern is one term and reads exactly as it always did.
      const filtered = rows.filter((r) => sdwanDimensionMatch(r.healthCheck, df.healthCheck) && sdwanDimensionMatch(r.link, df.link));
      // Business rule 98: narrowed by the member's current address.
      const kept = await filterByMemberIp(
        df,
        reduceReadings(filtered, index, (r) => `${r.healthCheck}|${r.link}`, (r) => `${r.healthCheck} / ${r.link}`, (r) => r[col] ?? null, agg, winPolls),
      );
      return yieldToSdwanParents(trigger, trigger.metric, kept, sdwanYielded);
    }
    case "customWidgetValue": {
      const rows = await prisma.assetCustomWidgetSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since }, kind: "scalar", ...(df.widgetId ? { widgetId: df.widgetId } : {}) }, select: { assetId: true, timestamp: true, widgetId: true, value: true } });
      // `|| null` here would map a legitimate reading of 0 to "no reading",
      // which silently breaks both directions of any rule about zero: a
      // "== 0" / "<= 0" condition could never fire, and an auto-reset rule
      // could never clear because the recovery value is the one being dropped.
      // Only genuinely non-numeric JSON becomes null.
      return reduceReadings(rows, index, (r) => r.widgetId, (r) => r.widgetId, (r) => {
        const n = typeof r.value === "number" ? r.value : Number(r.value);
        return Number.isFinite(n) ? n : null;
      }, agg, winPolls);
    }
    case "customStateValue": {
      // 0/1 state-probe readings (utils/stateProbes). One dimension per probe
      // ROW, so every sensor / PSU / fan tray carries its own firing state and
      // its own alert — keyed on rowKey (the stable OID index) while the LABEL
      // is what the operator filters and reads, so renaming a row keeps its
      // alert. probeId is an exact match (a registry key), the row pattern is
      // substring-matched like every other *Pattern dimension.
      const rows = await prisma.assetStateSample.findMany({
        where: {
          assetId: { in: ids },
          timestamp: { gte: since },
          ...(df.stateProbeId ? { probeId: df.stateProbeId } : {}),
        },
        select: { assetId: true, timestamp: true, probeId: true, rowKey: true, rowLabel: true, value: true },
      });
      const filtered = df.stateRowPattern ? rows.filter((r) => substringMatch(r.rowLabel, df.stateRowPattern)) : rows;
      return reduceReadings(
        filtered,
        index,
        (r) => `${r.probeId}|${r.rowKey}`,
        (r) => r.rowLabel,
        (r) => (r.value === 0 || r.value === 1 ? r.value : null),
        agg,
        winPolls,
      );
    }
    case "ifInBps": case "ifOutBps": case "ifInErrorRate": case "ifOutErrorRate": {
      const col = trigger.metric === "ifInBps" ? "inOctets" : trigger.metric === "ifOutBps" ? "outOctets" : trigger.metric === "ifInErrorRate" ? "inErrors" : "outErrors";
      const mult = trigger.metric === "ifInBps" || trigger.metric === "ifOutBps" ? 8 : 1; // octets→bits
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, ifName: true, alias: true, inOctets: true, outOctets: true, inErrors: true, outErrors: true } });
      // Pinned interfaces only (interfaceIsPinned) — the same default the
      // ifOperStatus/ifAdminStatus/ifIpAddress/poeStatus resolvers apply. See its header for
      // why the pinned-only sample table isn't a gate by itself.
      const tagged = await loadInterfaceTagFilter(df, ids);
      const filtered = rows.filter((r) => interfaceIsPinned(index.get(r.assetId), r.ifName) && interfacePatternMatch(r.ifName, r.alias, df.ifNamePattern) && tagged(r.assetId, r.ifName));
      return rateReadings(filtered, index, (r) => r.ifName, (r) => interfaceDimLabel(r.ifName, r.alias), (r) => num((r as any)[col]), mult);
    }
    case "fcCrcErrorRate": case "fcLinkFailureRate": case "fcSyncLossRate": case "fcSignalLossRate": case "fcInvalidTxWordRate": {
      // A pinned FC port's counter as a rate per minute (business rule
      // 159a). Only rows that carry an FC reading: a sample written by a
      // pass that read none would otherwise pair with a real one and read as
      // "no rate" every other tick.
      if (!isFcRateMetric(trigger.metric)) return [];
      const field = FC_RATE_METRICS[trigger.metric];
      const rows = await prisma.assetInterfaceSample.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since }, fcErrors: { not: Prisma.DbNull } },
        orderBy: { timestamp: "desc" },
        select: { assetId: true, timestamp: true, ifName: true, alias: true, fcErrors: true },
      });
      const tagged = await loadInterfaceTagFilter(df, ids);
      const filtered = rows.filter((r) => interfaceIsPinned(index.get(r.assetId), r.ifName) && interfacePatternMatch(r.ifName, r.alias, df.ifNamePattern) && tagged(r.assetId, r.ifName));
      return rateReadings(filtered, index, (r) => r.ifName, (r) => interfaceDimLabel(r.ifName, r.alias), (r) => fcErrorsFrom(r.fcErrors)?.[field] ?? null, 60);
    }
    case "ipsecThroughputBps": {
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, select: { assetId: true, timestamp: true, tunnelName: true, incomingBytes: true, outgoingBytes: true } });
      // Pinned tunnels only (tunnelIsPinned) — the sample table carries every
      // tunnel the gate reports (unpinned rows ride cadence="slow"), so the
      // gate has to live here, same as the interface resolvers.
      const filtered = rows.filter((r) => tunnelIsPinned(index.get(r.assetId), r.tunnelName) && substringMatch(r.tunnelName, df.tunnelName));
      return rateReadings(filtered, index, (r) => r.tunnelName, (r) => r.tunnelName, (r) => { const i = num(r.incomingBytes); const o = num(r.outgoingBytes); return i === null && o === null ? null : (i ?? 0) + (o ?? 0); }, 8);
    }
    // ── Agent-run path checks ──────────────────────────────────────
    // The asset is the AGENT HOST; the dimension is the check (key = id, label
    // = the check's name). A reading here is about a path from that host — it
    // never moves the host's monitorStatus, and the SLA the operator writes is
    // this trigger's threshold, not anything stored on the check.
    case "pathLatencyMs": case "pathHttpStatus": case "pathOk": case "pathTlsDaysLeft": {
      const rows = await prisma.assetPathCheckSample.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since }, ...(await pathCheckIdWhere(df.checkId)) },
        select: { assetId: true, timestamp: true, checkId: true, ok: true, latencyMs: true, httpStatus: true, tlsNotAfter: true },
      });
      const names = await pathCheckNames(rows.map((r) => r.checkId));
      const now = Date.now();
      const valueFn = (r: typeof rows[number]): number | null => {
        switch (trigger.metric) {
          // A failed run carries no latency (nothing connected, or it timed
          // out): no reading, not a zero — the failure is pathOk's to report.
          case "pathLatencyMs": return r.latencyMs ?? null;
          case "pathHttpStatus": return r.httpStatus ?? null;
          case "pathOk": return r.ok ? 1 : 0;
          // tcp / icmp checks and plain-http runs have no certificate: no reading.
          default: return r.tlsNotAfter ? Math.floor((r.tlsNotAfter.getTime() - now) / 86_400_000) : null;
        }
      };
      return reduceReadings(rows, index, (r) => r.checkId, (r) => names.get(r.checkId) ?? r.checkId, valueFn, agg, winPolls);
    }
    case "pathHopCount": {
      // Read off the traceroutes (every Nth run + each pass→fail and fail→pass), not the
      // per-run samples, which carry no hop count.
      const rows = await prisma.assetPathCheckTraceroute.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since }, ...(await pathCheckIdWhere(df.checkId)) },
        select: { assetId: true, timestamp: true, checkId: true, hopCount: true },
      });
      const names = await pathCheckNames(rows.map((r) => r.checkId));
      return reduceReadings(rows, index, (r) => r.checkId, (r) => names.get(r.checkId) ?? r.checkId, (r) => r.hopCount, agg, winPolls);
    }
    case "pathFailurePct": {
      // A windowed RATIO (failed runs / runs) like probeLossPct: the window is
      // the measurement, floored at 5 min and defaulted to 15 by the same
      // probeLossWindowSec. ONE grouped aggregate over (host, check, ok) — never
      // a fetch-all at 2000 hosts on the 60 s tick. Emits 0 % rows too so a
      // hysteresis reset recovers. NOT gated on the host answering probes (the
      // probeLossPct gate): these results are the agent's own report, and a
      // host that cannot report pushes nothing, so it is naturally silent.
      const windowSec = probeLossWindowSec(trigger.windowSec);
      const grouped = await prisma.assetPathCheckSample.groupBy({
        by: ["assetId", "checkId", "ok"],
        where: {
          assetId: { in: ids },
          timestamp: { gte: new Date(Date.now() - windowSec * 1000) },
          ...(await pathCheckIdWhere(df.checkId)),
        },
        _count: { _all: true },
        _max: { timestamp: true },
      });
      const cells = new Map<string, { assetId: string; checkId: string; total: number; failed: number; last: Date | null }>();
      for (const g of grouped) {
        const key = `${g.assetId}|${g.checkId}`;
        const c = cells.get(key) ?? { assetId: g.assetId, checkId: g.checkId, total: 0, failed: 0, last: null };
        c.total += g._count._all;
        if (!g.ok) c.failed += g._count._all;
        const m = g._max.timestamp;
        if (m && (!c.last || m > c.last)) c.last = m;
        cells.set(key, c);
      }
      const names = await pathCheckNames([...cells.values()].map((c) => c.checkId));
      const out: Reading[] = [];
      for (const c of cells.values()) {
        const a = index.get(c.assetId);
        if (!a || c.total === 0) continue;
        const value = Math.round((c.failed / c.total) * 1000) / 10;
        // No saturation ceiling here (business rule 85): 100% is every run
        // failing while the host reports — the case an operator wrote this rule
        // for — not an outage some other automation owns, as it is for loss.
        out.push({
          assetId: a.id, hostname: a.hostname, tags: a.tags,
          dimKey: c.checkId, dimLabel: names.get(c.checkId) ?? c.checkId,
          value, readingAt: c.last,
        });
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * The `checkId` clause every path-sample read applies: the automation's own
 * check filter, and NEVER a check in maintenance (business rule 135). Applied
 * at the read rather than to the readings so every caller — the single-trigger
 * loop, a composite, the frozen re-read, a reset tree — is blind to a paused
 * check alike: samples from before the window included, which would otherwise
 * keep a windowed metric (pathFailurePct) reading the outage the window was
 * declared for.
 */
async function pathCheckIdWhere(dfCheckId: string | undefined): Promise<{ checkId?: string | { in: string[] } | { notIn: string[] } }> {
  const held = await pathCheckIdsInMaintenance();
  if (dfCheckId) return held.has(dfCheckId) ? { checkId: { in: [] } } : { checkId: dfCheckId };
  return held.size > 0 ? { checkId: { notIn: [...held] } } : {};
}

/** id → name for the path checks a resolver's rows mention. One small
 *  query per resolver call (the table is capped at a few dozen rows). */
async function pathCheckNames(ids: readonly string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const rows = await prisma.pathCheck.findMany({ where: { id: { in: distinct } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Compute a per-dimension rate (delta / dt) from the two latest counter samples. */
function rateReadings(
  rowsDesc: Array<{ assetId: string; timestamp: Date }>,
  assetIndex: Map<string, ScopeAssetRow>,
  dimKeyFn: (r: any) => string,
  dimLabelFn: (r: any) => string,
  counterFn: (r: any) => number | null,
  mult: number,
): Reading[] {
  const groups = new Map<string, any[]>();
  for (const row of rowsDesc) {
    const dimKey = dimKeyFn(row);
    const key = `${row.assetId}|${dimKey}`;
    const arr = groups.get(key) ?? [];
    if (arr.length < 2) { arr.push(row); groups.set(key, arr); }
  }
  const out: Reading[] = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const [newer, older] = arr; // desc order
    const asset = assetIndex.get(newer.assetId);
    if (!asset) continue;
    const cN = counterFn(newer); const cO = counterFn(older);
    const dt = (newer.timestamp.getTime() - older.timestamp.getTime()) / 1000;
    let value: number | null = null;
    if (cN !== null && cO !== null && dt > 0 && cN >= cO) value = ((cN - cO) * mult) / dt;
    out.push({ assetId: asset.id, hostname: asset.hostname, tags: asset.tags, dimKey: dimKeyFn(newer), dimLabel: dimLabelFn(newer), value });
  }
  return out;
}

/**
 * Group timestamp-ordered rows (newest first WITHIN the query's order) into one
 * array per key, preserving that order — the run of readings a poll-counted
 * hold counts. Replaces the `distinct` the state resolvers used when the newest
 * row was the only one they needed.
 */
function groupSeries<T>(rows: T[], keyOf: (r: T) => string): T[][] {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = byKey.get(k);
    if (g) g.push(r);
    else byKey.set(k, [r]);
  }
  return [...byKey.values()];
}

/** The `AssetInterfaceSample` column each interface STATE field reads. */
const INTERFACE_STATE_COLUMN = {
  ifOperStatus:  "operStatus",
  ifAdminStatus: "adminStatus",
  ifIpAddress:   "ipAddress",
  poeStatus:     "poeStatus",
} as const;

export type InterfaceStateField = keyof typeof INTERFACE_STATE_COLUMN;

/** The columns of one interface sample row the state fields read. */
export interface InterfaceStateRow {
  operStatus:  string | null;
  adminStatus: string | null;
  poeStatus:   string | null;
  ipAddress:   string | null;
}

/**
 * Does this sample row actually CARRY the field, or was it merely written by a
 * tick that failed to collect it?
 *
 * One row is written per port per tick with every interface column on it, so a
 * column can be null because the device has nothing to report there OR because
 * that column's own collection failed while the rest of the row succeeded. PoE
 * is the one most able to fail alone: it is a separate pair of walks
 * (`collectPoePortsSnmp`) that can time out while the IF-MIB walk feeding the
 * same row answers fine, and its ifIndex correlation is inference that drops
 * any port it cannot resolve unambiguously (`utils/poePorts.ts`).
 *
 * Null therefore means "no reading", exactly as it does for `hwSensorAlarm`
 * (business rule 24) — it is never mapped to a value. What it must NOT do is
 * decide the question on the newest row alone; see `interfaceStateSeries`.
 */
export function interfaceSampleCarries(field: InterfaceStateField, r: InterfaceStateRow): boolean {
  if (field === "poeStatus") return r.poeStatus != null;
  // ifOperStatus is gated on adminStatus === "up" downstream, so a row missing
  // THAT is no more usable here than one missing operStatus itself.
  if (field === "ifOperStatus") return r.operStatus != null && r.adminStatus != null;
  // A null ipAddress is "this tick collected no address for the port", never
  // "the port is unaddressed" — the device says the latter with 0.0.0.0, and
  // most L2 ports simply have no L3 address to report, so mapping null to a
  // value would make every access port on a switch satisfy `!= 0.0.0.0`.
  if (field === "ifIpAddress") return r.ipAddress != null;
  return r.adminStatus != null;
}

/**
 * One port's rows (newest first) reduced to the reading the engine evaluates
 * plus the run a poll-counted hold counts — skipping rows that carry no
 * reading for this field.
 *
 * THE READING IS THE NEWEST ROW THAT CARRIES THE FIELD, NOT THE NEWEST ROW.
 * Taking `group[0]` blindly made a single failed collection indistinguishable
 * from a port that has no PSE at all: the dimension vanished, and because the
 * switch was still reporting its OTHER pinned ports, `clearVanishedStates` took
 * the "dimension is gone" branch and retired the live alert — which the next
 * readable tick then raised again as a NEW alert, with a new delivery and a new
 * email. A duplicate alert per collection gap, on a port whose state never
 * changed. That is what a 30-minute `poeAbsentCache` entry written by a timed-out
 * walk used to guarantee (see `collectPoePortsSnmp`, fixed alongside this).
 *
 * "Newest non-null wins" is also exactly what the hourly rollup already applies
 * to these same columns (`sampleRollupService`'s `ARRAY_AGG(...) FILTER (WHERE
 * ... IS NOT NULL)`), so this is the engine agreeing with the rollup rather
 * than a new rule of its own.
 *
 * Returns null when NO row in the whole lookback window carries the field —
 * the case the null gate was written for (a port with no PSE, or one that
 * genuinely stopped reporting). Those still produce no reading, and their
 * alerts still clear.
 */
export function interfaceStateSeries<T extends InterfaceStateRow>(
  field: InterfaceStateField,
  group: readonly T[],
  cap: number = SERIES_CAP,
): { row: T; series: (string | null)[] } | null {
  const row = group.find((r) => interfaceSampleCarries(field, r));
  if (!row) return null;
  const col = INTERFACE_STATE_COLUMN[field];
  return {
    row,
    // Readable rows only, for the same reason: an unreadable tick is a GAP in
    // the series, not a reading — counting it would break a poll-counted hold
    // (business rule 19) on exactly the ticks that measured nothing.
    series: group.filter((r) => interfaceSampleCarries(field, r)).slice(0, cap).map((r) => r[col]),
  };
}

/**
 * Backstop age for a current-state interface row. `asset_interfaces` is
 * delete-replaced per scrape, so a port that goes away is REMOVED rather than
 * left stale — the row can only go stale when the whole device stops being
 * scraped, and then its `lastSeen` freezes at whatever the last pass saw.
 * Freezing is mostly right (a switch we cannot reach has not told us the fault
 * cleared, and the no-readings freeze is what the engine does with every other
 * collection gap), but it must not be forever, or a device left monitored and
 * permanently unreachable holds a PoE alert for good.
 *
 * 48h because `systemInfoIntervalSec` is validated at most 86400 (24h): the
 * slowest cadence an operator can legally configure still lands two refreshes
 * inside the window, so this can only ever catch a device that genuinely
 * stopped being scraped.
 */
const POE_INVENTORY_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * PoE readings for the ports the pin gate leaves out, for a fault trigger only
 * (business rule 57's carve-out — see poeFaultCoversUnpinned).
 *
 * Source is `asset_interfaces`, the current-state table, because
 * `asset_interface_samples` HAS no unpinned rows: the 2026-06 cutover stopped
 * writing them (they were never compressed, never rolled up, and their
 * row-level DELETE was behind two compressed-chunk bloat incidents). So this is
 * not a gate that could be lifted by deleting a line — the data for these ports
 * lives in exactly one place, and this is it.
 *
 * UNIONED with the pinned sample readings rather than replacing them. A pinned
 * port keeps its sample-backed reading, which carries a real series and a
 * fast-cadence timestamp; switching it to current-state would silently coarsen
 * every `poeStatus == fault` rule that works today. So a pinned port is read
 * exactly as before and an unpinned one is new, which is what makes this change
 * additive.
 *
 * What an unpinned reading gives up, and why it is still enough: no series
 * (this table keeps one row per port, not a history), so a `forPolls` hold
 * counts observations through the firing row's own counter, anchored on
 * `lastSeen` — the same shape `fortilinkStatus` uses, and the reason `readingAt`
 * exists. The hold therefore counts FULL SCRAPES (default 600s), not the 60s
 * fast pass: "sustained for 3 polls" on an unpinned port is half an hour, not
 * three minutes. A fault does not flicker, so this costs latency rather than
 * correctness — but it is why the builder says so on the field.
 *
 * Scale (100 vs 2000 assets): one indexed `findMany` per tick over
 * `(assetId IN …)`, narrowed in SQL by `poeStatus IS NOT NULL`, which is the
 * filter that matters — it drops every routed interface, VLAN, aggregate and
 * tunnel, and every port on every device with no PSE at all, so a fleet of
 * firewalls and servers reads back nothing. What remains is roughly the switch
 * ports, one small row each, with no series to carry.
 */
async function unpinnedPoeFaultReadings(
  index: Map<string, ScopeAssetRow>,
  ids: string[],
  df: { ifNamePattern?: string; ifTag?: string },
  mk: (a: ScopeAssetRow, dimKey: string, dimLabel: string, value: any) => Reading,
): Promise<Reading[]> {
  if (ids.length === 0) return [];
  const freshSince = new Date(Date.now() - POE_INVENTORY_MAX_AGE_MS);
  const [rows, tagged] = await Promise.all([
    prisma.assetInterface.findMany({
      where: { assetId: { in: ids }, poeStatus: { not: null }, lastSeen: { gte: freshSince } },
      select: { assetId: true, ifName: true, alias: true, poeStatus: true, lastSeen: true },
    }),
    loadInterfaceTagFilter(df, ids),
  ]);
  const out: Reading[] = [];
  for (const r of rows) {
    const a = index.get(r.assetId);
    if (!a) continue;
    // The pinned ports came from the sample table above — taking them again
    // here would hand the state machine two readings for one dimension key.
    if (interfaceIsPinned(a, r.ifName)) continue;
    // Same operator-choice gate the pinned path applies. Inert for a fault
    // trigger (a disabled port reports "disabled", never "fault"), kept so the
    // two paths can't drift into disagreeing about what a port reports.
    if (r.poeStatus === "disabled") continue;
    if (!interfacePatternMatch(r.ifName, r.alias, df.ifNamePattern)) continue;
    if (!tagged(r.assetId, r.ifName)) continue;
    out.push({
      ...mk(a, r.ifName, interfaceDimLabel(r.ifName, r.alias), r.poeStatus),
      readingAt: r.lastSeen,
    });
  }
  return out;
}

/**
 * Business rule 118 — the reading of a stream-failing field: whole minutes from
 * the first failed attempt of the open run to the LATEST attempt. Measured to
 * the attempt, not to now, so a stream that stops being attempted (the device
 * went down and the heavy cadences paused, the method was switched off) freezes
 * where it was instead of climbing into an alert about polls nobody sent.
 * 0 when the stream is healthy; null — no reading — when it was never attempted.
 */
export function streamFailingMinutes(lastAttemptAt: Date | null, failingSince: Date | null): number | null {
  if (!lastAttemptAt) return null;
  if (!failingSince) return 0;
  return Math.max(0, Math.floor((lastAttemptAt.getTime() - failingSince.getTime()) / 60_000));
}

export async function resolveAssetStateReadings(
  trigger: Extract<Trigger, { type: "asset_state" }>,
  assets: ScopeAssetRow[],
  /** Read unpinned PoE ports even though THIS trigger doesn't qualify for rule
   *  57's carve-out on its own — set only for the reset leaves of an automation
   *  whose trigger does. The inverted leaf (`!= fault`) can never qualify by
   *  itself, and without this the tree is silent about the very port the alert
   *  is about. See resolveResetTruths. */
  opts?: {
    coverUnpinnedPoe?: boolean;
    /** Business rule 78: a dependency-suppressed asset reads `down` on the
     *  monitorStatus field, flagged as a dependency reading, instead of its own
     *  probe's verdict. Set only by a down automation that opted in — the gate
     *  loop keeps every other automation's suppressed assets out of `assets`. */
    dependencyDownReadsDown?: boolean;
    /** Business rule 90 out-param — see yieldToSdwanParents. */
    sdwanYielded?: Map<string, string>;
  },
): Promise<Reading[]> {
  const df = trigger.dimensionFilter ?? {};
  assets = applyDeviceFilters(assets, df); // same asset-set narrowing as the metric resolver
  const index = new Map(assets.map((a) => [a.id, a]));
  const ids = assets.map((a) => a.id);
  const mk = (a: ScopeAssetRow, dimKey: string, dimLabel: string, value: any): Reading => ({ assetId: a.id, hostname: a.hostname, tags: a.tags, dimKey, dimLabel, value });

  // These five are Asset COLUMNS: current state, no series to count, so a
  // poll-counted hold counts observations gated on the probe's own anchor.
  const probeAt = (a: ScopeAssetRow): Date | null => a.lastMonitorAt ?? null;
  switch (trigger.field) {
    case "monitorStatus": return assets.map((a) =>
      opts?.dependencyDownReadsDown && a.dependencySuppressed
        // The upstream's confirmed verdict IS the evidence (rule 78): the
        // device turned Dep. Down, and that is the edge the operator asked to
        // hear about — not its own probe reaching the count some polls later.
        ? { ...mk(a, "", "", "down"), readingAt: probeAt(a), dependencyDown: true, ownMonitorStatus: a.monitorStatus }
        : { ...mk(a, "", "", a.monitorStatus), readingAt: probeAt(a) });
    case "status": return assets.map((a) => ({ ...mk(a, "", "", a.status), readingAt: probeAt(a) }));
    case "consecutiveFailures": return assets.map((a) => ({ ...mk(a, "", "", a.consecutiveFailures), readingAt: probeAt(a) }));
    case "dependencySuppressed": return assets.map((a) => ({ ...mk(a, "", "", a.dependencySuppressed), readingAt: probeAt(a) }));
    case "quarantined": return assets.map((a) => ({ ...mk(a, "", "", a.quarantinedAt !== null || a.status === "quarantined"), readingAt: probeAt(a) }));
    case "fortilinkStatus": {
      // Business rule 59. Two departures from the four columns above, both
      // because this field has a writer of its own on a cadence of its own.
      //
      // (1) An asset with no value produces NO READING, rather than a reading
      //     of null. null means "the sweep has never spoken about this device"
      //     — it isn't FortiGate-managed, or it is a pre-feature row awaiting
      //     its first tick. A null reading would make `!= up` true for every
      //     workstation, VM and printer in a fleet-wide scope, which is the
      //     inverse of what an operator writing that rule means. No reading
      //     also lets the vanished-state sweep clear a live alert on a device
      //     that stops being managed, the same way an unpinned interface
      //     clears.
      //
      // (2) The anchor is `fortilinkCheckedAt`, not `lastMonitorAt`. A
      //     `forPolls` hold has to count times the CONTROLLER answered; the
      //     monitor loop's clock says nothing about that, and on an
      //     ICMP-polled switch — the case this field exists for — it would
      //     advance every 60s while the controller had not been read since the
      //     token expired, satisfying a 3-poll hold on one real observation.
      return assets
        .filter((a) => a.fortilinkStatus != null)
        .map((a) => ({ ...mk(a, "", "", a.fortilinkStatus), readingAt: a.fortilinkCheckedAt ?? null }));
    }
    case "tag": {
      // The reading is the NAMED tag when the asset carries it and "" when it
      // does not, so the ordinary comparator answers both forms: `== prod` is
      // true only of a tagged device, `!= prod` only of an untagged one. Every
      // asset in scope gets a reading — an untagged device is a real answer
      // here, not an unknown one. Tags live on the scope row already, so there
      // is no query at any fleet size. Matched whole and case-insensitively,
      // the way the scope condition's `tag` field is.
      const want = String(trigger.value ?? "").trim().toLowerCase();
      if (!want) return [];
      return assets.map((a) => {
        const has = (a.tags ?? []).some((t) => t.toLowerCase() === want);
        return { ...mk(a, "", "", has ? String(trigger.value).trim() : ""), readingAt: probeAt(a) };
      });
    }
    case "firmwareVsPrimary": {
      // Business rule 87. Same posture as fortilinkStatus: a device the
      // Repository cannot place — not a switch / AP, no usable serial, no
      // readable version, no primary image for its platform — produces NO
      // READING, so `!= current` is true only of devices that really differ.
      //
      // Scale: ONE findMany over the image table (≤ 2 rows per platform under a model node)
      // per evaluation, then an in-memory comparison per asset — never a
      // query per asset. The anchor is the system-info pass, which is what
      // refreshes osVersion; the probe tick says nothing about firmware.
      const primaries = await loadPrimaryFirmwareImages();
      const out: Reading[] = [];
      for (const a of assets) {
        const v = firmwareVsPrimary(
          { assetType: a.assetType, manufacturer: a.manufacturer ?? null, model: a.model ?? null, serialNumber: a.serialNumber ?? null, osVersion: a.osVersion ?? null },
          primaries,
        );
        if (v) out.push({ ...mk(a, "", "", v), readingAt: a.lastSystemInfoAt ?? probeAt(a) });
      }
      return out;
    }
    case "telemetryFailingMinutes":
      return assets.flatMap((a) => {
        const v = streamFailingMinutes(a.lastTelemetryAttemptAt ?? null, a.telemetryFailingSince ?? null);
        return v === null ? [] : [{ ...mk(a, "", "", v), readingAt: a.lastTelemetryAttemptAt ?? null }];
      });
    case "systemInfoFailingMinutes":
      return assets.flatMap((a) => {
        const v = streamFailingMinutes(a.lastSystemInfoAttemptAt ?? null, a.systemInfoFailingSince ?? null);
        return v === null ? [] : [{ ...mk(a, "", "", v), readingAt: a.lastSystemInfoAttemptAt ?? null }];
      });
    case "ifOperStatus": case "ifAdminStatus": case "ifIpAddress": case "poeStatus": {
      const col = INTERFACE_STATE_COLUMN[trigger.field];
      const since = new Date(Date.now() - lookbackMsFor(trigger));
      // No `distinct` any more: a poll-counted hold needs the RUN of readings
      // per port, so the rows are grouped here (newest first).
      const rows = await prisma.assetInterfaceSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { ifName: "asc" }, { timestamp: "desc" }], select: { assetId: true, ifName: true, alias: true, timestamp: true, operStatus: true, adminStatus: true, poeStatus: true, ipAddress: true } });
      // Only PINNED interfaces produce readings (Asset.monitoredInterfaces —
      // the same join the Down Interfaces widget uses): the interfaces stream
      // samples every port a device reports, and an unpinned port is usually
      // just unplugged — a 8-port switch must not raise 8 "interface down"
      // alerts. ifOperStatus additionally requires admin-up (an admin-downed
      // port is deliberately down, not an outage — the widget's adminStatus
      // gate). An interface that leaves the pin set (or gets admin-downed)
      // stops producing readings; the vanished-state sweep clears its alert.
      // The reading is the newest row that CARRIES the field, not the newest
      // row — see interfaceStateSeries for why, and for what a duplicate alert
      // email per collection gap used to look like.
      const byPort = groupSeries(rows, (r) => `${r.assetId}|${r.ifName}`);
      const tagged = await loadInterfaceTagFilter(df, ids);
      const out: Reading[] = [];
      for (const g of byPort) {
        const picked = interfaceStateSeries(trigger.field, g);
        if (!picked) continue;
        const { row: r, series } = picked;
        const a = index.get(r.assetId);
        if (!interfaceIsPinned(a, r.ifName)) continue;
        if (trigger.field === "ifOperStatus" && r.adminStatus !== "up") continue;
        // "disabled" is an operator's choice, the PoE analogue of the
        // admin-up gate above. Excluding it keeps a not-delivering rule from
        // alerting on ports PoE was deliberately turned off for. A fault rule
        // is unaffected: a disabled port reports "disabled", never "fault".
        if (trigger.field === "poeStatus" && r.poeStatus === "disabled") continue;
        if (!interfacePatternMatch(r.ifName, r.alias, df.ifNamePattern)) continue;
        if (!tagged(r.assetId, r.ifName)) continue;
        // An address is compared as its BARE form on both the reading and the
        // series, so the shape a transport happened to report it in ("0.0.0.0"
        // vs the CMDB pair "0.0.0.0 0.0.0.0") can't decide whether an operator's
        // `== 0.0.0.0` matches. Every other state column is passed through.
        const norm = trigger.field === "ifIpAddress"
          ? (v: string | null) => (v == null ? null : bareInterfaceIp(v))
          : (v: string | null) => v;
        out.push({ ...mk(a!, r.ifName, interfaceDimLabel(r.ifName, r.alias), norm(r[col])), series: series.map(norm), readingAt: r.timestamp });
      }
      // The pinned ports are done. A FAULT rule adds the rest of the PoE ports
      // from the current-state table — see unpinnedPoeFaultReadings for why the
      // two sources are unioned rather than one replacing the other. A reset
      // leaf of such a rule reads them too (`coverUnpinnedPoe`): it has to be
      // able to say the faulted port recovered, and `!= fault` never qualifies
      // for the carve-out on its own terms.
      if (trigger.field === "poeStatus" && (poeFaultCoversUnpinned(trigger) || opts?.coverUnpinnedPoe)) {
        out.push(...await unpinnedPoeFaultReadings(index, ids, df, mk));
      }
      return out;
    }
    case "ipsecStatus": {
      const since = new Date(Date.now() - lookbackMsFor(trigger));
      const rows = await prisma.assetIpsecTunnelSample.findMany({ where: { assetId: { in: ids }, timestamp: { gte: since } }, orderBy: [{ assetId: "asc" }, { tunnelName: "asc" }, { timestamp: "desc" }], select: { assetId: true, tunnelName: true, timestamp: true, status: true } });
      const byTunnel = groupSeries(rows, (r) => `${r.assetId}|${r.tunnelName}`);
      // Only PINNED tunnels produce readings (Asset.monitoredIpsecTunnels) —
      // the full system-info scrape samples every tunnel the gate reports, and
      // an unpinned tunnel is one nobody selected for monitoring, so a "tunnel
      // down" rule must not alert on it. See tunnelIsPinned.
      return byTunnel.filter((g) => tunnelIsPinned(index.get(g[0]!.assetId), g[0]!.tunnelName) && substringMatch(g[0]!.tunnelName, df.tunnelName)).map((g) => {
        const r = g[0]!;
        const a = index.get(r.assetId)!;
        return { ...mk(a, r.tunnelName, r.tunnelName, r.status), series: g.slice(0, SERIES_CAP).map((x) => x.status ?? null), readingAt: r.timestamp };
      });
    }
    case "sdwanMemberState": {
      // One reading per (health check, WAN member) off the SAME rows the SD-WAN
      // metrics read — `state` is the FortiGate's own verdict on whether the
      // member is alive, normalized to "up" | "down" at collection time
      // (monitoringService.normalizeSdwanState), so it is never null and every
      // sample carries it. That is the point of the field: a WAN port on a
      // cable modem stays oper-up through an ISP outage, and only the health
      // check knows the member is dead — whether it died on loss, latency or
      // jitter, which a threshold on any one of those three can't tell you.
      //
      // NO PIN GATE, unlike the interface and tunnel resolvers. Those exist
      // because a device reports every port it has and an 8-port switch must
      // not raise 8 alerts; a health-check member is an SLA object someone
      // configured, there are a handful per gate, and the collector already
      // samples only what `config system sdwan` declares. There is no pin set
      // to gate on either — AssetPerfSlaSample carries no pinned-subset
      // concept (its `cadence` is always "fast" for exactly that reason).
      //
      // A member that stops being reported (removed from the health check, or
      // the gate stopped answering) produces no reading rather than a stale
      // one, so clearVanishedStates retires its alert — the same contract as
      // an unpinned interface.
      const since = new Date(Date.now() - lookbackMsFor(trigger));
      const rows = await prisma.assetPerfSlaSample.findMany({
        where: { assetId: { in: ids }, timestamp: { gte: since } },
        orderBy: [{ assetId: "asc" }, { healthCheck: "asc" }, { link: "asc" }, { timestamp: "desc" }],
        select: { assetId: true, healthCheck: true, link: true, timestamp: true, state: true },
      });
      // Substring-matched on both dimensions, exactly as the sdwan* METRICS
      // filter them — an operator who narrowed a packet-loss rule to "Primary
      // WAN" must get the same set here or the two rules disagree about which
      // members they are about.
      const filtered = rows.filter((r) => sdwanDimensionMatch(r.healthCheck, df.healthCheck) && sdwanDimensionMatch(r.link, df.link));
      // dimKey matches the metrics' `healthCheck|link` so a member's state
      // alert and its loss alert name the same dimension.
      const memberReadings: Reading[] = groupSeries(filtered, (r) => `${r.assetId}|${r.healthCheck}|${r.link}`).map((g) => {
        const r = g[0]!;
        const a = index.get(r.assetId)!;
        return {
          ...mk(a, `${r.healthCheck}|${r.link}`, `${r.healthCheck} / ${r.link}`, r.state),
          series: g.slice(0, SERIES_CAP).map((x) => x.state),
          // The SD-WAN collector runs on its own cadence (the integration's
          // sdwanIntervalSeconds), not the monitor loop, so a forPolls hold
          // counts health-check reads — anchoring on lastMonitorAt would count
          // ICMP ticks during which nothing asked the gate about its SLA.
          readingAt: r.timestamp,
        };
      });
      // Business rule 98: a member with no address (a template's unplugged
      // wan2, down on every health check forever) is left out by "!= 0.0.0.0".
      const kept = await filterByMemberIp(df, memberReadings);
      // Business rule 90: a dead wan2 explains its dead overlays.
      return yieldToSdwanParents(trigger, trigger.field, kept, opts?.sdwanYielded);
    }
    case "sdwanRuleStatus": case "sdwanSelectedMember": {
      const rows = await prisma.assetSdwanRule.findMany({ where: { assetId: { in: ids } }, select: { assetId: true, ruleName: true, status: true, selectedMember: true, updatedAt: true } });
      const col = trigger.field === "sdwanRuleStatus" ? "status" : "selectedMember";
      // sdwanRulePattern narrows to the named rule(s) — without it every rule
      // on the gate is its own alerting dimension, which is the default.
      return rows.filter((r) => substringMatch(r.ruleName, df.sdwanRulePattern)).map((r) => {
        const a = index.get(r.assetId);
        if (!a) return null;
        // Delete-replaced per SUCCESSFUL SD-WAN read (runSdwanFor), so there is
        // no history to count: the row's own updatedAt is what says a NEW
        // reading happened. Not Asset.lastSdwanAt — that is stamped on failed
        // reads too, and a failed read re-observes nothing. (Until 2026-09 this
        // was lastSystemInfoAt, when the rules rode the system-info pass.)
        return { ...mk(a, r.ruleName, r.ruleName, (r as any)[col]), readingAt: r.updatedAt ?? null };
      }).filter(Boolean) as Reading[];
    }
    default: return [];
  }
}

export async function resolveHostMetricReading(trigger: Extract<Trigger, { type: "host_metric" }>): Promise<Reading | null> {
  const nowMs = Date.now();
  const since = new Date(nowMs - lookbackMsFor(trigger));
  // The time-windowed aggregate's own window — narrower than the fetch when a
  // poll-counted clear widened it (withRecoveryLookback).
  const aggSinceMs = aggregateSinceMs(trigger, nowMs);
  // Only one of the sample's columns is ever read per rule (valueOf below), so
  // select just that pair rather than 2000 whole rows. An unrecognized metric
  // still fetches timestamps and reads NaN, exactly as valueOf's default did.
  const select: Record<string, true> = { timestamp: true };
  if (["cpuPct", "memUsedPct", "memUsedBytes", "loadAvg1", "loadAvg5", "loadAvg15", "procRssBytes"].includes(trigger.metric)) {
    select[trigger.metric] = true;
  }
  const rows = await prisma.hostMetricsSample.findMany({ where: { timestamp: { gte: since } }, orderBy: { timestamp: "desc" }, take: 2000, select: select as any });
  if (rows.length === 0) return null;
  const num = (b: bigint) => Number(b);
  const valueOf = (r: any): number => {
    switch (trigger.metric) {
      case "cpuPct": return r.cpuPct;
      case "memUsedPct": return r.memUsedPct;
      case "memUsedBytes": return num(r.memUsedBytes);
      case "loadAvg1": return r.loadAvg1;
      case "loadAvg5": return r.loadAvg5;
      case "loadAvg15": return r.loadAvg15;
      case "procRssBytes": return num(r.procRssBytes);
      default: return NaN;
    }
  };
  // A COUNT window (business rule 66) makes the reading — and the series a hold
  // is counted off — the ROLLING aggregate, exactly as it does for a device
  // metric. The host is the one source that never misses a poll, so here the
  // window is a plain last-N: it is offered for the smoothing, not for holes.
  const winPolls = triggerWindowPolls(trigger);
  if (winPolls > 0) {
    const rolled = rollingAggregate(rows.map(valueOf), winPolls, trigger.aggregation);
    if (!rolled.length) return null;
    return {
      assetId: "", hostname: "Polaris host", tags: [], dimKey: "", dimLabel: "", value: rolled[0]!,
      series: rolled.slice(0, SERIES_CAP),
      readingAt: rows[0]?.timestamp ?? null,
    };
  }
  // Nothing inside the window is no reading, exactly as an empty fetch was
  // before the fetch could reach past it — unless the rule states a window
  // shorter than the 30 s host sample, when the newest sample stands in
  // (rule 178), provided it is inside the old lookback.
  let inWindow = aggSinceMs === -Infinity ? rows : rows.filter((r: any) => r.timestamp.getTime() >= aggSinceMs);
  if (inWindow.length === 0) {
    const fallbackSince = aggregateFallbackSinceMs(trigger, nowMs);
    const newest: any = rows[0];
    if (fallbackSince !== -Infinity && newest && newest.timestamp.getTime() >= fallbackSince) inWindow = [newest];
  }
  if (inWindow.length === 0) return null;
  let value: number;
  if (trigger.aggregation === "avg") value = inWindow.reduce((a, r) => a + valueOf(r), 0) / inWindow.length;
  else if (trigger.aggregation === "median") value = median(inWindow.map(valueOf)) ?? NaN;
  else if (trigger.aggregation === "min") value = Math.min(...inWindow.map(valueOf));
  else if (trigger.aggregation === "max") value = Math.max(...inWindow.map(valueOf));
  else value = valueOf(rows[0]); // latest
  // The host samples itself every 30s, so its readings ARE a series and a
  // poll-counted hold counts them the same way a device metric's is counted.
  return {
    assetId: "", hostname: "Polaris host", tags: [], dimKey: "", dimLabel: "", value,
    series: rows.slice(0, SERIES_CAP).map(valueOf),
    readingAt: rows[0]?.timestamp ?? null,
  };
}

export function readingMeets(trigger: Trigger, value: number | string | boolean | null): boolean {
  if (value === null || value === undefined) return false;
  if (trigger.type === "asset_metric" || trigger.type === "host_metric") {
    return typeof value === "number" && compareNum(value, trigger.operator, trigger.threshold);
  }
  if (trigger.type === "asset_state") {
    return compareValue(value, trigger.operator, trigger.value);
  }
  return false;
}

/**
 * The clear-sustain the ENGINE still owes, in seconds.
 *
 * Zero on a down automation whose sustain the monitor state machine already
 * served by holding the asset in `recovering` (business rule 36) — charging it
 * again would make "reset after 5 received polls" mean five polls of recovering
 * followed by five more minutes of a firing alert about a device that has been
 * green the whole time.
 */
export function engineSustainSec(rule: { trigger: Trigger; reset: ResetConfig }): number {
  if (downRecoveryConsumesSustain(rule.trigger, rule.reset)) return 0;
  return rule.reset.sustainSec ?? 0;
}

/**
 * Has a FIRING condition recovered, honoring hysteresis? Without a
 * clearThreshold (or for non-numeric readings) recovery is simply !meets —
 * the legacy behavior. With one, recovery requires the value to cross the
 * CLEAR threshold: fire at `cpu >= 90` with clearThreshold 80 recovers only
 * below 80; between 80 and 90 is the dead band (neither meets nor recovered —
 * the alert stays firing so a value hovering at the line can't flap).
 * A null/absent reading counts as recovered (matches legacy: !meets).
 */
export function recoveredMeets(trigger: Trigger, reset: ResetConfig, value: number | string | boolean | null): boolean {
  const meets = readingMeets(trigger, value);
  // A down automation whose reset sustain was consumed by the monitor state
  // machine (business rule 36) recovers when the asset actually reads `up`, not
  // the instant it stops reading `down`. Without this the alert would clear on
  // the FIRST answered packet — `recovering` is not `down`, so plain `!meets`
  // is true there — which is sooner than it cleared before the count existed,
  // the exact opposite of what asking for a longer confirmation run means.
  if (downRecoveryConsumesSustain(trigger, reset)) {
    // An absent reading still counts as recovered, matching every other branch:
    // the asset stopped reporting a status at all, and the vanished-state sweep
    // owns that case.
    if (value === null || value === undefined) return true;
    return !DOWN_ALERT_HOLDING_STATES.includes(String(value).toLowerCase());
  }
  if (reset.mode !== "auto" || reset.clearThreshold == null) return !meets;
  if ((trigger.type !== "asset_metric" && trigger.type !== "host_metric") || typeof value !== "number") return !meets;
  return !compareNum(value, trigger.operator, reset.clearThreshold);
}

// ─── Threshold / state evaluation ───────────────────────────────────────────

/** The rule-state subset the vanished-state sweep needs. */
export interface SweepStateRow {
  id: string;
  assetId: string | null;
  dimensionKey: string;
  state: string;
  notificationId: string | null;
}

/** The conditions that read what the SD-WAN cadence collects. */
const SDWAN_TARGETS: ReadonlySet<string> = new Set([
  "sdwanRuleStatus", "sdwanSelectedMember", "sdwanMemberState", "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss",
]);

/**
 * Business rule 174: which of these parked rows belong to a gate whose SD-WAN
 * is no longer COLLECTED at all — the integration's SD-WAN pull was switched
 * off, the gate's interfaces moved off FortiOS REST, or its integration is
 * gone. That is a configuration edge, not a collection gap: nothing will ever
 * re-read the rule that was "down" or the member that was failing, so the
 * alert stood for ever on the last reading taken before collection stopped.
 *
 * `resolveSdwanPollInterval` is the scheduler's own eligibility test
 * (`monitoringService.resolveSdwanPollIntervalForAsset`; null = nothing polls
 * it), injected so this module does not import the monitoring service. A
 * gate that is still polled and merely failing to answer is NOT here — it
 * stays frozen, as a collection gap should (rule 118 reports the stream).
 *
 * Runs only over rows already parked, for SD-WAN conditions; one resolve per
 * distinct gate.
 */
export async function sdwanCollectionStopped(
  rule: DbRule,
  rows: SweepStateRow[],
  resolveSdwanPollInterval: (assetId: string) => Promise<number | null>,
): Promise<Set<string>> {
  const gone = new Set<string>();
  const t = rule.trigger as { type?: string; metric?: string; field?: string };
  const target = t.type === "asset_metric" ? t.metric : t.type === "asset_state" ? t.field : undefined;
  if (!target || !SDWAN_TARGETS.has(target)) return gone;
  const assetIds = [...new Set(rows.map((st) => st.assetId).filter((id): id is string => !!id))];
  if (assetIds.length === 0) return gone;
  const stopped = new Set<string>();
  const BATCH = 10;
  for (let i = 0; i < assetIds.length; i += BATCH) {
    await Promise.all(assetIds.slice(i, i + BATCH).map(async (id) => {
      // A failed resolve proves nothing; leave the row parked.
      const interval = await resolveSdwanPollInterval(id).catch(() => 1);
      if (interval === null) stopped.add(id);
    }));
  }
  for (const st of rows) if (st.assetId && stopped.has(st.assetId)) gone.add(st.id);
  return gone;
}

/**
 * Business rule 167(a): which of these parked rows are about a path check, a
 * custom widget or a state probe that no longer EXISTS. The vanished sweep
 * leaves a row alone while its subject reports nothing for the rule — a
 * collection gap is not recovery — but a subject whose only check (or widget)
 * was deleted reports nothing for ever, so its alert stood until someone
 * cleared it by hand. Deleting the object is a configuration edge, like an
 * unpin. Asked of the database, not the profile cache: a cold cache on a role
 * that never warmed it would read as "every probe is gone".
 *
 * Runs only over rows already parked, for the three metrics that key on such
 * an id; one indexed read.
 */
export async function deletedTargetGone(rule: DbRule, rows: SweepStateRow[]): Promise<Set<string>> {
  const gone = new Set<string>();
  const keyed = rows.filter((st) => st.dimensionKey);
  if (keyed.length === 0) return gone;
  const t = rule.trigger as { type?: string; metric?: string };
  if (t.type !== "asset_metric" || !t.metric) return gone;
  const kind = isPathMetric(t.metric) ? "check" : t.metric === "customWidgetValue" ? "widget" : t.metric === "customStateValue" ? "probe" : null;
  if (!kind) return gone;
  // A state probe's key is `<probeId>|<rowKey>`; the others are the id itself.
  const idOf = (st: SweepStateRow) => (kind === "probe" ? st.dimensionKey.split("|")[0]! : st.dimensionKey);
  const ids = [...new Set(keyed.map(idOf))];
  const found = kind === "check"
    ? await prisma.pathCheck.findMany({ where: { id: { in: ids } }, select: { id: true } })
    : await prisma.manufacturerCustomWidget.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const live = new Set(found.map((r) => r.id));
  for (const st of keyed) if (!live.has(idOf(st))) gone.add(st.id);
  return gone;
}
