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
import { getBranding } from "./brandingService.js";
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
] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/** The metric an automation triggers on → the chart that explains it. */
export function chartTokenForMetric(metric: string | null | undefined): ChartToken | null {
  switch (metric) {
    case "hwSensorValue":
    case "hwSensorAlarm":
      return "chart.sensor";
    case "cpuPct":
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
    case "sdwanRuleStatus":
    case "sdwanSelectedMember":
      return "chart.sdwanLatency";
    default:
      // Storage and interface counters have no chart of their own yet, so the
      // trigger token renders away and the generic charts below it still tell
      // the device's story.
      return null;
  }
}

/**
 * Metrics whose alert is about ONE PORT, not the device — and which therefore
 * get NO charts at all.
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
 * device's own load, so an `ifInErrorRate` alert keeps its graphs.
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
 * BOTH the metric triggers and the two state fields are here. A failover
 * (`sdwanSelectedMember`) or a rule going down (`sdwanRuleStatus`) is a
 * statement about the paths under that service rule, and the SLA metrics of the
 * health check it selects on are what say why it moved.
 */
const SDWAN_SCOPED_METRICS: ReadonlySet<string> = new Set([
  "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss", "sdwanRuleStatus", "sdwanSelectedMember",
]);

export function isSdwanScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && SDWAN_SCOPED_METRICS.has(metric);
}

/** The SD-WAN health-check charts. The default body asks for all three, so a
 *  failover email shows every side of the SLA rather than whichever one the
 *  automation happened to watch; they all read one loaded `SdwanSeries`. */
const SDWAN_CHART_TOKENS: readonly ChartToken[] = ["chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss"];

/** The device-story charts an SD-WAN alert replaces. */
const DEVICE_CHART_TOKENS: readonly ChartToken[] = ["chart.cpu", "chart.memory", "chart.responseTime", "chart.probeLoss"];

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
};

/** Even-ish downsample that always keeps the newest point (the alerting one). */
function thin(points: SparkPoint[]): SparkPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const step = Math.ceil(points.length / MAX_POINTS);
  const out: SparkPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

async function loadTelemetry(assetId: string, since: Date): Promise<{ cpu: SparkPoint[]; mem: SparkPoint[] }> {
  const rows = await prisma.assetTelemetrySample.findMany({
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, cpuPct: true, memPct: true, memUsedBytes: true, memTotalBytes: true },
  });
  const cpu: SparkPoint[] = [];
  const mem: SparkPoint[] = [];
  for (const r of rows) {
    const t = r.timestamp.getTime();
    if (r.cpuPct != null) cpu.push({ t, v: r.cpuPct });
    // FortiOS reports a percentage; SNMP HOST-RESOURCES / WMI report bytes.
    // Same COALESCE the dashboard's memory widget uses.
    if (r.memPct != null) {
      mem.push({ t, v: r.memPct });
    } else if (r.memUsedBytes != null && r.memTotalBytes != null && Number(r.memTotalBytes) > 0) {
      mem.push({ t, v: (Number(r.memUsedBytes) / Number(r.memTotalBytes)) * 100 });
    }
  }
  return { cpu: thin(cpu), mem: thin(mem) };
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
   * failed / total over the window — the same quantity the engine's
   * `probeLossPct` metric reports, made of the same probes (rows stamped
   * `assetDown` are out of both), so the caption states the number the alert
   * fired on. Null when the window held no countable probes at all.
   */
  ratioPct: number | null;
}

/**
 * Probe loss over time, as both a bucketed line and the window's own ratio.
 *
 * Pure so the arithmetic that has to agree with the engine can be tested
 * without a database. `rows` must be ascending by timestamp.
 *
 * TWO ratios come out of this, and conflating them is what made an alert read
 * "18.3 %" over a chart captioned "avg 6.7 %": the per-bucket values are the
 * line's shape, while `ratioPct` weighs every probe equally across the window.
 * A 4-minute burst of total loss among 30 quiet 2-minute buckets is 2/30 ≈
 * 6.7 % of BUCKETS but ~18 % of PROBES — and it is the probe ratio the
 * automation compares to its threshold, so that is what the caption prints.
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
 * IT STEPS OVER THE SAME OUTAGE THE QUERY DOES (business rule 29h), by the same
 * rule: a maximal run of consecutive failures containing any row stamped
 * `assetDown` is an outage entire — ONSET INCLUDED — and its failures are not
 * loss. `outageRunFailures` below is the JS mirror of the query's `runId` /
 * `runOutage` window functions, and it must stay one: the two are what make the
 * caption and the engine's reading the same number.
 *
 * Dropped from BOTH halves of this, the line and the caption. Dropping it from
 * only one is the failure this chart exists to avoid — an alert reading 0.0 %
 * over a chart captioned "avg 40 %" tells an operator the number is made up.
 * The stretch leaves a GAP in the line rather than a zero, which is the same
 * treatment an unpolled stretch already gets: nothing was measured about this
 * link while the device was dark, and drawing 0 % there would claim it was
 * perfect at the one moment it was unreachable. A window that was ENTIRELY one
 * outage therefore draws nothing and captions null, and `pruneEmptyChartSection`
 * removes it — which is right: an empty chart is not a claim, where a flat 0 %
 * line under an alert about an outage would be.
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
 * The JS mirror of `probeLossQuery`'s `runId` / `runOutage` window functions,
 * and the reason the chart's caption and the engine's reading are the same
 * number (business rule 29h). `assetDown` is only stampable from the probe that
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
  const skip = outageRunFailures(rows);
  let sent = 0;
  let recv = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    // The failures of a run that reached DOWN are the outage, not the link
    // (business rule 29h). Skipped entirely rather than counted as received,
    // so they leave a gap in the line instead of a stretch of implausible 0 %.
    if (skip.has(i)) continue;
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
  }
  const points = thin(
    Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({ t, v: Math.round(((b.sent - b.recv) / b.sent) * 1000) / 10 })),
  );
  return {
    points,
    ratioPct: sent ? Math.round(((sent - recv) / sent) * 1000) / 10 : null,
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
    // exists to give it resolution. One of only two all-kinds readers (with
    // probeLossQuery); everything else is response-time-poll only.
    where: { assetId, timestamp: { gte: since } },
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, success: true, packetsSent: true, packetsReceived: true, assetDown: true },
  });
  return probeLossSeriesFrom(rows, bucketMs);
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

/**
 * Build the requested charts for one alert. `threshold` draws the automation's
 * own line on the chart of the metric it watches, when that metric is one of
 * these three.
 */
export async function buildAlertCharts(
  assetId: string,
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
  },
): Promise<Map<ChartToken, RenderedChart>> {
  const wanted = new Set(tokens);
  // Resolve the alias up front: from here on it's an ordinary token request,
  // and the alias entry is filled in at the end from whatever it points at.
  const primary = chartTokenForMetric(opts?.metric);
  const aliasWanted = wanted.delete("chart.trigger");
  if (aliasWanted && primary) wanted.add(primary);
  const out = new Map<ChartToken, RenderedChart>();
  // An alert about one port draws nothing — see PORT_SCOPED_METRICS. Returning
  // the empty map (rather than filtering the token list) is what makes every
  // chart token render away and `pruneEmptyChartSection` drop the "Last hour"
  // heading with them, and it skips all four sample queries.
  if (isPortScopedAlert(opts?.metric)) return out;
  // A sensor chart with no sensor has nothing to draw. Dropping it here (rather
  // than rendering "no data") is what keeps the token invisible on the ~all
  // alerts that aren't about a hardware sensor.
  if (!opts?.sensorName) wanted.delete("chart.sensor");
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
  const sdwanScoped = isSdwanScopedAlert(opts?.metric);
  for (const t of sdwanScoped ? DEVICE_CHART_TOKENS : SDWAN_CHART_TOKENS) wanted.delete(t);
  if (wanted.size === 0) return out;

  const now = opts?.now ?? new Date();
  const since = new Date(now.getTime() - CHART_WINDOW_MS);
  // The loss chart's window is the automation's History when the caller could
  // resolve one — the chart then shows exactly the period the ratio that fired
  // was measured over. Every other chart keeps the last-hour context window.
  const lossWindowMs = opts?.lossWindowMs && opts.lossWindowMs > 0 ? opts.lossWindowMs : CHART_WINDOW_MS;
  const lossSince = new Date(now.getTime() - lossWindowMs);

  let cpu: SparkPoint[] = [];
  let mem: SparkPoint[] = [];
  let rt: SparkPoint[] = [];
  let loss: ProbeLossSeries = { points: [], ratioPct: null };
  let sensor: SensorSeries = { points: [], alarmSpans: [], unit: "", sensorClass: null };
  let fail: FailSpanSeries = { spans: [], recoverySpans: [], failedCount: 0 };
  let sdwan: SdwanSeries | null = null;
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
      needTelemetry ? loadTelemetry(assetId, since) : Promise.resolve({ cpu: [], mem: [] }),
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
      needSdwan
        ? resolveSdwanTarget(assetId, opts?.metric, opts?.dimension ?? opts?.sensorName ?? null)
            .then((target) => (target ? loadSdwanSeries(assetId, target, since) : null))
        : Promise.resolve(null),
    ]);
    cpu = tel.cpu;
    mem = tel.mem;
    rt = rtRows;
    sensor = sensorRows;
    loss = lossRows;
    fail = failRows;
    sdwan = sdwanRows;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId }, "alert chart sample load failed — sending without charts");
  }

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
    "chart.memory": mem,
    "chart.responseTime": rt,
  };

  /** The health check's own SLA target for a chart, when it configures one. */
  const slaThresholdFor = (token: ChartToken): number | null =>
    token === "chart.sdwanLatency" ? sdwan?.latencyThresholdMs ?? null
    : token === "chart.sdwanJitter" ? sdwan?.jitterThresholdMs ?? null
    : token === "chart.sdwanLoss" ? sdwan?.packetLossThreshold ?? null
    : null;

  for (const token of wanted) {
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
    const label = isSensor ? opts!.sensorName!
      : isSdwan ? sdwanChartLabel(meta.label, sdwan!.healthCheck, sdwan!.link)
      : meta.label;
    const unit = isSensor ? (sensor.unit ? ` ${sensor.unit}` : "") : meta.unit;
    // The loss chart's caption quotes the window's PROBE ratio, not the mean of
    // its buckets — the number the automation actually fired on. See
    // probeLossSeriesFrom.
    const avgOverride = isLoss ? loss.ratioPct : null;
    const withFailSpans = FAIL_SPAN_TOKENS.has(token) && fail.spans.length > 0;
    const withRecoverSpans = RECOVER_SPAN_TOKENS.has(token) && fail.recoverySpans.length > 0;
    const svg = sparklineSvg(points, {
      label,
      unit,
      color: meta.color,
      ...(meta.percent ? { yMin: 0, yMax: 100 } : {}),
      // An explicit threshold from the caller still wins; the SD-WAN charts are
      // the only ones that carry a line of their own, the FortiGate's own SLA
      // target for that health check.
      threshold: opts?.thresholds?.[token] ?? slaThresholdFor(token),
      ...(isSensor && sensor.alarmSpans.length ? { alarmSpans: sensor.alarmSpans } : {}),
      // The stretches the health check called this member DOWN, banded like a
      // sensor's own alarm and for the same reason: it is the DEVICE's verdict
      // about a reading, not Polaris's, and on a failover email it is usually
      // the answer — the member the rule left was declared dead here.
      ...(isSdwan && sdwan!.downSpans.length ? { alarmSpans: sdwan!.downSpans } : {}),
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
    const png = points.length > 0 ? await rasterize(svg) : null;
    const cid = `polaris-${token.replace(".", "-")}@polaris`;
    out.set(token, {
      token,
      cid,
      hasData: points.length > 0,
      summary: summaryLine(label, unit, points, isLoss ? lossWindowMs : CHART_WINDOW_MS, avgOverride) +
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
