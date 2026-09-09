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
export const CHART_TOKENS = ["chart.trigger", "chart.sensor", "chart.probeLoss", "chart.cpu", "chart.memory", "chart.responseTime"] as const;
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
    default:
      // Storage, interface counters, SD-WAN … have no chart of their own yet,
      // so the trigger token renders away and the generic charts below it
      // still tell the device's story.
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
  try {
    const needTelemetry = wanted.has("chart.cpu") || wanted.has("chart.memory");
    const needFailSpans = [...wanted].some((t) => FAIL_SPAN_TOKENS.has(t));
    // The display unit is install-wide branding, not per-user: an alert email
    // has no session behind it. Read once, only when a sensor is charted.
    const displayUnit = wanted.has("chart.sensor")
      ? await getBranding().then((b) => b.temperatureUnit).catch(() => "c" as const)
      : ("c" as const);
    const [tel, rtRows, sensorRows, lossRows, failRows] = await Promise.all([
      needTelemetry ? loadTelemetry(assetId, since) : Promise.resolve({ cpu: [], mem: [] }),
      wanted.has("chart.responseTime") ? loadResponseTimes(assetId, since) : Promise.resolve([]),
      wanted.has("chart.sensor")
        ? loadSensorSeries(assetId, opts!.sensorName!, since, displayUnit)
        : Promise.resolve(sensor),
      wanted.has("chart.probeLoss") ? loadProbeLoss(assetId, lossSince, lossBucketMs(lossWindowMs)) : Promise.resolve(loss),
      needFailSpans ? loadFailSpans(assetId, since, now) : Promise.resolve(fail),
    ]);
    cpu = tel.cpu;
    mem = tel.mem;
    rt = rtRows;
    sensor = sensorRows;
    loss = lossRows;
    fail = failRows;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId }, "alert chart sample load failed — sending without charts");
  }

  const series: Record<ChartToken, SparkPoint[]> = {
    // The alias never renders from here — it was resolved to a real token
    // above and is filled in from that token's result at the end.
    "chart.trigger": [],
    "chart.sensor": sensor.points,
    "chart.probeLoss": loss.points,
    "chart.cpu": cpu,
    "chart.memory": mem,
    "chart.responseTime": rt,
  };

  for (const token of wanted) {
    const meta = META[token];
    const points = series[token] ?? [];
    // The sensor chart labels itself from the sensor: its name (which is what
    // the operator picked in the automation) and the unit the device reported,
    // after the display-unit swap.
    const isSensor = token === "chart.sensor";
    const isLoss = token === "chart.probeLoss";
    const label = isSensor ? opts!.sensorName! : meta.label;
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
      threshold: opts?.thresholds?.[token] ?? null,
      ...(isSensor && sensor.alarmSpans.length ? { alarmSpans: sensor.alarmSpans } : {}),
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
