/**
 * src/services/alertChartService.ts — the last-hour charts in an alert email.
 *
 * A packet-loss alert that says only "93.8%" tells you something is wrong; the
 * same alert with the last hour of CPU, memory and response time next to it
 * tells you whether the device is sick or the path to it is. This builds those
 * three charts for one alert, as inline PNGs.
 *
 * Two deliberate choices:
 *
 *  - Built at DELIVERY time, not fire time. The drain is a queue, off the
 *    engine's hot path, so a per-alert sample query costs the alerting loop
 *    nothing — and an escalation email at T+90min gets a chart of the last
 *    hour rather than a re-render of a frozen snapshot.
 *  - Rendered to PNG (via @resvg/resvg-js, already a dependency) and attached
 *    inline. SVG in email is unrenderable in Gmail and Outlook, and data: URIs
 *    are stripped by both.
 *
 * Everything here is best-effort: no samples, an unreadable asset, or a
 * rasterizer failure degrades to the text summary the plain-text body carries
 * anyway. An alert must never fail to send because a chart didn't draw.
 */

import { prisma } from "../db.js";
import { foldProbeOutages, foldProbeRecoveries, replayProbeStates, type OutageKind } from "./probeOutageService.js";
import { describeDownDetectionFor, recoveryPollsFor } from "./downDetectionService.js";
import { downSeverityCss } from "../utils/severityStyle.js";
import { resolveMonitorSettings } from "./monitoringService.js";
import { logger } from "../utils/logger.js";
import { sparklineSvg, seriesStats, formatReading, timeAxisLabel, type SparkPoint } from "../utils/sparklineSvg.js";
import { alarmStatusToFlag, convertSensorForDisplay, sensorDisplayUnit } from "../utils/hardwareSensors.js";
import { coreVector } from "../utils/cpuCores.js";
import { getBranding } from "./brandingService.js";
import { SAMPLE_SDWAN_HEALTH_CHECK, SAMPLE_SDWAN_LINK } from "../utils/sampleAlertDevice.js";
import { forecastFromDailyPoints, loadStorageForecastSeries, type StorageForecastSeries } from "./storageForecastService.js";
import type { TrendPoint } from "../utils/linearTrend.js";
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

/**
 * Template token → what it draws. The token vocabulary lives in
 * notificationTemplate.
 *
 * `chart.trigger` is an ALIAS, not a fourth series: it renders whichever of the
 * others the automation actually fired on, so the graph an operator opened the
 * email for is the first one they see. A chart emitted through it is skipped
 * when its own token comes up later, so the body never repeats one.
 */
export const CHART_TOKENS = [
  "chart.trigger", "chart.sensor", "chart.probeLoss",
  "chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss",
  "chart.cpu", "chart.memory", "chart.responseTime",
  "chart.storage",
] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/** The metric an automation triggers on → the chart that explains it. */
export function chartTokenForMetric(metric: string | null | undefined): ChartToken | null {
  switch (metric) {
    case "hwSensorValue":
    case "hwSensorAlarm":
      return "chart.sensor";
    case "cpuPct":
    case "cpuCorePct":
      return "chart.cpu";
    case "memPct":
    case "memUsedBytes":
      return "chart.memory";
    case "responseTimeMs":
      return "chart.responseTime";
    case "probeLossPct":
      return "chart.probeLoss";
    // asset_state FIELDS land here too — Notification.metric records whatever
    // fired, and for a state alert that is the field. A device that stopped
    // answering is best explained by its probe history: the latency climbing,
    // then the gap where the answers stop.
    case "monitorStatus":
    case "consecutiveFailures":
      return "chart.responseTime";
    case "sdwanLatencyMs":
      return "chart.sdwanLatency";
    case "sdwanJitterMs":
      return "chart.sdwanJitter";
    case "sdwanPacketLoss":
      return "chart.sdwanLoss";
    // The SD-WAN state fields lead with LATENCY, which is the one health-check
    // gauge FortiOS always populates for a member that is answering at all, and
    // the default `link-cost-factor` a service rule selects on. A rule that
    // failed over because loss or jitter breached still shows both underneath —
    // the three SD-WAN charts always render as a set.
    // sdwanMemberState is here for the same reason, and the trio below it is
    // the answer an operator opens that email for: the health check declared
    // the member dead, and which of the three gauges walked out of SLA before
    // it died is what says whether to call the ISP.
    case "sdwanRuleStatus":
    case "sdwanSelectedMember":
    case "sdwanMemberState":
      return "chart.sdwanLatency";
    // A storage alert charts its filesystem (STORAGE_SCOPED_METRICS): the
    // 24-hour usage for the two usage metrics, the forecast for days-until-full.
    case "storageUsedPct":
    case "storageUsedBytes":
    case "storageDaysUntilFull":
      return "chart.storage";
    default:
      // Interface counters have no chart of their own yet, so the trigger
      // token renders away and the generic charts below it still tell the
      // device's story.
      return null;
  }
}

/**
 * Metrics whose alert is about ONE PORT, not the device — and which therefore
 * never get the device charts.
 *
 * A switch with a dead port is answering probes: that is how Polaris knows the
 * port is down. So its CPU, memory, response-time and packet-loss graphs are
 * all flat and healthy, and printing four of them under "Interface oper status
 * on port2 is down" says nothing about the fault while burying the facts that
 * do — the port's LLDP neighbour, which alertInterfaceService supplies in the
 * charts' place.
 *
 * Only the STATE fields are here, deliberately, not every interface-dimensioned
 * metric: a port that is DOWN — or that lost its address — is not a device
 * condition, but a port erroring or saturating plausibly correlates with the
 * device's own load, so an `ifInErrorRate` / `ifInBps` alert keeps its graphs.
 * (2026-09-26 briefly widened this to all eight interface metrics; operators
 * asked for the rate quartet's graphs back the same day.)
 *
 * The one thing a port-scoped alert CAN still chart is a WAN port that is an
 * SD-WAN member: the health checks probing through it are the picture of that
 * link, so `buildAlertCharts` draws the SD-WAN trio for it (see
 * loadWanMemberSeries). Any other port gets no charts at all.
 */
const PORT_SCOPED_METRICS: ReadonlySet<string> = new Set(["ifOperStatus", "ifAdminStatus", "ifIpAddress", "poeStatus"]);

export function isPortScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && PORT_SCOPED_METRICS.has(metric);
}

/**
 * Metrics whose alert is about a PATH, not the device — the SD-WAN triggers.
 *
 * Same argument as PORT_SCOPED_METRICS, one layer out: a FortiGate whose
 * VPN-SLA health check is losing 40% to wan1 is answering its own probes
 * perfectly, so its CPU, memory, response-time and packet-loss graphs are the
 * story of a healthy firewall printed under "SD-WAN packet loss on VPN-SLA /
 * wan1 is 41%". Operators read that as Polaris not knowing what the alert was
 * about (reported 2026-09-09), and they were right — the last hour of the
 * HEALTH CHECK is the graph being asked for.
 *
 * So these four device charts are dropped and the SD-WAN trio (latency, jitter,
 * loss for the health check + member the alert is keyed on) takes their place.
 * Unlike the port case the alert is not left graphless: there is a real
 * time-series behind it, `AssetPerfSlaSample`.
 *
 * BOTH the metric triggers and the state fields are here. A failover
 * (`sdwanSelectedMember`) or a rule going down (`sdwanRuleStatus`) is a
 * statement about the paths under that service rule, and the SLA metrics of the
 * health check it selects on are what say why it moved. `sdwanMemberState` is
 * the most literal case of all: it names one health check and one member, which
 * is exactly the pair these three charts draw.
 */
const SDWAN_SCOPED_METRICS: ReadonlySet<string> = new Set([
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "sdwanRuleStatus", "sdwanSelectedMember", "sdwanMemberState",
]);

export function isSdwanScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && SDWAN_SCOPED_METRICS.has(metric);
}

/**
 * Metrics whose alert is about a PATH FROM an agent host to some target — the
 * agent-run path checks. The PORT_SCOPED_METRICS argument again: the
 * host is healthy (it is the one reporting), so its CPU, memory and response
 * time are the story of a working workstation printed under "Path
 * latency for Intranet is 2400 ms". Those device charts are dropped and, until
 * a path-check sparkline exists, nothing takes their place; the Paths
 * tab the email links to carries the latency, availability and path.
 */
const PATH_CHECK_SCOPED_METRICS: ReadonlySet<string> = new Set([
  "pathLatencyMs", "pathHttpStatus", "pathOk", "pathFailurePct", "pathHopCount", "pathTlsDaysLeft",
]);

export function isPathCheckScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && PATH_CHECK_SCOPED_METRICS.has(metric);
}

/**
 * Metrics whose alert is about ONE FILESYSTEM — the storage triggers. The
 * PORT_SCOPED_METRICS argument once more: a server whose /data is 96% full is
 * answering its probes and idling, so its CPU, memory, response-time and loss
 * graphs describe a healthy box under "Storage used on /data is 96%". Those
 * four are dropped and `chart.storage` — the mount's own usage, or its forecast
 * for a days-until-full alert — takes their place. Keyed on
 * `Notification.dimension`, which for all three is the bare mount path.
 */
const STORAGE_SCOPED_METRICS: ReadonlySet<string> = new Set(["storageUsedPct", "storageUsedBytes", "storageDaysUntilFull"]);

export function isStorageScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && STORAGE_SCOPED_METRICS.has(metric);
}

/**
 * The automation threshold the storage chart draws, read off a stored rule
 * trigger — or null when the trigger is not a plain storage-metric condition.
 * Pure. A composite or grouped trigger returns null on purpose: which of its
 * leaves the alert "is" is not recoverable from the notification, and a line
 * (or a horizon) from the wrong leaf is worse than none.
 */
export function storageThresholdFromTrigger(trigger: unknown): number | null {
  if (!trigger || typeof trigger !== "object") return null;
  const t = trigger as { type?: unknown; metric?: unknown; threshold?: unknown };
  if (t.type !== "asset_metric" && t.type !== "host_metric") return null;
  if (typeof t.metric !== "string" || !STORAGE_SCOPED_METRICS.has(t.metric)) return null;
  return typeof t.threshold === "number" && Number.isFinite(t.threshold) ? t.threshold : null;
}

/**
 * Metrics whose alert is about the host's own LOAD — high CPU, high memory.
 *
 * The device is answering (that is how its CPU was read), so response time and
 * packet loss are the story of a reachable host printed under "CPU is 97%":
 * connectivity graphs that explain nothing about the fault. These alerts keep
 * the CPU and memory charts — BOTH, whichever one fired, since a runaway
 * process usually moves the two together and the reader wants to see whether
 * it did — and drop the rest. The top-5 process table (alertProcessService)
 * sits under them and names what is using the resource.
 */
const RESOURCE_SCOPED_METRICS: ReadonlySet<string> = new Set(["cpuPct", "cpuCorePct", "memPct", "memUsedBytes"]);

export function isResourceScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && RESOURCE_SCOPED_METRICS.has(metric);
}

/** The only charts a resource alert draws. */
const RESOURCE_CHART_TOKENS: readonly ChartToken[] = ["chart.cpu", "chart.memory"];

/** The SD-WAN health-check charts. The default body asks for all three, so a
 *  failover email shows every side of the SLA rather than whichever one the
 *  automation happened to watch; they all read one loaded `SdwanSeries`. */
const SDWAN_CHART_TOKENS: readonly ChartToken[] = ["chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss"];

/** The device-story charts an SD-WAN alert replaces. */
const DEVICE_CHART_TOKENS: readonly ChartToken[] = ["chart.cpu", "chart.memory", "chart.responseTime", "chart.probeLoss"];

/**
 * Which of `tokens` an alert on `metric` can draw — the scope swaps
 * buildAlertCharts applies before it reads any samples, as a pure function so
 * the automation wizard's variable list can say which charts a trigger will
 * ever show without a second copy of these rules. `chart.trigger` comes back
 * resolved to the chart it aliases. `has` says whether the alert carries what
 * a scoped chart needs: a WAN port to chart (interface alerts), a sensor name,
 * a mount path.
 */
export function chartTokensForAlert(
  tokens: Iterable<ChartToken>,
  metric: string | null | undefined,
  has: { port: boolean; sensor: boolean; mount: boolean },
): Set<ChartToken> {
  const wanted = new Set(tokens);
  const primary = chartTokenForMetric(metric);
  if (wanted.delete("chart.trigger") && primary) wanted.add(primary);
  // An alert about one port never draws the device charts — see
  // isPortScopedAlert. The only thing it can draw is the SD-WAN trio, when the
  // port is an SD-WAN member; without a port to ask about it draws nothing.
  // Returning the empty set (rather than filtering the token list) is what
  // makes every chart token render away and `pruneEmptyChartSection` drop the
  // "Last hour" heading with them, and it skips every sample query.
  const interfaceScoped = isPortScopedAlert(metric);
  if (interfaceScoped && !has.port) return new Set();
  // Same for a path-check alert (see PATH_CHECK_SCOPED_METRICS).
  if (isPathCheckScopedAlert(metric)) return new Set();
  // A sensor chart with no sensor has nothing to draw. Dropping it here (rather
  // than rendering "no data") is what keeps the token invisible on the ~all
  // alerts that aren't about a hardware sensor.
  if (!has.sensor) wanted.delete("chart.sensor");
  // The storage swap (see STORAGE_SCOPED_METRICS) — the same shape as the
  // SD-WAN one below: a storage alert loses the device charts and the sensor
  // chart (its dimension is a mount path, not a sensor), and every other alert
  // — or a storage alert with no mount to draw — loses the storage token.
  const storageScoped = isStorageScopedAlert(metric);
  if (storageScoped) {
    for (const t of DEVICE_CHART_TOKENS) wanted.delete(t);
    wanted.delete("chart.sensor");
  }
  if (!storageScoped || !has.mount) wanted.delete("chart.storage");
  // The SD-WAN swap (see SDWAN_SCOPED_METRICS): a path alert charts the health
  // check and NOT the firewall, so the four device charts come out of the token
  // set even though the body asked for them. Every other alert loses the SD-WAN
  // tokens the same way the sensor token goes: no query, and nothing rendered.
  //
  // Nothing is force-ADDED. The default body carries all three SD-WAN tokens
  // (latency, jitter and loss are one picture of a link), and a body customized
  // before they existed still leads with the right graph through
  // `{chart.trigger}` — which is what the alias is for — rather than having
  // charts it never asked for stitched into it.
  //
  // An interface alert keeps the SD-WAN tokens and NOTHING else: the device
  // charts are dropped as for an SD-WAN alert, and the sensor token has no
  // sensor to draw. Whether the trio then renders depends on the port being a
  // member (loadWanMemberSeries); a LAN port gets no rows and draws nothing.
  if (interfaceScoped) {
    for (const t of Array.from(wanted)) if (!SDWAN_CHART_TOKENS.includes(t)) wanted.delete(t);
  } else {
    for (const t of isSdwanScopedAlert(metric) ? DEVICE_CHART_TOKENS : SDWAN_CHART_TOKENS) wanted.delete(t);
  }
  // A CPU / memory alert keeps its two load charts and nothing else (see
  // RESOURCE_SCOPED_METRICS): the response-time and packet-loss connectivity
  // graphs come out even though the body asked for them. Nothing is added — a
  // body that dropped {chart.memory} still gets only what it asked for.
  if (isResourceScopedAlert(metric)) {
    for (const t of Array.from(wanted)) if (!RESOURCE_CHART_TOKENS.includes(t)) wanted.delete(t);
  }
  return wanted;
}

export const CHART_WINDOW_MS = 60 * 60 * 1000;

/** Cap the plotted points: an agent host reports per-minute, but a busy
 *  FortiGate can land far more, and 3000 polyline points is a big PNG for no
 *  extra information at 520px wide. */
const MAX_POINTS = 240;

export interface RenderedChart {
  token: ChartToken;
  /** cid: reference used from the HTML body. */
  cid: string;
  attachment: InlineAttachment | null;
  /** "CPU (last hour): now 62%, avg 40%, peak 97%" — the text-body fallback
   *  and the <img> alt text, so the numbers survive image blocking. */
  summary: string;
  /** False when the window held no samples at all. */
  hasData: boolean;
}

const META: Record<ChartToken, { label: string; unit: string; color: string; percent: boolean }> = {
  // Never rendered from these — the alias resolves to another token's chart.
  "chart.trigger": { label: "", unit: "", color: "#ea580c", percent: false },
  // The sensor chart's label and unit come from the sensor itself, so these are
  // only the fallbacks used when the alert isn't about one.
  "chart.sensor": { label: "Sensor", unit: "", color: "#ea580c", percent: false },
  "chart.cpu": { label: "CPU", unit: "%", color: "#2563eb", percent: true },
  "chart.memory": { label: "Memory", unit: "%", color: "#7c3aed", percent: true },
  // The Up green, not a neutral accent. Response time is the one chart that is
  // ABOUT reachability, so it speaks the same four colours as the Status pill
  // and the Last-30-min strip — green up, purple paying it back, red down, grey
  // explained — exactly as the device page's own response-time chart does.
  // Flat hex (a mail client has no theme to read) picked from the daylight
  // themes' --color-success, because the email card is white.
  "chart.responseTime": { label: "Response time", unit: " ms", color: "#2e7d32", percent: false },
  "chart.probeLoss": { label: "Packet loss", unit: "%", color: "#dc2626", percent: true },
  // The SD-WAN trio. Three colours nothing else in an email uses, so a reader
  // scanning a failover email can tell the three SLA gauges apart at a glance;
  // the health check and member ride in each label (see sdwanChartLabel).
  //
  // NONE of them pins its axis, packet loss included — and that is the one
  // place they diverge from `chart.probeLoss` on purpose. An SD-WAN SLA
  // threshold is typically 1–2%, so a 0–100 axis draws a breach of it as a flat
  // line on the floor with the dashed threshold sitting on top of it. These
  // charts exist to show a breach, so they self-scale and the SLA line is
  // always inside the plot (sparklineSvg folds `threshold` into the range).
  "chart.sdwanLatency": { label: "SD-WAN latency", unit: " ms", color: "#0e7490", percent: false },
  "chart.sdwanJitter": { label: "SD-WAN jitter", unit: " ms", color: "#b45309", percent: false },
  "chart.sdwanLoss": { label: "SD-WAN packet loss", unit: "%", color: "#be123c", percent: false },
  // Label, unit and axis come from the storage spec (storageUsageSpec /
  // storageForecastSpec); only the colour is read from here.
  "chart.storage": { label: "Storage", unit: "%", color: "#0f766e", percent: true },
};

/** Even-ish downsample that always keeps the newest point (the alerting one). */
function thin<T extends { t: number }>(points: T[]): T[] {
  return thinTo(points, MAX_POINTS);
}

function thinTo<T extends { t: number }>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** The memory chart's line, in whichever unit the device reported it. */
export interface MemorySeries {
  points: SparkPoint[];
  /** " GB" (or whichever binary unit fits the installed memory), or "%". */
  unit: string;
  percent: boolean;
  /** Installed memory in `unit` — the axis top and the "full" line. Null on a
   *  percentage series, whose axis is pinned 0–100 instead. */
  total: number | null;
}

const EMPTY_MEMORY: MemorySeries = { points: [], unit: "%", percent: true, total: null };

/**
 * The memory chart's series from raw telemetry rows. Pure.
 *
 * BYTES WIN whenever the window has them: "92%" on a 4 GB VM and on a 512 GB
 * host are different problems, and the reader of a high-memory alert wants to
 * know how much is in use against how much is installed. The axis runs 0 →
 * installed memory (the largest total in the window, so a VM resized mid-hour
 * still fits), scaled to the binary unit that total reads best in — GB on any
 * real host. Rows with only a percentage are dropped from a bytes series rather
 * than mixed onto the same axis.
 *
 * A device that reports ONLY a percentage (FortiOS) keeps the 0–100% chart:
 * there is no byte count to convert it back into.
 */
export function memorySeriesFrom(
  rows: Array<{ t: number; memPct: number | null; memUsedBytes: number | bigint | null; memTotalBytes: number | bigint | null }>,
): MemorySeries {
  const bytes = rows.filter((r) => r.memUsedBytes != null && r.memTotalBytes != null && Number(r.memTotalBytes) > 0);
  if (bytes.length > 0) {
    const totalBytes = Math.max(...bytes.map((r) => Number(r.memTotalBytes)));
    const { divisor, unit } = bytesDisplayScale(totalBytes);
    return {
      points: bytes.map((r) => ({ t: r.t, v: Number(r.memUsedBytes) / divisor })),
      unit,
      percent: false,
      total: totalBytes / divisor,
    };
  }
  const points = rows.filter((r) => r.memPct != null).map((r) => ({ t: r.t, v: r.memPct! }));
  return { ...EMPTY_MEMORY, points };
}

/**
 * One series per logical core from the per-sample `cpuCorePcts` vectors, index
 * 0 first (cores are numbered from 0, as the asset chart and the OS number
 * them). Pure. Null when NO row in the window carries a vector — the signal to
 * draw the plain all-cores chart instead. A core count that changes mid-window
 * (a VM resized) just gives the extra cores shorter series.
 */
export function coreSeriesFrom(rows: Array<{ t: number; cores: unknown }>): SparkPoint[][] | null {
  const series: SparkPoint[][] = [];
  for (const r of rows) {
    const v = coreVector(r.cores);
    if (!v) continue;
    v.forEach((pct, i) => (series[i] ??= []).push({ t: r.t, v: pct }));
  }
  return series.length > 0 ? series.map((s) => s ?? []) : null;
}

/**
 * The core a per-core alert is about, for the caption: the busiest at the
 * newest sample, ties to the higher peak. That is the core the alert's "now"
 * describes; the alert message itself names every core that held the line.
 */
export function busiestCore(series: SparkPoint[][]): { index: number; last: number; peak: number } | null {
  let best: { index: number; last: number; peak: number } | null = null;
  series.forEach((s, index) => {
    const st = seriesStats(s);
    if (!st) return;
    if (!best || st.last > best.last || (st.last === best.last && st.max > best.peak)) {
      best = { index, last: st.last, peak: st.max };
    }
  });
  return best;
}

/**
 * The per-core line colour — the same arc as the asset CPU chart's
 * `_cpuCoreColor` (public/js/assets.js): orange → violet, deliberately short
 * of red (the missed-poll colour) and with no grey (dependency-down), with
 * alternating lightness so adjacent cores stay apart on a crowded host. As hex,
 * because the email is rasterized and a flat value is the safe input.
 */
export function cpuCoreColor(i: number, n: number, dark = false): string {
  if (!n || n < 2) return hslToHex(205, 68, 50);
  const h = Math.round(35 + (i / n) * (320 - 35));
  return hslToHex(h, 68, dark ? 40 : i % 2 === 0 ? 46 : 63);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The per-core chart's caption: the busiest core first, then the all-cores
 *  line it sits over. Pure. */
export function perCoreCaption(hot: { index: number; last: number; peak: number }, allCores: SparkPoint[]): string {
  const all = seriesStats(allCores);
  return `Core ${hot.index} now ${formatReading(hot.last, "%")} · peak ${formatReading(hot.peak, "%")}` +
    (all ? ` · all cores now ${formatReading(all.last, "%")}` : "");
}

/** The per-core chart's text-body line, for a reader with images blocked. */
export function perCoreSummary(hot: { index: number; last: number; peak: number }, coreCount: number, allCores: SparkPoint[]): string {
  const all = seriesStats(allCores);
  return `CPU per core (last hour, ${coreCount} core${coreCount === 1 ? "" : "s"}): busiest Core ${hot.index} now ${formatReading(hot.last, "%")}, peak ${formatReading(hot.peak, "%")}` +
    (all ? `; all cores now ${formatReading(all.last, "%")}, avg ${formatReading(all.avg, "%")}, peak ${formatReading(all.max, "%")}` : "");
}

/** The all-cores line on a per-core chart: dark ink rather than the CPU blue,
 *  which sits inside the core arc and would vanish among the blue cores. */
const CPU_ALL_CORES_COLOR = "#1f2430";

/** Points per core line. Half the main series' cap: 64 cores × 240 points is a
 *  heavy PNG for lines that are context, not the reading. */
const MAX_CORE_POINTS = 120;

async function loadTelemetry(
  assetId: string,
  since: Date,
  withCores: boolean,
): Promise<{ cpu: SparkPoint[]; mem: MemorySeries; cores: SparkPoint[][] | null }> {
  const rows = await prisma.assetTelemetrySample.findMany({
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true, cpuCorePcts: withCores },
  });
  const cpu: SparkPoint[] = [];
  for (const r of rows) {
    if (r.cpuPct != null) cpu.push({ t: r.timestamp.getTime(), v: r.cpuPct });
  }
  const mem = memorySeriesFrom(rows.map((r) => ({ ...r, t: r.timestamp.getTime() })));
  const cores = withCores
    ? coreSeriesFrom(rows.map((r) => ({ t: r.timestamp.getTime(), cores: r.cpuCorePcts })))
    : null;
  return {
    cpu: thin(cpu),
    mem: { ...mem, points: thin(mem.points) },
    cores: cores ? cores.map((s) => thinTo(s, MAX_CORE_POINTS)) : null,
  };
}

export interface SensorSeries {
  points: SparkPoint[];
  /** Spans where the device's own alarm bit was set. */
  alarmSpans: Array<{ from: number; to: number }>;
  /** The unit to LABEL the axis with, after the display-unit swap. */
  unit: string;
  sensorClass: string | null;
}

/**
 * One hardware sensor's last hour, as the alert email charts it.
 *
 * The alert's `dimension` IS the sensor name — the engine keys both
 * hwSensorValue and hwSensorAlarm state rows on the bare `sensorName` — so it
 * drops straight into the query with no parsing.
 *
 * Values are converted for DISPLAY only (Celsius → Fahrenheit when the install
 * prefers it), gated on each reading's own stored unit, never on its class:
 * a fan's RPM and a rail's volts pass through untouched. Storage, rollups and
 * automation thresholds all stay Celsius.
 */
export async function loadSensorSeries(
  assetId: string,
  sensorName: string,
  since: Date,
  displayUnit: "c" | "f",
): Promise<SensorSeries> {
  const rows = await prisma.assetHardwareSensorSample.findMany({
    where: { assetId, sensorName, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, value: true, unit: true, alarmStatus: true, sensorClass: true },
  });

  const points: SparkPoint[] = [];
  const alarmSpans: Array<{ from: number; to: number }> = [];
  let storedUnit: string | null = null;
  let sensorClass: string | null = null;
  let openAlarm: { from: number; to: number } | null = null;

  for (const r of rows) {
    const t = r.timestamp.getTime();
    if (storedUnit === null && r.unit) storedUnit = r.unit;
    if (sensorClass === null && r.sensorClass) sensorClass = r.sensorClass;
    const v = convertSensorForDisplay(r.value, r.unit, displayUnit);
    if (v !== null) points.push({ t, v });

    // Merge consecutive alarming samples into one band rather than drawing a
    // sliver per sample.
    if (alarmStatusToFlag(r.alarmStatus) === 1) {
      if (openAlarm) openAlarm.to = t;
      else openAlarm = { from: t, to: t };
    } else if (openAlarm) {
      alarmSpans.push(openAlarm);
      openAlarm = null;
    }
  }
  if (openAlarm) alarmSpans.push(openAlarm);

  return {
    points: thin(points),
    alarmSpans,
    unit: sensorDisplayUnit(storedUnit, displayUnit),
    sensorClass,
  };
}

/**
 * One sensor reading as it should READ to an operator: the install's display
 * unit, and the value converted to match.
 *
 * The chart already does this, and the sentence above it has to agree — an
 * email that says "is 90.4 °C" over a chart drawn in °F is worse than either
 * on its own. Costs one branding read plus one indexed row, on the fire path
 * only (which is transition-guarded, so rare) and only for sensor metrics.
 */
export async function sensorReadingDisplay(
  assetId: string,
  sensorName: string,
  rawValue: number | string | boolean | null,
): Promise<{ value: number | string | boolean | null; unit: string }> {
  try {
    const [row, branding] = await Promise.all([
      prisma.assetHardwareSensorSample.findFirst({
        where: { assetId, sensorName },
        orderBy: { timestamp: "desc" },
        select: { unit: true },
      }),
      getBranding(),
    ]);
    const stored = row?.unit ?? null;
    const displayUnit = branding.temperatureUnit;
    const value = typeof rawValue === "number" ? convertSensorForDisplay(rawValue, stored, displayUnit) : rawValue;
    return { value, unit: sensorDisplayUnit(stored, displayUnit) };
  } catch {
    // Never block an alert on a unit lookup.
    return { value: rawValue, unit: "" };
  }
}

/**
 * Which SD-WAN path an alert is about.
 *
 * `healthChecks` is a LIST because the two shapes of SD-WAN alert name the path
 * differently. A metric alert (`sdwanLatencyMs` and friends) is keyed on one
 * exact pair — the engine's dimension is `"<healthCheck>|<link>"` — while a
 * rule alert (`sdwanRuleStatus` / `sdwanSelectedMember`) is keyed on the SERVICE
 * RULE, which references health checks by name and may reference several. Both
 * resolve to one charted pair; the difference is only whether the samples get a
 * say in which.
 */
export interface SdwanTarget {
  /** Health-check name(s) to chart, best first. */
  healthChecks: string[];
  /** The WAN member the alert names, when it names one. Null = whichever member
   *  of these health checks reported most recently. */
  link: string | null;
}

/**
 * `Notification.dimension` for an SD-WAN METRIC alert → the pair it names.
 *
 * The engine writes `${healthCheck}|${link}` (resolveAssetMetricReadings), and
 * FortiOS object names admit no `|`, so the FIRST separator splits it. A stored
 * dimension with no separator at all — a hand-written test alert, a row from
 * before the metric existed — is read as the health check with no member
 * preference rather than discarded, which is the same "chart what we can"
 * posture the rest of this file takes.
 */
export function parseSdwanDimension(dimension: string | null | undefined): SdwanTarget | null {
  if (!dimension) return null;
  const i = dimension.indexOf("|");
  const healthCheck = i < 0 ? dimension : dimension.slice(0, i);
  if (!healthCheck) return null;
  const link = i < 0 ? "" : dimension.slice(i + 1);
  return { healthChecks: [healthCheck], link: link || null };
}

/**
 * The SD-WAN path an alert is about, resolved from what the Notification kept.
 *
 * The metric half is pure string work. The rule half costs ONE indexed read of
 * `AssetSdwanRule` — the rule's `healthChecks` and its currently selected
 * member — because a rule alert's dimension is the rule NAME and nothing in the
 * notification says which health check sits under it. That table is
 * delete-replaced per scrape rather than a time series, so what comes back is
 * the rule as it stands at DELIVERY time.
 *
 * A rule dimension may name a MEMBER as well, as `"<ruleName>|<member>"`, and
 * that member wins over the rule's current selection. It is what a FAILOVER
 * alert stamps (`chartKeysForChangeEvent`), and it is the difference between an
 * email that explains itself and one that doesn't: the rule has already moved
 * by delivery time, so charting its current member draws the healthy link
 * traffic was moved ONTO, while the member it LEFT is the one whose latency
 * climbed through the SLA and made the gate act. Pipe-separated for the same
 * reason and on the same assumption as the metric dimension — FortiOS object
 * names admit no `|` — and a dimension without one keeps the current member.
 */
export async function resolveSdwanTarget(
  assetId: string,
  metric: string | null | undefined,
  dimension: string | null | undefined,
): Promise<SdwanTarget | null> {
  if (metric === "sdwanRuleStatus" || metric === "sdwanSelectedMember") {
    if (!dimension) return null;
    const i = dimension.indexOf("|");
    const ruleName = i < 0 ? dimension : dimension.slice(0, i);
    const namedMember = i < 0 ? "" : dimension.slice(i + 1);
    if (!ruleName) return null;
    try {
      const rule = await prisma.assetSdwanRule.findUnique({
        where: { assetId_ruleName: { assetId, ruleName } },
        select: { healthChecks: true, selectedMember: true },
      });
      const healthChecks = (rule?.healthChecks ?? []).filter((h) => !!h);
      // A rule with no performance SLA behind it (mode "priority" / "manual")
      // has no health check to chart. Nothing is drawn rather than a graph of
      // some unrelated check that happens to exist on the gate.
      if (healthChecks.length === 0) return null;
      return { healthChecks, link: namedMember || rule?.selectedMember || null };
    } catch (err) {
      logger.debug({ err: (err as Error)?.message, assetId, rule: ruleName }, "SD-WAN rule lookup failed — no SD-WAN chart");
      return null;
    }
  }
  return parseSdwanDimension(dimension);
}

/**
 * The `metric` / `dimension` an EVENT-triggered alert must carry for its charts
 * to resolve — or null for the ~all change events that have no chart.
 *
 * The event path is otherwise chart-blind by construction: it writes
 * `Notification.metric = null` and `dimension = null` (nothing "fired" as a
 * metric), so `chartTokenForMetric` answers nothing and the body falls through
 * to the device charts. On an SD-WAN failover that is the exact complaint this
 * feature exists to fix — the alert says "Branch-to-DC: wan1 → wan2" over an
 * hour of the firewall's CPU.
 *
 * `sdwanSelectedMember` is not a stand-in here: a failover IS that field
 * changing, so the stamped metric is the true one and every downstream reader
 * (the charts, the asset page's alert tooltip, the acknowledge page) says
 * something accurate. The member the rule LEFT rides the dimension because the
 * event details are the only place it exists — `AssetSdwanRule` is
 * delete-replaced and by delivery time holds only where the traffic went.
 *
 * Pure, and deliberately narrow: an action with no chart behind it returns null
 * and that alert is unchanged.
 */
export function chartKeysForChangeEvent(
  action: string,
  details: unknown,
): { metric: string; dimension: string } | null {
  if (action !== "change.sdwan.failover") return null;
  const d = details && typeof details === "object" ? (details as Record<string, unknown>) : null;
  const ruleName = typeof d?.ruleName === "string" ? d.ruleName.trim() : "";
  // The rule name is the only part that is load-bearing — without it there is
  // nothing to look the health check up by.
  if (!ruleName) return null;
  const from = typeof d?.from === "string" ? d.from.trim() : "";
  return { metric: "sdwanSelectedMember", dimension: from ? `${ruleName}|${from}` : ruleName };
}

/** One `AssetPerfSlaSample` row, as the fold below reads it. */
export interface SdwanSampleRow {
  timestamp: Date;
  healthCheck: string;
  link: string;
  state: string;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  latencyThresholdMs: number | null;
  jitterThresholdMs: number | null;
  packetLossThreshold: number | null;
}

export interface SdwanSeries {
  /** The pair actually charted — it rides into every label, because "SD-WAN
   *  latency" alone on a gate with four WAN members says nothing. */
  healthCheck: string;
  link: string;
  latency: SparkPoint[];
  jitter: SparkPoint[];
  loss: SparkPoint[];
  /** The health check's own SLA targets, drawn as each chart's dashed rule.
   *  Null where the health check configures no target for that metric. */
  latencyThresholdMs: number | null;
  jitterThresholdMs: number | null;
  packetLossThreshold: number | null;
  /** Spans where the health check reported this member DOWN. */
  downSpans: Array<{ from: number; to: number }>;
  /** The newest sample was down — the last span is still open, and the chart
   *  bands it to the right edge (the member is down as the email sends). */
  downAtEnd: boolean;
}

/**
 * Fold health-check samples into the three charted series. Pure; `rows` must be
 * ascending by timestamp.
 *
 * THE PICK IS THE INTERESTING PART. The rows may cover several members (and,
 * for a rule alert, several health checks), and these charts are single-series,
 * so exactly one pair gets drawn:
 *
 *   1. the pair the alert NAMES, when the alert names one and it reported in
 *      the window — a `sdwanPacketLoss` alert on VPN-SLA / wan1 must chart
 *      wan1, whatever the other members did;
 *   2. otherwise the freshest-reporting member, health checks tried in the
 *      order the target lists them. That is the fallback for a rule alert whose
 *      selected member has no SLA rows (FortiOS omits a member it could not
 *      probe at all), and drawing a sibling member of the same health check is
 *      still a picture of the path the rule is choosing between.
 *
 * The SLA thresholds come off the samples themselves rather than from the
 * automation: they are the FortiGate's own targets for that health check, which
 * is what the operator configured the failover on, and an automation watching
 * "latency > 150" would otherwise draw its own line over a link whose SLA
 * target is 80.
 */
export function sdwanSeriesFrom(rows: SdwanSampleRow[], target: SdwanTarget): SdwanSeries | null {
  if (rows.length === 0) return null;
  const groups = new Map<string, SdwanSampleRow[]>();
  for (const r of rows) {
    const key = `${r.healthCheck}|${r.link}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  let chosen: SdwanSampleRow[] | undefined;
  if (target.link) {
    for (const hc of target.healthChecks) {
      chosen = groups.get(`${hc}|${target.link}`);
      if (chosen) break;
    }
  }
  if (!chosen) {
    for (const hc of target.healthChecks) {
      let freshest: SdwanSampleRow[] | undefined;
      for (const g of groups.values()) {
        if (g[0]!.healthCheck !== hc) continue;
        const last = g[g.length - 1]!.timestamp.getTime();
        if (!freshest || last > freshest[freshest.length - 1]!.timestamp.getTime()) freshest = g;
      }
      if (freshest) { chosen = freshest; break; }
    }
  }
  // Rows came back for some other health check entirely — nothing here is about
  // the alert, so nothing is drawn.
  if (!chosen || chosen.length === 0) return null;

  const latency: SparkPoint[] = [];
  const jitter: SparkPoint[] = [];
  const loss: SparkPoint[] = [];
  const downSpans: Array<{ from: number; to: number }> = [];
  let latencyThresholdMs: number | null = null;
  let jitterThresholdMs: number | null = null;
  let packetLossThreshold: number | null = null;
  let openDown: { from: number; to: number } | null = null;

  for (const r of chosen) {
    const t = r.timestamp.getTime();
    if (r.latencyMs != null) latency.push({ t, v: r.latencyMs });
    if (r.jitterMs != null) jitter.push({ t, v: r.jitterMs });
    if (r.packetLoss != null) loss.push({ t, v: r.packetLoss });
    // Last non-null wins: the targets are constant across a health check's
    // members, but an operator can retune them mid-window and the chart should
    // draw the line the alert fired against.
    if (r.latencyThresholdMs != null) latencyThresholdMs = r.latencyThresholdMs;
    if (r.jitterThresholdMs != null) jitterThresholdMs = r.jitterThresholdMs;
    if (r.packetLossThreshold != null) packetLossThreshold = r.packetLossThreshold;
    // Consecutive down samples merge into one band rather than a sliver each —
    // same treatment, and the same reason, as the sensor chart's alarm bands.
    if (r.state !== "up") {
      if (openDown) openDown.to = t;
      else openDown = { from: t, to: t };
    } else if (openDown) {
      downSpans.push(openDown);
      openDown = null;
    }
  }
  const downAtEnd = openDown !== null;
  if (openDown) downSpans.push(openDown);

  return {
    healthCheck: chosen[0]!.healthCheck,
    link: chosen[0]!.link,
    latency: thin(latency),
    jitter: thin(jitter),
    loss: thin(loss),
    latencyThresholdMs,
    jitterThresholdMs,
    packetLossThreshold,
    downSpans,
    downAtEnd,
  };
}

/**
 * The DB half of the above. One indexed read on
 * `(assetId, healthCheck, link, timestamp)` — the health-check names are known,
 * so the member is deliberately NOT filtered: the fold needs the siblings to
 * fall back to when the named member reported nothing.
 */
async function loadSdwanSeries(assetId: string, target: SdwanTarget, since: Date): Promise<SdwanSeries | null> {
  const rows = await prisma.assetPerfSlaSample.findMany({
    where: { assetId, healthCheck: { in: target.healthChecks }, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: {
      timestamp: true, healthCheck: true, link: true, state: true,
      latencyMs: true, jitterMs: true, packetLoss: true,
      latencyThresholdMs: true, jitterThresholdMs: true, packetLossThreshold: true,
    },
  });
  return sdwanSeriesFrom(rows, target);
}

/**
 * The SD-WAN target for an INTERFACE alert on a port that is an SD-WAN member,
 * or null when no health check probed through that port in the window. Pure;
 * `rows` are that port's samples, ascending.
 *
 * A member can sit under several health checks (a DC check and an internet
 * check both probing out of wan1), and these charts draw one. The freshest one
 * leads — it is the one still reporting about the link — with the rest behind
 * it in first-seen order. The link is pinned to the port: unlike an SD-WAN
 * metric alert, there is no sibling member worth falling back to, since the
 * alert is about THIS port and a graph of wan2 under "wan1 is down" would be
 * the wrong link's story.
 */
export function wanMemberTarget(rows: Array<{ healthCheck: string; timestamp: Date }>, ifName: string): SdwanTarget | null {
  const last = new Map<string, number>();
  for (const r of rows) {
    if (!r.healthCheck) continue;
    last.set(r.healthCheck, Math.max(last.get(r.healthCheck) ?? 0, r.timestamp.getTime()));
  }
  if (last.size === 0) return null;
  const healthChecks = Array.from(last.keys()).sort((a, b) => last.get(b)! - last.get(a)!);
  return { healthChecks, link: ifName };
}

/**
 * The DB half: ONE read of the port's health-check samples in the window,
 * keyed on the member name (`AssetPerfSlaSample.link` is the FortiOS SD-WAN
 * member interface, the same name the interface alert's dimension carries).
 * Filtered on the link so the fold can never borrow a sibling member. On an
 * asset that is not an SD-WAN gate — every switch port — it returns nothing and
 * the alert stays graphless, which is what a LAN port has always got.
 */
async function loadWanMemberSeries(assetId: string, ifName: string, since: Date): Promise<SdwanSeries | null> {
  const rows = await prisma.assetPerfSlaSample.findMany({
    where: { assetId, link: ifName, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: {
      timestamp: true, healthCheck: true, link: true, state: true,
      latencyMs: true, jitterMs: true, packetLoss: true,
      latencyThresholdMs: true, jitterThresholdMs: true, packetLossThreshold: true,
    },
  });
  const target = wanMemberTarget(rows, ifName);
  return target ? sdwanSeriesFrom(rows, target) : null;
}

/**
 * What an SD-WAN chart CALLS itself: the metric, then the path.
 *
 * The label is drawn at a fixed position beside the now/avg/peak caption (no
 * text measurement is available to resvg here), so the path half is budgeted
 * and truncated rather than allowed to run under the caption.
 */
export function sdwanChartLabel(metricLabel: string, healthCheck: string, link: string): string {
  const path = link ? `${healthCheck} / ${link}` : healthCheck;
  const budget = 44 - metricLabel.length;
  const shown = path.length > budget ? `${path.slice(0, Math.max(4, budget - 1))}…` : path;
  return `${metricLabel} — ${shown}`;
}

async function loadResponseTimes(assetId: string, since: Date): Promise<SparkPoint[]> {
  const rows = await prisma.assetMonitorSample.findMany({
    // Response-time poll only. The NULL responseTimeMs on ICMP loss-sampler
    // rows already excludes them here; the explicit probeKind filter is the
    // stated contract rather than a side effect of that.
    where: { assetId, timestamp: { gte: since }, success: true, responseTimeMs: { not: null }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, responseTimeMs: true },
  });
  // Failed probes are excluded deliberately: they have no response time, and
  // plotting them as 0 would draw a fast device instead of an unreachable one.
  // Where they WERE is not lost — loadFailSpans turns them into the red bands
  // the chart breaks its line over.
  return thin(rows.map((r) => ({ t: r.timestamp.getTime(), v: r.responseTimeMs! })));
}

/** The charts that DIVE on a failed poll: the device-story trio. Not the loss
 *  chart (it IS the failures, drawn as a ratio) and not the sensor chart
 *  (its red is a band for the device's own alarm bit — two red vocabularies on
 *  one chart would be unreadable, and the two claims are different: an alarm
 *  is about a reading that is still arriving). */
const FAIL_SPAN_TOKENS: ReadonlySet<ChartToken> = new Set(["chart.cpu", "chart.memory", "chart.responseTime"]);

/** The charts that also draw the climb back OUT in purple. Just the one: the
 *  response-time chart is the only email chart about a VERDICT rather than a
 *  reading, which is the same line the in-app charts draw — CPU and memory keep
 *  their own series colour there too, so purple cannot come to mean two things. */
const RECOVER_SPAN_TOKENS: ReadonlySet<ChartToken> = new Set(["chart.responseTime"]);

export interface FailSpanSeries {
  /**
   * Merged consecutive-failure spans, for the line dives. `kind` carries the
   * colour: "outage" dives red (unexplained), "dependency" dives grey (the
   * parent was dark — the miss is accounted for). Same shape either way, so
   * the reader still sees that nothing was measured there.
   */
  spans: Array<{ from: number; to: number; kind: OutageKind }>;
  /**
   * Stretches where polls were ANSWERING with misses still outstanding — the
   * climb back out. Only the response-time chart uses them (see
   * RECOVER_SPAN_TOKENS); they ride this series because they are read from the
   * same probe rows, and the plotted points — successes only — could not
   * reconstruct the leaky bucket without the failures beside them.
   */
  recoverySpans: Array<{ from: number; to: number }>;
  /** How many polls failed in the window — the text fallback's number. */
  failedCount: number;
  /**
   * The colour an "outage" span is drawn in: the covering down automation's own
   * SEVERITY (business rule 36), already resolved to a hex by
   * `downSeverityCss`. Down is not inherently red — red is what `critical`
   * looks like — and the email must not override an operator's rating when the
   * device page honours it. Undefined for a passive or unresolved device, which
   * keeps the red the dive has always had.
   */
  downColor?: string;
}

/**
 * Failed-poll spans for the chart window. Pure; `rows` must be ascending.
 *
 * Consecutive failures merge into one span rather than a sliver per sample,
 * and a run still failing at the newest sample is OPEN — it extends to
 * `windowEndMs` (the chart's "now"), because a device that is down as the
 * email sends is down up to the right edge, not up to its last poll.
 *
 * `downThreshold` is the covering automation's missed-poll count, and it is
 * what splits amber from red: misses below it are "missed" (the device is short
 * of answers, not yet judged), the probe that reaches it turns the run red.
 * `null` is the PASSIVE device — no automation defines down for it, so nothing
 * may go red — and `undefined` means the caller could not resolve one, which
 * leaves every miss plain red exactly as before.
 *
 * `recoveryPolls` is that automation's reset, already converted to a poll count:
 * how many probes must ANSWER before the device is handed back its Up. It is
 * what keeps the climb purple past the bucket's drain on a "down after 3 missed,
 * up after 5 received" automation.
 */
export function failSpansFrom(
  rows: Array<{ timestamp: Date; success: boolean; dependencyDown?: boolean | null }>,
  windowEndMs: number,
  downThreshold?: number | null,
  recoveryPolls = 0,
): FailSpanSeries {
  // ONE replay behind BOTH halves — the amber/red split and the purple climb —
  // and it is the same state machine the Last-30-min strip runs in the browser
  // (probeOutageService.replayProbeStates mirrors _intermittencyStates). An
  // email and the device page describing the same probe differently is exactly
  // what this vocabulary exists to prevent.
  //
  // `undefined` threshold is the UNKNOWN case, distinct from passive: the replay
  // still runs (the purple needs it) but no miss is labelled "missed", so every
  // failure keeps the plain red dive it had before.
  const classify = downThreshold !== undefined;
  const base = rows.map((r) => ({
    timestamp: r.timestamp,
    failed: !r.success,
    dependency: r.dependencyDown === true,
  }));
  const states = replayProbeStates(base, downThreshold ?? null, recoveryPolls);
  const verdicts = base.map((v, i) => (
    classify && v.failed && states[i] === "warning" ? { ...v, belowThreshold: true } : v
  ));
  // `openToMs` is what carries a still-failing run out to the right edge: a
  // device that is down as the email sends is down up to "now".
  const windows = foldProbeOutages(verdicts, 0, windowEndMs);
  return {
    spans: windows.map((w) => ({ from: w.from.getTime(), to: w.to.getTime(), kind: w.kind })),
    recoverySpans: foldProbeRecoveries(base, downThreshold ?? null, recoveryPolls)
      .map((w) => ({ from: w.from.getTime(), to: w.to.getTime() })),
    failedCount: rows.reduce((n, r) => (r.success ? n : n + 1), 0),
  };
}

/**
 * The DB half: PRIMARY polls only, deliberately. The ICMP loss sampler fires
 * every 10s/5s precisely because probes are failing (rule 30 — ICMP never
 * confirms anything), so letting its rows define outage bands would paint
 * failure the operator's configured cadence never declared.
 */
async function loadFailSpans(assetId: string, since: Date, now: Date): Promise<FailSpanSeries> {
  const [rows, down] = await Promise.all([
    prisma.assetMonitorSample.findMany({
      where: { assetId, timestamp: { gte: since }, OR: [{ probeKind: null }, { probeKind: "primary" }] },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, success: true, dependencyDown: true },
    }),
    // Which automation defines down for this device, and at what count
    // (business rule 36). Reads the resolver's cached index, so it costs no
    // query in the steady state — and a failure here degrades to "no
    // threshold", i.e. the plain red dive, never to no chart.
    describeDownDetectionFor(assetId).catch(() => null),
  ]);
  // `passive` is a real answer, not a missing one: Polaris renders no verdict
  // for the device, so its misses stay amber and never go red — the same rule
  // the Last-30-min strip replays. A null result is the unknown case.
  const downThreshold = down ? (down.passive ? null : down.winner?.threshold ?? null) : undefined;
  const series = failSpansFrom(
    rows,
    now.getTime(),
    downThreshold,
    await resolveRecoveryPolls(assetId, down?.winner ?? null),
  );
  // A passive device never reaches `down`, so there is nothing to colour; an
  // unresolved one keeps the red. Only a real winner supplies a severity.
  const severity = down && !down.passive ? down.winner?.severity ?? null : null;
  return severity ? { ...series, downColor: downSeverityCss(severity) } : series;
}

/**
 * How many probes must ANSWER before this device reads Up again.
 *
 * Costs nothing in the common case: an automation with no reset hold is served
 * by the missed-poll count itself, which is the bucket's own drain. Only an
 * automation that asks for a LONGER confirmation run needs the device's cadence
 * to convert its stored seconds back into polls, and only then is an asset row
 * read. Failures degrade to the drain rather than to no chart.
 */
async function resolveRecoveryPolls(
  assetId: string,
  winner: {
    threshold: number;
    recoverySustainSec: number | null;
    recoverySustainPolls?: number | null;
    severity?: string;
  } | null,
): Promise<number> {
  if (!winner) return 0;
  // A reset that states its hold as a COUNT needs no cadence at all — and no
  // asset read to find one.
  if (winner.recoverySustainPolls && winner.recoverySustainPolls > 0) {
    return Math.min(100, Math.max(winner.threshold, Math.round(winner.recoverySustainPolls)));
  }
  if (!winner.recoverySustainSec) return winner.threshold;
  try {
    const ctx = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        assetType: true, discoveredByIntegrationId: true, monitorIntervalSec: true,
        cpuMemoryIntervalSec: true, temperatureIntervalSec: true, systemInfoIntervalSec: true,
        probeTimeoutMs: true,
        discoveredByIntegration: { select: { type: true } },
      },
    });
    if (!ctx) return winner.threshold;
    const resolved = await resolveMonitorSettings({
      ...ctx,
      discoveredByIntegrationType: ctx.discoveredByIntegration?.type ?? null,
    });
    return recoveryPollsFor(
      {
        ...winner,
        recoverySustainPolls: winner.recoverySustainPolls ?? null,
        // Not read by recoveryPollsFor — only the poll arithmetic is — but the
        // verdict type carries it, and inventing a value here would be a second
        // place that decides what colour Down is drawn in.
        severity: winner.severity ?? "critical",
      },
      resolved.intervalSeconds,
    );
  } catch {
    return winner.threshold;
  }
}

/** Bucket width for the packet-loss series — 30 points across the hour. */
const LOSS_BUCKET_MS = 2 * 60 * 1000;

/**
 * Bucket width for a loss chart over `windowMs`: the 2-minute floor (finer
 * than the probe cadence would only draw 0%/100% spikes), scaled up so a long
 * History still plots ~30 points — a 24-hour window gets 48-minute buckets
 * rather than 720 slivers. Exported for tests.
 */
export function lossBucketMs(windowMs: number): number {
  return Math.max(LOSS_BUCKET_MS, Math.round(windowMs / 30));
}

export interface ProbeLossSeries {
  /** Per-bucket loss ratio, for the plotted line. */
  points: SparkPoint[];
  /**
   * failed / total over the window, made of EVERY countable probe in it —
   * the misses taken while the device was `warning` or `down` included. What
   * the caption prints. Null when the window held no countable probes at all.
   *
   * This is deliberately NOT the engine's `probeLossPct` (see `engineRatioPct`
   * below and the header of `probeLossSeriesFrom`): the chart answers "what
   * happened to this device's packets over the hour", which is a question
   * about the window, while the metric answers "how lossy is this link",
   * which is a question the device's own outage does not belong in.
   */
  ratioPct: number | null;
  /**
   * The same window with business rule 29h applied — the failures of every
   * run that reached `down` dropped whole, onset included. The JS mirror of
   * what `probeLossQuery` computes, and therefore the number the alert
   * actually fired on.
   *
   * Nothing renders it. It exists so the SQL/JS parity test has a production
   * consumer of `outageRunFailures` to compare the query against, and so the
   * divergence between the caption and the alert's own value is stated in the
   * code rather than left for a reader to infer. Null on the same terms as
   * `ratioPct`, and additionally when the whole window was one outage.
   */
  engineRatioPct: number | null;
}

/**
 * Probe loss over time, as both a bucketed line and the window's own ratio.
 *
 * Pure so the arithmetic can be tested without a database — including the
 * engine's own, which `engineRatioPct` still mirrors. `rows` must be ascending
 * by timestamp.
 *
 * A BUCKET MEAN IS NOT A PROBE RATIO, and conflating them is what made an alert
 * read "18.3 %" over a chart captioned "avg 6.7 %": the per-bucket values are
 * the line's shape, while `ratioPct` weighs every probe equally across the
 * window. A 4-minute burst of total loss among 30 quiet 2-minute buckets is
 * 2/30 ≈ 6.7 % of BUCKETS but ~18 % of PROBES — and it is the probe ratio that
 * describes the hour, so that is what the caption prints.
 *
 * IT COUNTS PACKETS WHEREVER IT CAN, mirroring `probeLossQuery`: a burst row
 * from the ICMP sweep carries `packetsSent` / `packetsReceived` and describes N
 * echoes, so counting it as one outcome would understate loss exactly as it did
 * in the query. A row without them is the single-probe equivalent — 1 sent, 1
 * received on success. Unlike the query this does NOT drop poll rows once burst
 * rows exist: the chart is a picture of the window and dropping half its
 * samples would leave visible holes in the line. The caption can therefore sit
 * a little under the engine's reading on a mixed asset, which is the honest
 * trade — the line has to be continuous, the number has to be comparable.
 *
 * IT NO LONGER STEPS OVER THE OUTAGE THE QUERY DOES (2026-09-14). Business
 * rule 29h still governs the ENGINE — the failures of a run that reached `down`
 * are the outage rather than the link, and `probeLossQuery` drops them so a
 * recovered device cannot re-alert as loss — but the CHART is a picture of an
 * hour, and a picture that omits the worst of it is not one. Every countable
 * probe in the window is in both the line and the caption, the misses taken
 * while the device was `warning` and `down` included.
 *
 * What forced it: a response-time chart showing a run of yellow then red dots
 * sat directly above a packet-loss chart reading a flat 0 % across the same
 * minutes. The exclusion is invisible to the operator — nothing on the loss
 * chart says "these probes are accounted for elsewhere" — so the two charts in
 * one alert simply contradicted each other, and the loss chart is the one that
 * looked broken. Its whole job is to say what happened to the packets.
 *
 * THE COST IS REAL AND ACCEPTED: the caption can now read "avg 40 %" under an
 * alert that fired at 8 %, which is exactly the mismatch rule 29g built this
 * parity to prevent. The trade is that the caption describes the WINDOW and the
 * alert value describes the METRIC, and only one of those two numbers is
 * reconstructible from the picture. `engineRatioPct` carries the other, so the
 * divergence is computed rather than hidden.
 *
 * NOTHING IS DROPPED, so no stretch of the line goes missing and a window that
 * was entirely one outage now draws a flat 100 % and captions 100 % — where it
 * used to draw nothing and be removed by `pruneEmptyChartSection`. That is the
 * honest picture of a device that answered nothing for an hour.
 *
 * THE ANCHOR IS GONE (2026-09-01), and with it `measuredFromMs` and the marker
 * the chart drew for it. `ratioPct` used to discard everything before the
 * window's first successful probe and before `Asset.recoveryStartedAt`, so the
 * caption measured less of the window than the line drew and the two had to be
 * reconciled with a rule drawn across the chart. Both halves now cover the same
 * window, so there is nothing left to mark.
 *
 * Empty buckets are skipped rather than plotted as 0 %: a gap in polling is not
 * a period of perfect health.
 */
/**
 * The row indices to leave out of a loss reading: the FAILURES of every maximal
 * run of consecutive failures that contains a row stamped `assetDown`.
 *
 * The JS mirror of `probeLossQuery`'s `runId` / `runOutage` window functions
 * (business rule 29h). Since 2026-09-14 it no longer shapes what the chart
 * draws — the line and the caption count every probe — and feeds only
 * `ProbeLossSeries.engineRatioPct`, which is what keeps this mirror honest
 * against the SQL. `assetDown` is only stampable from the probe that
 * DECLARES an outage onward — at the first missed poll nobody knows yet which
 * it is — so the run is what recovers the onset. Bounded by successes rather
 * than by counting back `missedPolls - 1` rows, because that count belongs to
 * whichever automation covers the device and changes when an operator edits it.
 *
 * `rows` must be ascending by timestamp, which is `loadProbeLoss`'s contract.
 * Exported for the parity test against the SQL.
 */
export function outageRunFailures(rows: Array<{ success: boolean; assetDown?: boolean | null }>): Set<number> {
  const out = new Set<number>();
  let run: number[] = [];
  let sawOutage = false;
  const flush = () => {
    if (sawOutage) for (const i of run) out.add(i);
    run = [];
    sawOutage = false;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.success) { flush(); continue; }
    run.push(i);
    // NULL/undefined reads as false, never as unknown — the exclusion is not
    // retroactive, so a run of pre-column rows is loss like any other.
    if (r.assetDown === true) sawOutage = true;
  }
  flush();
  return out;
}

export function probeLossSeriesFrom(
  rows: Array<{
    timestamp: Date;
    success: boolean;
    packetsSent?: number | null;
    packetsReceived?: number | null;
    assetDown?: boolean | null;
  }>,
  bucketMs: number = LOSS_BUCKET_MS,
): ProbeLossSeries {
  const buckets = new Map<number, { sent: number; recv: number }>();
  // Business rule 29h, kept for `engineRatioPct` alone: the failures of a run
  // that reached DOWN are the outage rather than the link, so the METRIC steps
  // over them. The chart does not — every probe below lands in the line, in the
  // caption and in the buckets, whatever state the device was in when it ran.
  const outage = outageRunFailures(rows);
  let sent = 0;
  let recv = 0;
  let engineSent = 0;
  let engineRecv = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    // NULL is the single-probe equivalent, never zero — reading it as zero
    // would drop the response-time poll's own rows out of the denominator.
    const s = typeof r.packetsSent === "number" && r.packetsSent > 0 ? r.packetsSent : 1;
    const v = typeof r.packetsReceived === "number" && r.packetsReceived >= 0
      ? Math.min(r.packetsReceived, s)
      : (r.success ? 1 : 0);
    const key = Math.floor(r.timestamp.getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key) ?? { sent: 0, recv: 0 };
    b.sent += s;
    b.recv += v;
    buckets.set(key, b);
    sent += s;
    recv += v;
    if (!outage.has(i)) {
      engineSent += s;
      engineRecv += v;
    }
  }
  const points = thin(
    Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({ t, v: Math.round(((b.sent - b.recv) / b.sent) * 1000) / 10 })),
  );
  return {
    points,
    ratioPct: sent ? Math.round(((sent - recv) / sent) * 1000) / 10 : null,
    engineRatioPct: engineSent ? Math.round(((engineSent - engineRecv) / engineSent) * 1000) / 10 : null,
  };
}

/**
 * The DB half of the above: an hour of one asset's probes is ~120 rows, so this
 * is bucketed in JS rather than SQL — a grouped query would cost more to write
 * than it saves, and it keeps the loader shaped like its neighbours.
 */
async function loadProbeLoss(assetId: string, since: Date, bucketMs: number = LOSS_BUCKET_MS): Promise<ProbeLossSeries> {
  const rows = await prisma.assetMonitorSample.findMany({
    // EVERY probeKind, deliberately — this is a loss chart, and the ICMP sweep
    // exists to give it resolution. One of only three all-kinds readers (with
    // probeLossQuery and readMonitorHistory's `loss` line, which buckets
    // through probeLossSeriesFrom too); everything else is response-time-poll
    // only.
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, success: true, packetsSent: true, packetsReceived: true, assetDown: true },
  });
  return probeLossSeriesFrom(rows, bucketMs);
}

// ─── The storage chart ────────────────────────────────────────────────────────
//
// A storage alert is about ONE FILESYSTEM, so it charts that mount rather than
// the device (STORAGE_SCOPED_METRICS). Two shapes, one token:
//
//  - `storageUsedPct` / `storageUsedBytes`: the mount's last hour
//    (STORAGE_USAGE_WINDOW_MS — the same window as every other alert chart),
//    in the unit the automation compares, with its threshold dashed.
//  - `storageDaysUntilFull`: a FORECAST. The daily points the automation's
//    number was fitted on (storageForecastService.loadStorageForecastSeries —
//    the same SQL, the same regression), then the trend carried forward as a
//    dashed line for the AUTOMATION's own horizon — its threshold in days — to
//    the capacity line. The caption quotes the same "full in N d" the alert
//    fired on, so the picture and the number cannot disagree.

/** How far back a used-% / used-bytes storage chart looks. The last hour, like
 *  every other alert chart (operator decision 2026-09-30, reversing the 24 h
 *  window of 2026-09-28 — it sat under the email's "Last hour" heading). */
export const STORAGE_USAGE_WINDOW_MS = CHART_WINDOW_MS;

/** A forecast chart's horizon when the automation's threshold is unknown (a
 *  deleted rule, a composite trigger): enough past the projected fill date to
 *  see it, never shorter than a week. */
const STORAGE_FORECAST_DEFAULT_HORIZON_DAYS = 7;

const DAY_MS = 86_400_000;

/** Everything one storage chart draws, in its display unit. Pure output of
 *  `storageUsageSpec` / `storageForecastSpec`, so the geometry is testable
 *  without a rasterizer. */
export interface StorageChartSpec {
  label: string;
  points: SparkPoint[];
  projection: SparkPoint[];
  unit: string;
  percent: boolean;
  threshold: number | null;
  ceiling: number | null;
  from: number;
  to: number;
  /** Set only on a forecast, where the axis runs past now. */
  now: number | null;
  /** Replaces the now/avg/peak caption (forecast only). */
  caption: string | null;
  /** The plain-text line — the img alt text and the text body. */
  summary: string;
}

/** Bytes → the largest binary unit that keeps the number ≥ 1. */
export function bytesDisplayScale(maxBytes: number): { divisor: number; unit: string } {
  const units = [" B", " KB", " MB", " GB", " TB", " PB"];
  let i = 0;
  let d = 1;
  while (i < units.length - 1 && maxBytes >= d * 1024) { d *= 1024; i++; }
  return { divisor: d, unit: units[i]! };
}

/**
 * The last-hour usage chart for a used-% or used-bytes alert. Pure. Percent is
 * pinned 0–100 like every percentage chart here; bytes self-scale in the unit
 * that fits the larger of the data and the threshold, and the threshold is
 * scaled with it so the dashed line lands where the automation compares.
 */
export function storageUsageSpec(
  rows: Array<{ t: number; used: number | null; total: number | null }>,
  opts: { metric: string; mountPath: string; threshold: number | null; now: number },
): StorageChartSpec {
  const from = opts.now - STORAGE_USAGE_WINDOW_MS;
  const label = sdwanChartLabel("Storage used", opts.mountPath, "");
  if (opts.metric === "storageUsedBytes") {
    const maxBytes = Math.max(0, ...rows.map((r) => r.used ?? 0), opts.threshold ?? 0);
    const { divisor, unit } = bytesDisplayScale(maxBytes);
    const points = rows.filter((r) => r.used != null).map((r) => ({ t: r.t, v: r.used! / divisor }));
    return {
      label, points, projection: [], unit, percent: false,
      threshold: opts.threshold != null ? opts.threshold / divisor : null,
      ceiling: null, from, to: opts.now, now: null, caption: null,
      summary: summaryLine(label, unit, points, STORAGE_USAGE_WINDOW_MS),
    };
  }
  const points = rows
    .filter((r) => r.used != null && r.total != null && r.total > 0)
    .map((r) => ({ t: r.t, v: (r.used! / r.total!) * 100 }));
  return {
    label, points, projection: [], unit: "%", percent: true,
    threshold: opts.threshold, ceiling: null, from, to: opts.now, now: null, caption: null,
    summary: summaryLine(label, "%", points, STORAGE_USAGE_WINDOW_MS),
  };
}

/**
 * The forecast chart for a days-until-full alert. Pure.
 *
 * History: the fitted daily points, as % of capacity. Projection: from NOW at
 * the latest day's usage — the point the fit measures "days until full" from —
 * climbing at the fitted rate. It stops at 100% (the red dot is the projected
 * full date) or at the horizon, whichever comes first. The horizon is the
 * automation's threshold in days: an alert fires only when the fill date is
 * inside it, so the line normally reaches the capacity line on the chart. A
 * mount that no longer qualifies by delivery (cleaned up, too few points) gets
 * its history and a caption saying so, rather than an invented projection.
 */
export function storageForecastSpec(
  series: StorageForecastSeries,
  opts: { mountPath: string; horizonDays: number | null; now: number },
): StorageChartSpec {
  const label = sdwanChartLabel("Storage forecast", opts.mountPath, "");
  const total = series.totalBytes;
  const pts = series.points;
  const first = pts.length ? pts[0]!.t : opts.now - 30 * DAY_MS;
  const from = Math.min(first, opts.now - DAY_MS);
  const days = series.daysUntilFull;
  const horizonDays = Math.min(
    365,
    Math.max(1, opts.horizonDays && opts.horizonDays > 0
      ? opts.horizonDays
      : Math.max(STORAGE_FORECAST_DEFAULT_HORIZON_DAYS, Math.ceil((days ?? 0) * 1.25))),
  );
  const to = opts.now + horizonDays * DAY_MS;
  const histWin = timeAxisLabel(opts.now - from);
  const aheadWin = timeAxisLabel(to - opts.now);

  if (total == null || total <= 0) {
    // No capacity, no percentage and no fill date — the history in bytes is all
    // there is to show.
    const { divisor, unit } = bytesDisplayScale(Math.max(0, ...pts.map((p) => p.v)));
    const points = pts.map((p) => ({ t: p.t, v: p.v / divisor }));
    return {
      label, points, projection: [], unit, percent: false, threshold: null, ceiling: null,
      from, to: opts.now, now: null, caption: "capacity unknown — no forecast",
      summary: `${label} (last ${histWin}): capacity unknown, no forecast`,
    };
  }

  const points = pts.map((p) => ({ t: p.t, v: (p.v / total) * 100 }));
  const lastPct = points.length ? points[points.length - 1]!.v : null;
  if (series.slopePerDay == null || days == null || lastPct == null) {
    return {
      label, points, projection: [], unit: "%", percent: true, threshold: null, ceiling: 100,
      from, to, now: opts.now,
      caption: lastPct != null ? `now ${formatReading(lastPct, "%")} · no longer growing` : "no data",
      summary: lastPct != null
        ? `${label} (last ${histWin}): now ${formatReading(lastPct, "%")}, no longer growing — no fill date`
        : `${label} (last ${histWin}): no data`,
    };
  }

  const pctPerDay = (series.slopePerDay / total) * 100;
  const endDays = Math.min(days, horizonDays);
  const projection = [
    { t: opts.now, v: lastPct },
    { t: opts.now + endDays * DAY_MS, v: Math.min(100, lastPct + pctPerDay * endDays) },
  ];
  const growth = `+${formatReading(pctPerDay, "%")}/day`;
  const full = days <= 0 ? "full now" : `full in ${formatReading(days)} d`;
  return {
    label, points, projection, unit: "%", percent: true, threshold: null, ceiling: 100,
    from, to, now: opts.now,
    caption: `now ${formatReading(lastPct, "%")} · ${growth} · ${full}`,
    summary: `${label} (last ${histWin}, next ${aheadWin}): now ${formatReading(lastPct, "%")}, growing ${formatReading(pctPerDay, "%")}/day, ` +
      (days <= 0 ? "full now" : `projected full in ${formatReading(days)} days`),
  };
}

/** The last-hour read for a usage chart: one mount, one indexed range read on
 *  `(assetId, mountPath, timestamp)`. */
async function loadStorageUsage(assetId: string, mountPath: string, since: Date) {
  const rows = await prisma.assetStorageSample.findMany({
    where: { assetId, mountPath, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, usedBytes: true, totalBytes: true },
  });
  return thin(
    rows.map((r) => ({ t: r.timestamp.getTime(), used: r.usedBytes != null ? Number(r.usedBytes) : null, total: r.totalBytes != null ? Number(r.totalBytes) : null })),
  );
}

/** Invented storage series for a TEST alert (business rule 65): a mount
 *  creeping up over the day, or a month of steady growth heading for full. */
function sampleStorageSpec(metric: string, mountPath: string, threshold: number | null, now: number): StorageChartSpec {
  if (metric === "storageDaysUntilFull") {
    const total = 500 * 1024 ** 3;
    const points: TrendPoint[] = [];
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    for (let d = 29; d >= 0; d--) {
      const i = 29 - d;
      points.push({ t: today - d * DAY_MS, v: total * (0.62 + i * 0.011 + 0.004 * Math.sin(i * 1.7)) });
    }
    return storageForecastSpec(forecastFromDailyPoints(points, total), { mountPath, horizonDays: threshold, now });
  }
  const total = 500 * 1024 ** 3;
  const from = now - STORAGE_USAGE_WINDOW_MS;
  const rows = sampleWave(from, now, (f, i) => clamp(0.78 + 0.04 * f + 0.006 * Math.sin(i * 0.37) + (f > 0.85 ? (f - 0.85) * 0.9 : 0), 0, 1))
    .map((p) => ({ t: p.t, used: p.v * total, total }));
  return storageUsageSpec(rows, { metric, mountPath, threshold, now });
}

/** Render one storage spec into the chart entry the email embeds. */
async function renderStorageChart(spec: StorageChartSpec, color: string): Promise<RenderedChart> {
  const svg = sparklineSvg(spec.points, {
    label: spec.label,
    unit: spec.unit,
    color,
    ...(spec.percent ? { yMin: 0, yMax: 100 } : {}),
    threshold: spec.threshold,
    ceiling: spec.ceiling,
    projection: spec.projection,
    from: spec.from,
    to: spec.to,
    ...(spec.now != null ? { now: spec.now } : {}),
    ...(spec.caption ? { caption: spec.caption } : {}),
  });
  const png = spec.points.length > 0 ? await rasterize(svg) : null;
  const cid = "polaris-chart-storage@polaris";
  return {
    token: "chart.storage",
    cid,
    hasData: spec.points.length > 0,
    summary: spec.summary,
    attachment: png ? { cid, filename: "chart-storage.png", contentType: "image/png", content: png } : null,
  };
}

async function rasterize(svg: string): Promise<Buffer | null> {
  try {
    // Lazy import: resvg resolves a per-platform native binding, and an alert
    // must still send on a host where that binding is unavailable.
    const { Resvg } = await import("@resvg/resvg-js");
    return Buffer.from(new Resvg(svg).render().asPng());
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "alert chart rasterization failed — falling back to text");
    return null;
  }
}

function summaryLine(
  label: string,
  unit: string,
  points: SparkPoint[],
  windowMs: number = CHART_WINDOW_MS,
  avgOverride?: number | null,
): string {
  const win = windowMs === CHART_WINDOW_MS ? "last hour" : `last ${timeAxisLabel(windowMs)}`;
  const s = seriesStats(points);
  if (!s) return `${label} (${win}): no data`;
  // Same substitution the SVG caption makes — the text fallback is what a
  // recipient with images blocked reads, so the two must quote one number.
  const avg = avgOverride ?? s.avg;
  return `${label} (${win}): now ${formatReading(s.last, unit)}, avg ${formatReading(avg, unit)}, peak ${formatReading(s.max, unit)}`;
}

/** One sample point per minute — the cadence an agent host reports at. */
const SAMPLE_STEP_MS = 60_000;

/**
 * Two incommensurate sines, so a generated trace reads as telemetry rather
 * than as a sine wave. Deterministic on purpose: the same test email twice
 * draws the same picture, which is what makes "did the chart change?" a
 * meaningful question while someone is editing a template.
 */
function sampleWave(from: number, to: number, at: (fraction: number, i: number) => number): SparkPoint[] {
  const points: SparkPoint[] = [];
  const span = Math.max(1, to - from);
  for (let t = from, i = 0; t <= to; t += SAMPLE_STEP_MS, i++) {
    points.push({ t, v: Math.round(at((t - from) / span, i) * 10) / 10 });
  }
  return points;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The invented test device's installed memory. */
const SAMPLE_MEM_TOTAL_GB = 16;
/** The invented test device's cores, and the one a per-core test alert pins. */
const SAMPLE_CORE_COUNT = 8;
const SAMPLE_HOT_CORE = 3;

/**
 * INVENTED telemetry for a TEST alert's charts (business rule 65) — see
 * `utils/sampleAlertDevice`.
 *
 * A test alert is attached to no asset (`Notification.assetId` is null), so
 * there is nothing to query and nothing that SHOULD be queried: charting a real
 * device's last hour under a made-up hostname would put real telemetry back in
 * the one email whose whole point is that it carries none. These series are
 * generated instead, shaped so each chart shows what its real counterpart
 * shows: a ramp on CPU, a spike on response time, a couple of lossy buckets,
 * an SLA line the path is about to cross.
 *
 * PURE and deterministic. `fail` spans are deliberately not generated — the
 * dives mean "Polaris missed polls here", and inventing an outage on a device
 * that does not exist teaches the reader the wrong thing about the picture.
 */
export function sampleChartSeries(
  tokens: Iterable<ChartToken>,
  opts: { since: Date; now: Date; lossSince: Date; lossBucketMs: number; displayUnit: "c" | "f"; perCore?: boolean },
): { cpu: SparkPoint[]; mem: MemorySeries; rt: SparkPoint[]; loss: ProbeLossSeries; sensor: SensorSeries; sdwan: SdwanSeries | null; cores: SparkPoint[][] | null } {
  const wanted = new Set(tokens);
  const from = opts.since.getTime();
  const to = opts.now.getTime();

  // A per-core test alert: eight cores idling, one of them (Core 3) pinned for
  // the second half of the hour — a single-threaded process the all-cores line
  // barely registers, which is the whole point of the metric (rule 89).
  const cores = wanted.has("chart.cpu") && opts.perCore
    ? Array.from({ length: SAMPLE_CORE_COUNT }, (_, c) =>
        sampleWave(from, to, (f, i) =>
          c === SAMPLE_HOT_CORE && f > 0.5
            ? clamp(96 + 3 * Math.sin(i * 1.3), 0, 100)
            : clamp(18 + 7 * Math.sin(f * (3 + c) + c) + 4 * Math.sin(i * (0.7 + c * 0.13)), 0, 100)))
    : null;
  const cpu = !wanted.has("chart.cpu") ? []
    // The all-cores line is the mean of the invented cores, so the two agree.
    : cores ? cores[0]!.map((p, i) => ({ t: p.t, v: Math.round((cores.reduce((s, c) => s + c[i]!.v, 0) / cores.length) * 10) / 10 }))
    // A working day's drift, then a climb over the last fifth of the window —
    // the shape that makes a "CPU is above 80%" automation make sense.
    : sampleWave(from, to, (f, i) => clamp(34 + 9 * Math.sin(f * 6.1) + 4 * Math.sin(i * 1.7) + (f > 0.8 ? (f - 0.8) * 190 : 0), 0, 100));
  // In GB against a 16 GB host, like a real agent host's chart (memorySeriesFrom).
  const mem: MemorySeries = wanted.has("chart.memory")
    ? {
        points: sampleWave(from, to, (f, i) => clamp(9.8 + 0.6 * Math.sin(f * 3.3) + 0.25 * Math.sin(i * 0.9), 0, SAMPLE_MEM_TOTAL_GB)),
        unit: " GB",
        percent: false,
        total: SAMPLE_MEM_TOTAL_GB,
      }
    : EMPTY_MEMORY;
  const rt = wanted.has("chart.responseTime")
    ? sampleWave(from, to, (f, i) => Math.max(1, 9 + 3 * Math.sin(f * 5.2) + 1.4 * Math.sin(i * 2.1) + (f > 0.85 ? (f - 0.85) * 820 : 0)))
    : [];

  let loss: ProbeLossSeries = { points: [], ratioPct: null, engineRatioPct: null };
  if (wanted.has("chart.probeLoss")) {
    const lossFrom = opts.lossSince.getTime();
    const buckets = Math.max(1, Math.round((to - lossFrom) / opts.lossBucketMs));
    const points: SparkPoint[] = [];
    let lost = 0;
    let total = 0;
    for (let i = 0; i < buckets; i++) {
      // Quiet, then a burst in the last few buckets: one clean stretch and one
      // lossy one is the comparison the chart exists to draw.
      const pct = i >= buckets - 3 ? [12, 34, 21][i - (buckets - 3)] ?? 0 : 0;
      points.push({ t: lossFrom + i * opts.lossBucketMs, v: pct });
      total += 10;
      lost += Math.round(pct / 10);
    }
    const ratio = total > 0 ? Math.round((lost / total) * 1000) / 10 : null;
    loss = { points, ratioPct: ratio, engineRatioPct: ratio };
  }

  // The sensor reads in whatever unit the install displays — the chart beside
  // the sentence must not say °C while `sensorReadingDisplay` says °F.
  const sensor: SensorSeries = wanted.has("chart.sensor")
    ? {
        points: sampleWave(from, to, (f, i) => {
          const c = 46 + 6 * Math.sin(f * 4.1) + 2 * Math.sin(i * 1.3);
          return opts.displayUnit === "f" ? c * 1.8 + 32 : c;
        }),
        alarmSpans: [],
        unit: opts.displayUnit === "f" ? "°F" : "°C",
        sensorClass: "temperature",
      }
    : { points: [], alarmSpans: [], unit: "", sensorClass: null };

  const sdwan: SdwanSeries | null = SDWAN_CHART_TOKENS.some((t) => wanted.has(t))
    ? {
        healthCheck: SAMPLE_SDWAN_HEALTH_CHECK,
        link: SAMPLE_SDWAN_LINK,
        latency: sampleWave(from, to, (f, i) => Math.max(1, 64 + 11 * Math.sin(f * 4.7) + 5 * Math.sin(i * 1.9) + (f > 0.8 ? (f - 0.8) * 340 : 0))),
        jitter: sampleWave(from, to, (f, i) => Math.max(0, 8 + 4 * Math.sin(f * 7.3) + 2 * Math.sin(i * 2.4) + (f > 0.8 ? (f - 0.8) * 90 : 0))),
        loss: sampleWave(from, to, (f, i) => Math.max(0, 0.3 + 0.3 * Math.sin(i * 1.1) + (f > 0.85 ? (f - 0.85) * 40 : 0))),
        // The SLA lines the generated traces cross near the end, so the dashed
        // rule is doing its job in the specimen too.
        latencyThresholdMs: 120,
        jitterThresholdMs: 30,
        packetLossThreshold: 2,
        downSpans: [],
        downAtEnd: false,
      }
    : null;

  return { cpu, mem, rt, loss, sensor, sdwan, cores };
}

/**
 * Build the requested charts for one alert. `threshold` draws the automation's
 * own line on the chart of the metric it watches, when that metric is one of
 * these three.
 *
 * `assetId` is null only for a TEST alert, which is attached to no asset; that
 * call must pass `sampleData` and gets generated series instead of a query.
 */
export async function buildAlertCharts(
  assetId: string | null,
  tokens: Iterable<ChartToken>,
  opts?: {
    now?: Date;
    thresholds?: Partial<Record<ChartToken, number | null>>;
    /**
     * The hardware sensor this alert is about — `Notification.dimension`, which
     * for hwSensorValue AND hwSensorAlarm automations is the bare sensor name.
     * Absent (a whole-device alert, an interface alert, an event rule) means
     * the sensor chart is skipped entirely: no query, and the token renders
     * away rather than drawing an empty box.
     */
    sensorName?: string | null;
    /**
     * `Notification.dimension` verbatim — the same string `sensorName` carries,
     * under the name the SD-WAN charts read it by, since for them it is a
     * `"<healthCheck>|<link>"` pair or a service-rule name rather than a sensor.
     * Defaults to `sensorName` so an existing caller keeps working.
     */
    dimension?: string | null;
    /**
     * The metric the automation fired on (`Notification.metric`). Resolves the
     * `chart.trigger` alias so the graph that explains THIS alert leads the
     * email — a response-time automation shows response time first.
     */
    metric?: string | null;
    /**
     * The automation's probe-loss History window in ms — the loss chart covers
     * THIS span instead of the default last hour, so the graph shows exactly
     * the period the alert's ratio was measured over (resolved from the rule's
     * trigger via `probeLossWindowSecFromTrigger`). Absent/null (no loss
     * condition on the rule, a deleted rule, a test alert) keeps the hour.
     * Only the loss chart follows it: CPU / memory / response time stay
     * last-hour context regardless.
     */
    lossWindowMs?: number | null;
    /**
     * Draw INVENTED series instead of reading the database — the automation
     * wizard's test buttons, whose alert is about a made-up device
     * (`utils/sampleAlertDevice`) and so has no telemetry to read and none it
     * ought to borrow. Every other caller leaves this unset.
     */
    sampleData?: boolean;
    /**
     * The automation's own threshold, from its trigger (notificationDelivery-
     * Service resolves it per rule). Only the storage chart reads it: on a
     * used-% / used-bytes alert it is the dashed line, and on a days-until-full
     * alert it is the forecast's HORIZON in days — how far forward the trend is
     * drawn. Absent/null (a deleted rule, a composite trigger, a test alert
     * without one) draws no line and picks a horizon from the forecast itself.
     */
    ruleThreshold?: number | null;
  },
): Promise<Map<ChartToken, RenderedChart>> {
  // Resolve the alias up front: from here on it's an ordinary token request,
  // and the alias entry is filled in at the end from whatever it points at.
  const primary = chartTokenForMetric(opts?.metric);
  const aliasWanted = new Set(tokens).has("chart.trigger");
  const out = new Map<ChartToken, RenderedChart>();
  const interfaceScoped = isPortScopedAlert(opts?.metric);
  const wanPort = interfaceScoped ? (opts?.dimension ?? opts?.sensorName ?? null) : null;
  const mountPath = isStorageScopedAlert(opts?.metric) ? (opts?.dimension ?? opts?.sensorName ?? null) : null;
  const wanted = chartTokensForAlert(tokens, opts?.metric, {
    // A test alert (sampleData) has an invented device, so whether its port is
    // a WAN member is not a question with an answer.
    port: !!assetId && !opts?.sampleData && !!wanPort,
    sensor: !!opts?.sensorName,
    mount: !!mountPath,
  });
  if (wanted.size === 0) return out;

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - CHART_WINDOW_MS);
  // The loss chart's window is the automation's History when the caller could
  // resolve one — the chart then shows exactly the period the ratio that fired
  // was measured over. Every other chart keeps the last-hour context window.
  const lossWindowMs = opts?.lossWindowMs && opts.lossWindowMs > 0 ? opts.lossWindowMs : CHART_WINDOW_MS;
  const lossSince = new Date(now.getTime() - lossWindowMs);

  // The storage chart is built on its own: it has its own window (a day, or a
  // month of daily points plus a horizon) and its own spec, and on a storage
  // alert it is the ONLY chart, so there is nothing to run it alongside.
  let storage: StorageChartSpec | null = null;
  if (wanted.has("chart.storage") && mountPath) {
    const metric = opts!.metric!;
    const threshold = opts?.ruleThreshold ?? null;
    if (opts?.sampleData) {
      storage = sampleStorageSpec(metric, mountPath, threshold, now.getTime());
    } else if (assetId) {
      try {
        storage = metric === "storageDaysUntilFull"
          ? storageForecastSpec(await loadStorageForecastSeries(assetId, mountPath), { mountPath, horizonDays: threshold, now: now.getTime() })
          : storageUsageSpec(await loadStorageUsage(assetId, mountPath, new Date(now.getTime() - STORAGE_USAGE_WINDOW_MS)), {
              metric, mountPath, threshold, now: now.getTime(),
            });
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, assetId, mountPath }, "alert storage chart load failed — sending without it");
      }
    }
  }

  let cpu: SparkPoint[] = [];
  let mem: MemorySeries = EMPTY_MEMORY;
  let rt: SparkPoint[] = [];
  let loss: ProbeLossSeries = { points: [], ratioPct: null, engineRatioPct: null };
  let sensor: SensorSeries = { points: [], alarmSpans: [], unit: "", sensorClass: null };
  let fail: FailSpanSeries = { spans: [], recoverySpans: [], failedCount: 0 };
  let sdwan: SdwanSeries | null = null;
  // A per-core alert (rule 89) draws every core under the all-cores line; every
  // other alert keeps the all-cores line alone. Null = draw the plain chart,
  // including on a per-core alert whose window carries no core vectors.
  const perCore = opts?.metric === "cpuCorePct" && wanted.has("chart.cpu");
  let cores: SparkPoint[][] | null = null;
  if (opts?.sampleData) {
    // The display unit is still read for real: the generated sensor trace and
    // the sentence above it in the email have to agree about °C vs °F.
    const displayUnit = wanted.has("chart.sensor")
      ? await getBranding().then((b) => b.temperatureUnit).catch(() => "c" as const)
      : ("c" as const);
    const s = sampleChartSeries(wanted, {
      since, now, lossSince, lossBucketMs: lossBucketMs(lossWindowMs), displayUnit, perCore,
    });
    cpu = s.cpu; mem = s.mem; rt = s.rt; loss = s.loss; sensor = s.sensor; sdwan = s.sdwan; cores = s.cores;
  } else if (!assetId) {
    // No asset and no sample mode: nothing to chart, and nothing to query for.
    return out;
  } else {
    try {
      const needTelemetry = wanted.has("chart.cpu") || wanted.has("chart.memory");
      const needFailSpans = [...wanted].some((t) => FAIL_SPAN_TOKENS.has(t));
      const needSdwan = SDWAN_CHART_TOKENS.some((t) => wanted.has(t));
      // The display unit is install-wide branding, not per-user: an alert email
      // has no session behind it. Read once, only when a sensor is charted.
      const displayUnit = wanted.has("chart.sensor")
        ? await getBranding().then((b) => b.temperatureUnit).catch(() => "c" as const)
        : ("c" as const);
      const [tel, rtRows, sensorRows, lossRows, failRows, sdwanRows] = await Promise.all([
        needTelemetry ? loadTelemetry(assetId, since, perCore) : Promise.resolve({ cpu: [], mem: EMPTY_MEMORY, cores: null }),
        wanted.has("chart.responseTime") ? loadResponseTimes(assetId, since) : Promise.resolve([]),
        wanted.has("chart.sensor")
          ? loadSensorSeries(assetId, opts!.sensorName!, since, displayUnit)
          : Promise.resolve(sensor),
        wanted.has("chart.probeLoss") ? loadProbeLoss(assetId, lossSince, lossBucketMs(lossWindowMs)) : Promise.resolve(loss),
        needFailSpans ? loadFailSpans(assetId, since, now) : Promise.resolve(fail),
        // Two reads at most, and only for a path alert: the rule → health-check
        // lookup, then the health check's samples. An unresolvable path (a rule
        // with no performance SLA, a dimension from before the metric existed)
        // yields null and every SD-WAN token renders away.
        // An interface alert takes the one-read member path instead: the port
        // name is the member, and the health checks are whatever probed it.
        needSdwan
          ? interfaceScoped
            ? loadWanMemberSeries(assetId, wanPort!, since)
            : resolveSdwanTarget(assetId, opts?.metric, opts?.dimension ?? opts?.sensorName ?? null)
                .then((target) => (target ? loadSdwanSeries(assetId, target, since) : null))
          : Promise.resolve(null),
      ]);
      cpu = tel.cpu;
      mem = tel.mem;
      cores = tel.cores;
      rt = rtRows;
      sensor = sensorRows;
      loss = lossRows;
      fail = failRows;
      sdwan = sdwanRows;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, assetId }, "alert chart sample load failed — sending without charts");
    }
  }
  // An interface alert on a port that is not an SD-WAN member: nothing probed
  // through it, so there is no picture of the link, and three "no data" boxes
  // under "port7 is down" would read as Polaris failing to chart rather than as
  // "nothing applies". Empty map, same as the early return above.
  if (interfaceScoped && sdwan === null) return out;

  const series: Record<ChartToken, SparkPoint[]> = {
    // The alias never renders from here — it was resolved to a real token
    // above and is filled in from that token's result at the end.
    "chart.trigger": [],
    "chart.sensor": sensor.points,
    "chart.probeLoss": loss.points,
    "chart.sdwanLatency": sdwan?.latency ?? [],
    "chart.sdwanJitter": sdwan?.jitter ?? [],
    "chart.sdwanLoss": sdwan?.loss ?? [],
    "chart.cpu": cpu,
    "chart.memory": mem.points,
    "chart.responseTime": rt,
    // Rendered from its own spec above; never read from here.
    "chart.storage": [],
  };

  /** The health check's own SLA target for a chart, when it configures one. */
  const slaThresholdFor = (token: ChartToken): number | null =>
    token === "chart.sdwanLatency" ? sdwan?.latencyThresholdMs ?? null
    : token === "chart.sdwanJitter" ? sdwan?.jitterThresholdMs ?? null
    : token === "chart.sdwanLoss" ? sdwan?.packetLossThreshold ?? null
    : null;

  // The health check's down verdict, banded to the right edge while it still
  // holds. A trailing span otherwise ends on the last sample — close enough on
  // a chart with a line, but on a dead member's chart the band IS the chart.
  const sdwanDownSpans = !sdwan ? []
    : sdwan.downAtEnd
      ? sdwan.downSpans.map((s, i, all) => (i === all.length - 1 ? { from: s.from, to: now.getTime() } : s))
      : sdwan.downSpans;

  for (const token of wanted) {
    // The storage chart carries its own spec — label, unit, axis, window,
    // caption and summary are all decided there. A mount that could not be
    // read renders away rather than drawing an empty box.
    if (token === "chart.storage") {
      if (storage) out.set(token, await renderStorageChart(storage, META[token].color));
      continue;
    }
    const meta = META[token];
    const points = series[token] ?? [];
    // The sensor chart labels itself from the sensor: its name (which is what
    // the operator picked in the automation) and the unit the device reported,
    // after the display-unit swap.
    const isSensor = token === "chart.sensor";
    const isLoss = token === "chart.probeLoss";
    // An SD-WAN chart names its PATH, not just its metric: on a gate with four
    // WAN members "SD-WAN latency" alone doesn't say which link degraded, and
    // the pair drawn may not even be the one the alert named (see
    // sdwanSeriesFrom's fallback), so the label has to state what was charted.
    const isSdwan = sdwan !== null && SDWAN_CHART_TOKENS.includes(token);
    // The per-core chart (rule 89): every core thin behind the all-cores line,
    // and the caption leads with the busiest core, because on a per-core alert
    // that core — not the all-cores average — is what crossed the line.
    const coreLines = token === "chart.cpu" && cores ? cores : null;
    const hotCore = coreLines ? busiestCore(coreLines) : null;
    const label = isSensor ? opts!.sensorName!
      : isSdwan ? sdwanChartLabel(meta.label, sdwan!.healthCheck, sdwan!.link)
      : coreLines ? "CPU per core"
      : meta.label;
    // Memory charts in the unit its series came in (memorySeriesFrom): bytes
    // against installed memory when the device reports them, else 0–100%.
    const isMemory = token === "chart.memory";
    const unit = isSensor ? (sensor.unit ? ` ${sensor.unit}` : "") : isMemory ? mem.unit : meta.unit;
    const memAxis = isMemory && !mem.percent && mem.total != null
      ? { yMin: 0, yMax: mem.total, ceiling: mem.total }
      : null;
    // The loss chart's caption quotes the window's PROBE ratio, not the mean of
    // its buckets, which weights unequal buckets wrongly. It counts every probe
    // in the window — the misses taken while the device was `warning` or `down`
    // included — so on a device that was down inside the window it reads HIGHER
    // than the value the automation fired on (business rule 29h applies to the
    // metric, not to the picture). `loss.engineRatioPct` is that other number.
    // See probeLossSeriesFrom.
    const avgOverride = isLoss ? loss.ratioPct : null;
    const withFailSpans = FAIL_SPAN_TOKENS.has(token) && fail.spans.length > 0;
    const withRecoverSpans = RECOVER_SPAN_TOKENS.has(token) && fail.recoverySpans.length > 0;
    const svg = sparklineSvg(points, {
      label,
      unit,
      color: coreLines ? CPU_ALL_CORES_COLOR : meta.color,
      ...(coreLines ? {
        backgroundSeries: coreLines.map((p, i) => ({
          points: p,
          // The busiest core takes the DARKER of the arc's two lightness steps,
          // so it holds up as the emphasised line whichever core it is.
          color: cpuCoreColor(i, coreLines.length, i === hotCore?.index),
          strong: i === hotCore?.index,
        })),
        ...(hotCore ? { caption: perCoreCaption(hotCore, points) } : {}),
      } : {}),
      ...(memAxis ?? (meta.percent ? { yMin: 0, yMax: 100 } : {})),
      // An explicit threshold from the caller still wins; the SD-WAN charts are
      // the only ones that carry a line of their own, the FortiGate's own SLA
      // target for that health check.
      threshold: opts?.thresholds?.[token] ?? slaThresholdFor(token),
      ...(isSensor && sensor.alarmSpans.length ? { alarmSpans: sensor.alarmSpans } : {}),
      // The stretches the health check called this member DOWN, banded like a
      // sensor's own alarm and for the same reason: it is the DEVICE's verdict
      // about a reading, not Polaris's, and on a failover email it is usually
      // the answer — the member the rule left was declared dead here.
      ...(isSdwan && sdwanDownSpans.length ? { alarmSpans: sdwanDownSpans } : {}),
      // FortiOS reports no latency / jitter / loss for a member it has declared
      // dead, so an outage older than the window leaves the line empty — the
      // band is drawn anyway, with this in the middle of it.
      ...(isSdwan ? { emptyNote: "no readings — the health check reported this member down" } : {}),
      ...(withFailSpans ? { failSpans: fail.spans } : {}),
      // The severity colour for the "outage" kind only — "missed" stays amber
      // (not a verdict yet) and "dependency" stays grey (not this device's
      // fault). Absent ⇒ the red sparklineSvg has always used.
      ...(withFailSpans && fail.downColor ? { downColor: fail.downColor } : {}),
      ...(withRecoverSpans ? { recoverSpans: fail.recoverySpans } : {}),
      from: (isLoss ? lossSince : since).getTime(),
      to: now.getTime(),
      avgOverride,
    });
    // A dead SD-WAN member's chart counts as drawn with no points at all: the
    // down band is the picture (see the emptyNote above), and dropping it is how
    // a "WAN is down" email used to arrive with no graphs whenever the member
    // had been dead for longer than the window.
    const sdwanDownOnly = isSdwan && points.length === 0 && sdwanDownSpans.length > 0;
    const drawn = points.length > 0 || sdwanDownOnly;
    const png = drawn ? await rasterize(svg) : null;
    const cid = `polaris-${token.replace(".", "-")}@polaris`;
    out.set(token, {
      token,
      cid,
      hasData: drawn,
      summary: sdwanDownOnly
        ? `${label} (last hour): no readings — the health check reported this member down`
        : (hotCore && points.length
          ? perCoreSummary(hotCore, coreLines!.length, points)
          : summaryLine(label, unit, points, isLoss ? lossWindowMs : CHART_WINDOW_MS, avgOverride)) +
        // "12.4 GB" says little without what the host has — the axis top on the
        // image, spelled out for a reader with images blocked.
        (memAxis && points.length ? ` (${formatReading(memAxis.yMax, unit)} installed)` : "") +
        // An alarm-triggered alert charts the VALUE; the bit itself is what the
        // automation fired on, so the text has to carry it too — image blocking
        // is on by default in plenty of clients.
        (isSensor && sensor.alarmSpans.length ? " — the device raised its own alarm during this window" : "") +
        // Same reason, for the SD-WAN band: with images blocked the band is
        // invisible, and "the member was down" is the whole finding.
        (isSdwan && sdwan!.downSpans.length ? " — the health check reported this member down during this window" : "") +
        // Same reason: the red bands are the only thing saying the flat stretch
        // is missing data rather than a steady reading, so a text reader needs
        // the count.
        (withFailSpans ? ` — ${fail.failedCount} poll${fail.failedCount === 1 ? "" : "s"} failed during this window` : "") +
        // The caption and the line now cover the SAME window (the first-success
        // anchor is gone), so there is no longer a shorter measured span to
        // explain in text for a reader with images blocked.
        "",
      attachment: png
        ? { cid, filename: `${token.replace(".", "-")}.png`, contentType: "image/png", content: png }
        : null,
    });
  }
  // The alias points at the primary chart's rendering — same cid, so the body
  // references one attachment however many times it mentions the chart.
  if (aliasWanted && primary && out.has(primary)) {
    out.set("chart.trigger", { ...out.get(primary)!, token: "chart.trigger" });
  }
  return out;
}

/** Which chart tokens does this body actually reference? */
export function chartTokensIn(...templates: Array<string | null | undefined>): Set<ChartToken> {
  const found = new Set<ChartToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of CHART_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

/**
 * Replace `{chart.*}` with an inline <img> (HTML) or the summary line (text).
 * A chart with no data — or one whose PNG failed to render — degrades to the
 * same summary line in both, because a missing image reads to the recipient
 * as "my client blocked something", not "the device reported nothing".
 */
export function substituteChartTokens(
  body: string,
  charts: Map<ChartToken, RenderedChart>,
  opts: { html: boolean },
): string {
  let out = body;
  // Whatever the alias already drew must not be drawn again when its own token
  // comes up — the default body lists {chart.trigger} first AND every specific
  // chart after it, so without this a response-time alert would show the same
  // graph twice.
  const emittedCids = new Set<string>();
  for (const token of CHART_TOKENS) {
    const re = new RegExp(`\\{${token.replace(".", "\\.")}\\}`, "g");
    const chart = charts.get(token);
    if (chart && emittedCids.has(chart.cid)) {
      out = out.replace(re, "");
      continue;
    }
    // Nothing built for this token, or the metric produced no samples at all:
    // drop it. "Memory (last hour): no data" three times over is noise in an
    // alert about a firewall's temperature sensor — the device simply doesn't
    // report those, and the asset page is where you go to ask why.
    //
    // NOT the same case as a chart that HAS data but whose PNG failed to
    // rasterize: that one still prints its numbers below, because a missing
    // image reads to the recipient as "my client blocked something".
    if (!chart || !chart.hasData) {
      out = out.replace(re, "");
      continue;
    }
    emittedCids.add(chart.cid);
    if (!opts.html) {
      out = out.replace(re, chart.summary);
      continue;
    }
    const replacement = chart.attachment
      ? `<img src="cid:${chart.cid}" width="520" alt="${escapeAttr(chart.summary)}" ` +
        `style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e5e7eb;border-radius:6px;margin:10px 0">`
      : `<p style="margin:8px 0;color:#6b7280;font-size:13px">${escapeAttr(chart.summary)}</p>`;
    out = out.replace(re, replacement);
  }
  return out;
}

function escapeAttr(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The attachments the substituted HTML actually references. */
export function attachmentsFor(charts: Map<ChartToken, RenderedChart>, body: string): InlineAttachment[] {
  const out: InlineAttachment[] = [];
  for (const chart of charts.values()) {
    if (chart.attachment && body.includes(`cid:${chart.cid}`)) out.push(chart.attachment);
  }
  return out;
}
