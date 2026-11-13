/**
 * src/services/alertWidgetChartService.ts — the chart a custom-widget alert
 * leads with in its email (business rule 180, from the approved design canvas):
 *
 *  - `customWidgetValue` / `customWidgetLevel`: the widget's last hour as a
 *    line in the widget's own name and unit. A value alert draws the threshold
 *    that fired — the automation's, or the severity band the alert is at — in
 *    that severity's colour; a level alert draws the widget's own warning and
 *    critical levels, amber and red, each named in the legend.
 *  - `customStateValue`: the state probe's row as one status lane — the OK
 *    label faint green, the problem label solid red — captioned with how long
 *    it spent on the problem side and what it reads now.
 *
 * No sample in the window → no chart (null): an empty box under "Bank 2
 * Current is in critical state" reads as Polaris failing to chart. The
 * renderers return SVG; alertChartService rasterises it beside its own charts.
 */

import { prisma } from "../db.js";
import { sparklineSvg, statusStripSvg, seriesStats, formatReading, type SparkPoint } from "../utils/sparklineSvg.js";
import { severityCss } from "../utils/severityStyle.js";
import { normalizeStateMap } from "../utils/stateProbes.js";
import type { SeverityBand } from "./notificationTypes.js";

/** The three custom-widget metrics whose alert leads with the widget's chart. */
const WIDGET_SCOPED_METRICS: ReadonlySet<string> = new Set(["customWidgetValue", "customWidgetLevel", "customStateValue"]);

export function isWidgetScopedAlert(metric: string | null | undefined): boolean {
  return !!metric && WIDGET_SCOPED_METRICS.has(metric);
}

/** The value series is the email's orange — the colour the approved canvas drew it in. */
const WIDGET_SERIES_COLOR = "#ea580c";

/** The threshold a `customWidgetValue` alert fired on, and the severity it is at. */
export interface WidgetChartThreshold {
  value: number;
  severity: string;
}

/**
 * The line a value alert's chart draws: the severity band the alert is AT, or
 * the trigger's own threshold when the alert is at the rule's base severity (or
 * no band matches). Null when the rule is not a plain `customWidgetValue`
 * condition. Pure.
 */
export function widgetChartThresholdFromRule(
  rule: { trigger: unknown; severity: string; severityBands: SeverityBand[] | null | undefined },
  severity: string,
): WidgetChartThreshold | null {
  const t = rule.trigger as { type?: unknown; metric?: unknown; threshold?: unknown } | null;
  if (!t || t.type !== "asset_metric" || t.metric !== "customWidgetValue") return null;
  const band = (rule.severityBands ?? []).find((b) => b.severity === severity && Number.isFinite(b.threshold));
  if (band && severity !== rule.severity) return { value: band.threshold, severity };
  return typeof t.threshold === "number" && Number.isFinite(t.threshold) ? { value: t.threshold, severity: rule.severity } : null;
}

export interface WidgetChart {
  svg: string;
  /** The text-body line and the <img> alt text. */
  summary: string;
}

const MAX_POINTS = 240;

function thin(points: SparkPoint[]): SparkPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const step = points.length / MAX_POINTS;
  const out: SparkPoint[] = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A test alert's widget series: steady, then a climb past the line. */
function sampleWidgetSeries(from: number, to: number, line: number | null): SparkPoint[] {
  const base = line != null && line > 0 ? line * 0.75 : 10;
  const peak = line != null && line > 0 ? line * 1.08 : 14;
  const out: SparkPoint[] = [];
  for (let i = 0; i <= 60; i++) {
    const f = i / 60;
    out.push({ t: from + f * (to - from), v: f < 0.8 ? base + Math.sin(i * 0.7) * base * 0.03 : base + ((f - 0.8) / 0.2) * (peak - base) });
  }
  return out;
}

/**
 * The widget's line chart, or null when the window held no reading.
 * `dimension` is `Notification.dimension` — the widget id for both metrics.
 */
export async function buildWidgetValueChart(
  assetId: string | null,
  o: { metric: string; dimension: string | null; from: number; to: number; threshold?: WidgetChartThreshold | null; sampleData?: boolean },
): Promise<WidgetChart | null> {
  if (!o.dimension) return null;
  const { listCustomWidgetCatalog } = await import("./notificationDimensionService.js");
  const entry = (await listCustomWidgetCatalog()).find((w) => w.id === o.dimension) ?? null;
  const name = entry?.name ?? "Custom widget";
  const unit = entry?.unit ? ` ${entry.unit}` : "";

  // The dashed lines: the widget's own levels on a level alert, the fired
  // threshold on a value alert.
  const levels: Array<{ value: number; color: string; legend: string }> = [];
  if (o.metric === "customWidgetLevel" && entry?.levels) {
    if (entry.levels.warningAt !== null) levels.push({ value: entry.levels.warningAt, color: severityCss("warning"), legend: "Warning level" });
    if (entry.levels.criticalAt !== null) levels.push({ value: entry.levels.criticalAt, color: severityCss("critical"), legend: "Critical level" });
  } else if (o.metric === "customWidgetValue" && o.threshold) {
    levels.push({ value: o.threshold.value, color: severityCss(o.threshold.severity), legend: `${cap(o.threshold.severity)} threshold` });
  }

  let points: SparkPoint[];
  if (o.sampleData) {
    points = sampleWidgetSeries(o.from, o.to, levels.length ? Math.max(...levels.map((l) => l.value)) : null);
  } else {
    if (!assetId) return null;
    const rows = await prisma.assetCustomWidgetSample.findMany({
      where: { assetId, widgetId: o.dimension, kind: "scalar", timestamp: { gte: new Date(o.from), lte: new Date(o.to) } },
      select: { timestamp: true, value: true },
      orderBy: { timestamp: "asc" },
    });
    points = thin(rows.flatMap((r) => {
      const n = typeof r.value === "number" ? r.value : Number(r.value);
      return Number.isFinite(n) ? [{ t: r.timestamp.getTime(), v: n }] : [];
    }));
  }
  if (points.length === 0) return null;
  const svg = sparklineSvg(points, {
    label: name, unit, color: WIDGET_SERIES_COLOR, from: o.from, to: o.to,
    seriesLegend: name, levels,
  });
  const s = seriesStats(points)!;
  return {
    svg,
    summary: `${name} (last hour): now ${formatReading(s.last, unit)}, avg ${formatReading(s.avg, unit)}, peak ${formatReading(s.max, unit)}`,
  };
}

/**
 * The state probe row's status strip, or null when the window held no reading.
 * `dimension` is `Notification.dimension` — `"<probeId>|<rowKey>"`. A table
 * probe's chart names its row; a scalar probe's ("" row key) does not.
 */
export async function buildStateStripChart(
  assetId: string | null,
  o: { dimension: string | null; from: number; to: number; sampleData?: boolean },
): Promise<WidgetChart | null> {
  if (!o.dimension) return null;
  const bar = o.dimension.indexOf("|");
  const probeId = bar >= 0 ? o.dimension.slice(0, bar) : o.dimension;
  const rowKey = bar >= 0 ? o.dimension.slice(bar + 1) : "";
  const { listStateProbes } = await import("./manufacturerProfileService.js");
  const probe = listStateProbes().find((p) => p.id === probeId) ?? null;
  const map = normalizeStateMap(probe?.stateMap ?? null);
  const problemValue: 0 | 1 = map.trueIsProblem ? 1 : 0;
  const problemLabel = problemValue === 1 ? map.trueLabel : map.falseLabel;
  const okLabel = problemValue === 1 ? map.falseLabel : map.trueLabel;

  let points: SparkPoint[];
  let rowLabel = rowKey;
  if (o.sampleData) {
    const flip = o.from + (o.to - o.from) * 0.8;
    points = [{ t: o.from, v: 1 - problemValue }, { t: flip, v: problemValue }];
  } else {
    if (!assetId) return null;
    const rows = await prisma.assetStateSample.findMany({
      where: { assetId, probeId, rowKey, timestamp: { gte: new Date(o.from), lte: new Date(o.to) } },
      select: { timestamp: true, value: true, rowLabel: true },
      orderBy: { timestamp: "asc" },
    });
    points = rows.filter((r) => r.value === 0 || r.value === 1).map((r) => ({ t: r.timestamp.getTime(), v: r.value }));
    if (rows.length) rowLabel = rows[rows.length - 1]!.rowLabel || rowKey;
  }
  if (points.length === 0) return null;
  const name = probe?.name ?? "State";
  const label = rowKey ? `${name} — ${rowLabel}` : name;
  const svg = statusStripSvg(points, { label, from: o.from, to: o.to, okLabel, problemLabel, problemValue });
  const last = points[points.length - 1]!;
  return { svg, summary: `${label} (last hour): now ${last.v === problemValue ? problemLabel : okLabel}` };
}
