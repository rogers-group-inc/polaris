/**
 * src/services/notificationCadenceService.ts — how often the devices a draft
 * automation covers actually take the reading that automation watches.
 *
 * The wizard counts its hold and window fields in POLLS rather than minutes: a
 * threshold can only be tested when a reading arrives, so "sustained for 3"
 * means three readings, and a value in minutes was only ever a wall-clock
 * spelling of that — one that silently meant a different number of readings on
 * a device polled every 5 minutes than on one polled every 30 seconds. The
 * STORED shape is unchanged (seconds, on the trigger and on the reset), so this
 * service answers the one question the browser cannot: at what cadence do the
 * matched devices take this particular reading, so the wizard can convert and
 * SAY which number it converted at.
 *
 * Two facts carry it:
 *  - The cadence is per STREAM, not per device: memory rides the cpuMemory
 *    interval, an interface counter the systemInfo one, packet loss the probe
 *    interval. So the metric selects the field, via METRIC_STREAM.
 *  - The cadence is per ASSET (it resolves through the monitor-settings
 *    hierarchy), so a scope spanning two integrations has a RANGE. The wizard
 *    converts at the modal value and reports the range, the same shape the
 *    down-detection caption already renders — never one invented number
 *    presented as the fleet's.
 *
 * Cost: resolveMonitorSettings memoizes on (integrationId, assetType), so the
 * DB reads are per distinct CLASS, not per asset (the seedBaselineAutomations
 * V3 precedent). At 2000 monitored assets this is one findMany with a tight
 * select plus a handful of settings reads.
 */

import { prisma } from "../db.js";
import { resolveMonitorSettings, type ResolvedMonitorSettings } from "./monitoringService.js";
import { loadScopeAssetIds } from "./notificationEngine.js";
import type { RuleScope } from "./notificationTypes.js";

/** The five cadences a metric can ride. */
export type CadenceStream = "responseTime" | "cpuMemory" | "temperature" | "systemInfo" | "storage";

/** Which resolved settings fields carry each stream's cadence + collector timeout. */
const STREAM_FIELDS: Record<CadenceStream, { interval: keyof ResolvedMonitorSettings; timeout: keyof ResolvedMonitorSettings }> = {
  responseTime: { interval: "intervalSeconds",            timeout: "probeTimeoutMs" },
  cpuMemory:    { interval: "cpuMemoryIntervalSeconds",   timeout: "cpuMemoryTimeoutMs" },
  temperature:  { interval: "temperatureIntervalSeconds", timeout: "temperatureTimeoutMs" },
  systemInfo:   { interval: "systemInfoIntervalSeconds",  timeout: "systemInfoTimeoutMs" },
  storage:      { interval: "storageIntervalSeconds",     timeout: "storageTimeoutMs" },
};

/**
 * Metric / state field → the collector whose cadence produces it. Mirrors the
 * metric dispatch in `resolveAssetMetricReadings` (which table each reading is
 * read from), because the table and the cadence are two halves of one fact: the
 * telemetry sample table is written by the cpuMemory pass, the interface and
 * SD-WAN tables by the systemInfo pass, and so on. A metric absent from this
 * map falls back to the probe cadence, which is the one every monitored asset
 * has.
 */
export const METRIC_STREAM: Record<string, CadenceStream> = {
  // Probe loop (assetMonitorSample + the Asset columns the probe stamps).
  responseTimeMs: "responseTime",
  uptimeSec: "responseTime",
  probeLossPct: "responseTime",
  monitorStatus: "responseTime",
  consecutiveFailures: "responseTime",
  dependencySuppressed: "responseTime",
  quarantined: "responseTime",
  status: "responseTime",
  // Telemetry pass (assetTelemetrySample).
  cpuPct: "cpuMemory",
  memPct: "cpuMemory",
  memUsedBytes: "cpuMemory",
  sessionCount: "cpuMemory",
  // Hardware-sensor pass (assetHardwareSensorSample).
  hwSensorValue: "temperature",
  hwSensorAlarm: "temperature",
  // Storage pass (assetStorageSample). storageDaysUntilFull is a 30-day
  // forecast recomputed off those samples — same cadence, though a hold counted
  // in polls means little on a metric that moves once a day.
  storageUsedPct: "storage",
  storageUsedBytes: "storage",
  storageDaysUntilFull: "storage",
  // System-info pass — interfaces, SD-WAN, IPsec, custom widgets and state
  // probes all ride it.
  ifInBps: "systemInfo",
  ifOutBps: "systemInfo",
  ifInErrorRate: "systemInfo",
  ifOutErrorRate: "systemInfo",
  ifOperStatus: "systemInfo",
  ifAdminStatus: "systemInfo",
  ifIpAddress: "systemInfo",
  poeStatus: "systemInfo",
  sdwanLatencyMs: "systemInfo",
  sdwanJitterMs: "systemInfo",
  sdwanPacketLoss: "systemInfo",
  sdwanRuleStatus: "systemInfo",
  sdwanSelectedMember: "systemInfo",
  ipsecThroughputBps: "systemInfo",
  ipsecStatus: "systemInfo",
  customWidgetValue: "systemInfo",
  customStateValue: "systemInfo",
};

/**
 * The Polaris host's own metrics are sampled by hostMetricsCollector, which
 * runs on a fixed 30s tick — no hierarchy, no scope, no range.
 */
export const HOST_METRIC_INTERVAL_SEC = 30;

export function streamForMetric(metric: string | null | undefined): CadenceStream {
  return (metric && METRIC_STREAM[metric]) || "responseTime";
}

export interface ScopeCadence {
  /** Which collector's cadence this is. */
  stream: CadenceStream;
  /** Most common interval across the matched devices — what the wizard converts at. */
  mode: number;
  min: number;
  max: number;
  /** Modal probe/collector timeout (ms) — the down-detection caption needs it. */
  timeoutMs: number;
  /** How many monitored devices the scope matched (0 = nothing to report). */
  assetCount: number;
}

/**
 * Pure: modal / min / max of a list of intervals. Ties on the mode go to the
 * SMALLER interval, matching the resolver's own tiebreak — and erring toward
 * the shorter wall-clock time for a given number of polls, i.e. toward the
 * operator being told the alert fires sooner than it might.
 */
export function summarizeIntervals(values: number[]): { mode: number; min: number; max: number } | null {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!nums.length) return null;
  const counts = new Map<number, number>();
  for (const v of nums) counts.set(v, (counts.get(v) ?? 0) + 1);
  let mode = nums[0]!;
  let best = -1;
  for (const [v, c] of counts) {
    if (c > best || (c === best && v < mode)) { mode = v; best = c; }
  }
  return { mode, min: Math.min(...nums), max: Math.max(...nums) };
}

/** Same, for the timeout — reported as the modal value only. */
function modalOf(values: number[]): number | null {
  const s = summarizeIntervals(values);
  return s ? s.mode : null;
}

/**
 * The cadence at which the devices in `scope` take the reading `metric` names.
 * Monitored-only, like every other question the builder asks about a scope
 * (business rule 37): a device nothing polls has no cadence to report, and its
 * interval would drag the range somewhere no alert can happen.
 */
export async function resolveScopeCadence(scope: RuleScope, metric: string | null | undefined): Promise<ScopeCadence> {
  const stream = streamForMetric(metric);
  const fields = STREAM_FIELDS[stream];
  const ids = await loadScopeAssetIds(scope, { monitoredOnly: true });
  if (!ids.length) {
    return { stream, mode: 0, min: 0, max: 0, timeoutMs: 0, assetCount: 0 };
  }
  const assets = await prisma.asset.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, assetType: true, discoveredByIntegrationId: true,
      discoveredByIntegration: { select: { type: true } },
      monitorIntervalSec: true, probeTimeoutMs: true,
      cpuMemoryIntervalSec: true, cpuMemoryTimeoutMs: true,
      temperatureIntervalSec: true, temperatureTimeoutMs: true,
      systemInfoIntervalSec: true, systemInfoTimeoutMs: true,
      storageIntervalSec: true,
      responseTimePolling: true,
    },
  });

  const intervals: number[] = [];
  const timeouts: number[] = [];
  for (const a of assets) {
    try {
      const eff = await resolveMonitorSettings({
        ...a,
        discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
      } as Parameters<typeof resolveMonitorSettings>[0]);
      const iv = eff[fields.interval];
      const to = eff[fields.timeout];
      if (typeof iv === "number" && iv > 0) intervals.push(iv);
      if (typeof to === "number" && to > 0) timeouts.push(to);
    } catch {
      // A device whose settings won't resolve contributes nothing rather than a
      // guess — the caption says how many devices it is speaking for.
    }
  }
  const s = summarizeIntervals(intervals);
  return {
    stream,
    mode: s?.mode ?? 0,
    min: s?.min ?? 0,
    max: s?.max ?? 0,
    timeoutMs: modalOf(timeouts) ?? 0,
    assetCount: assets.length,
  };
}
