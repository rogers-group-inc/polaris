/**
 * src/jobs/hostMetricsCollector.ts
 *
 * Samples the Polaris HOST's CPU / memory / load every 30s into
 * HostMetricsSample, so `host_metric` notification rules ("Polaris server out
 * of memory / high CPU") have a time-series to read. capacityService already
 * READS these via node:os but never stored them — this is the storage gap.
 *
 * CPU% is computed from the delta of os.cpus() busy/idle times between two
 * samples (the first tick after boot has no prior baseline, so it stores 0).
 * Web/all role only (imported from startBackgroundJobs under runsSchedulers).
 *
 * Rows age out at 7 days via the nightly sample-prune pass (pruneEvents-style).
 */

import { cpus, totalmem, freemem, loadavg } from "node:os";
import { prisma } from "../db.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 30 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface CpuSnapshot { idle: number; total: number; }

function readCpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let prevCpu: CpuSnapshot | null = null;

function cpuPctFromDelta(prev: CpuSnapshot | null, cur: CpuSnapshot): number {
  if (!prev) return 0;
  const idleDelta = cur.idle - prev.idle;
  const totalDelta = cur.total - prev.total;
  if (totalDelta <= 0) return 0;
  const busy = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, busy * 100));
}

let _lastPruneAt = 0;

// Prime the CPU baseline immediately, then sample on the interval. The first
// real sample lands one interval later so the CPU delta is meaningful.
prevCpu = readCpuSnapshot();
defineJob({
  name: "hostMetricsCollector",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: INTERVAL_MS,
  run: async () => {
    const cur = readCpuSnapshot();
    const cpuPct = cpuPctFromDelta(prevCpu, cur);
    prevCpu = cur;

    const total = totalmem();
    const free = freemem();
    const used = total - free;
    const memUsedPct = total > 0 ? (used / total) * 100 : 0;
    const [l1, l5, l15] = loadavg();
    const rss = process.memoryUsage().rss;

    await prisma.hostMetricsSample.create({
      data: {
        cpuPct,
        memUsedPct,
        memUsedBytes: BigInt(used),
        memTotalBytes: BigInt(total),
        loadAvg1: l1 ?? 0,
        loadAvg5: l5 ?? 0,
        loadAvg15: l15 ?? 0,
        procRssBytes: BigInt(rss),
      },
    });

    // Prune hourly (cheap; bounded table).
    const now = Date.now();
    if (now - _lastPruneAt > 60 * 60 * 1000) {
      _lastPruneAt = now;
      await prisma.hostMetricsSample.deleteMany({ where: { timestamp: { lt: new Date(now - RETENTION_MS) } } });
    }
  },
});
