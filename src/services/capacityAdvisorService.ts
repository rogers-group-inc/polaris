/**
 * src/services/capacityAdvisorService.ts
 *
 * Capacity Advisor — derives recommended worker counts, connection-pool sizes,
 * PostgreSQL max_connections, queue mode (cursor ↔ pg-boss), and PostgreSQL
 * tuning settings from observable workload (monitored asset count, monitored
 * interface count, integration counts, per-cadence pass-duration P90, observed
 * peak connections, host RAM, current max_connections).
 *
 * Advisory-only by default: this module computes recommendations and exposes
 * them via the Maintenance tab. An explicit Stage POST writes the operator-
 * selected env-driven values to `.env` (takes effect at next Polaris restart);
 * max_connections and PostgreSQL tuning are display-only because they require
 * a PostgreSQL restart Polaris can't trigger.
 *
 * Calc chain (see polaris-change-impact -> services/samples-timeseries.md "capacityAdvisorService"):
 *
 *   For each cadence c in {probe, fastFiltered, telemetry, systemInfo}:
 *     workersNeeded[c] = ceil(applicable × p90 / cadenceInterval × 1.5)
 *     workersFloor[c]  = max(currentEnvVar, 24)
 *     recommended[c]   = max(workersNeeded, workersFloor)
 *
 *   floatingWorkers  = max(32, ceil(0.25 × Σrecommended))
 *   workerCeiling    = Σrecommended + floatingWorkers
 *
 *   discoveryReserve = Σ over enabled integrations
 *   httpOverhead     = 15
 *   prismaTarget     = workerCeiling + discoveryReserve + httpOverhead
 *   pgbossTarget     = 20  (fixed; queue mechanics only)
 *
 *   DATABASE_POOL_SIZE      = roundUpToNearest(max(prismaTarget, current), 50)
 *   POLARIS_PGBOSS_POOL_SIZE = roundUpToNearest(max(pgbossTarget, current), 50)
 *
 *   perProcessPool   = effective prisma pool + effective pgboss pool
 *   processCount     = POLARIS_MONITOR_REPLICAS>0 ? replicas+2 : 1  (web + N monitor + discovery)
 *   polarisNeeded    = perProcessPool × processCount
 *   polarisFloor     = max(polarisNeeded, peakObserved)   // peakObserved is group-wide (pg_stat_activity)
 *   recommendedMax   = roundUpToNearest(ceil(polarisFloor / 0.65), 50)
 *
 * Cold start: when histogram sample count is < 100 per cadence, substitute
 * COLD_START_P90_SEC defaults. Surfaced as a per-row badge in the UI.
 *
 * Never recommends shrinking — changeRequired is set only when recommended >
 * current. Small downward drift isn't worth a restart.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { setEnvVar } from "../utils/envFile.js";
import { isWorkloadPlatform } from "../utils/workloadSources.js";
import { getMonitorWorkHistogramValues, type HistogramBucketValue } from "../metrics.js";
import { setQueueMode, isPgbossInstalled, QUEUE_NAMES } from "./queueService.js";
import type { CapacitySnapshot } from "./capacityService.js";
import { logEvent } from "./eventLogService.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type CadenceKey = "probe" | "fastFiltered" | "telemetry" | "systemInfo" | "lldp" | "storage";

export type AdvisorLeverKey =
  | "DATABASE_POOL_SIZE"
  | "POLARIS_PGBOSS_POOL_SIZE"
  | "POLARIS_MONITOR_PROBE_WORKERS"
  | "POLARIS_MONITOR_FAST_WORKERS"
  | "POLARIS_MONITOR_HEAVY_WORKERS"
  | "POLARIS_MONITOR_LLDP_WORKERS"
  | "POLARIS_MONITOR_STORAGE_WORKERS"
  | "POLARIS_MONITOR_FLOATING_WORKERS"
  | "POLARIS_PROBE_CONCURRENCY"
  | "POLARIS_HEAVY_CONCURRENCY"
  | "QUEUE_MODE"
  | "PG_MAX_CONNECTIONS"
  | "PG_SHARED_BUFFERS"
  | "PG_EFFECTIVE_CACHE_SIZE"
  | "PG_WORK_MEM"
  | "PG_RANDOM_PAGE_COST";

export type ApplyMode = "env" | "queue-mode-endpoint" | "advisory-only";

export interface AdvisorRecommendation {
  key: AdvisorLeverKey;
  applyMode: ApplyMode;
  /** Null when the current value can't be resolved (e.g. PG setting query failed). */
  current: number | string | null;
  recommended: number | string;
  /** Human-friendly text rendered in the UI describing why this number. */
  rationale: string;
  /** Numeric component breakdown for tooltip diagnostics. */
  breakdown?: Record<string, number>;
  /** True when recommended > current (i.e. Stage would change something). */
  changeRequired: boolean;
  /** True when the queue mode this lever applies to does not match the active mode.
   *  UI uses this to dim "applies after queue-mode flip" rows. */
  appliesAfterQueueModeFlip?: boolean;
  /** True when the current value is an explicit ALTER SYSTEM override
   *  (postgresql.auto.conf). UI renders these "operator-set" rather than
   *  flagging a change, since the advisory recommendation is intentionally
   *  overridden. Only set on the advisory-only pg-tuning levers. */
  operatorOverride?: boolean;
}

export interface CadenceObservation {
  sampleCount: number;
  /** P50 duration in seconds, or null when sampleCount < threshold. */
  p50: number | null;
  /** P90 duration in seconds, or null when sampleCount < threshold. */
  p90: number | null;
  /** True when we substituted COLD_START_P90_SEC for this cadence. */
  usedDefault: boolean;
}

export interface AdvisorState {
  computedAt: string;
  /** True when ANY cadence's sample count was below the cold-start threshold. */
  usingColdStartDefaults: boolean;
  cadenceSamples: Record<CadenceKey, CadenceObservation>;
  recommendations: AdvisorRecommendation[];
  /** Roll-up: any recommendation with changeRequired = true. */
  anyChangeRequired: boolean;
  /** True when a successful Stage would require a Polaris restart to take effect. */
  restartRequired: boolean;
  /** Boot-time active queue mode (informational; lets the UI render hints). */
  activeQueueMode: "cursor" | "pgboss";
  /** What the advisor would recommend the queue mode be. */
  recommendedQueueMode: "cursor" | "pgboss";
  /** Per-cadence pg-boss handler timeout cap (`pgboss.queue.expire_seconds`),
   *  read live from the queue table so the advisor reflects what's actually in
   *  effect — not just what `EXPIRE_BY_QUEUE` in queueService.ts would set on
   *  a fresh install. Null when the queue row hasn't been created yet (cursor
   *  mode pre-flip, or pg-boss hasn't booted) or the read failed. */
  handlerTimeoutSec: Record<CadenceKey, number | null>;
  /** Cadences whose observed p90 has climbed close to the handler timeout cap.
   *  Empty list = healthy headroom. Non-empty drives the
   *  `monitor_handler_timeout_pressure` watch reason in capacityService. */
  handlerTimeoutPressure: HandlerTimeoutPressure[];
}

export interface HandlerTimeoutPressure {
  cadence: CadenceKey;
  /** Observed p90 in seconds (from the histogram, or COLD_START fallback). */
  p90Sec: number;
  /** Per-queue handler kill cap from pgboss.queue.expire_seconds. */
  expireSec: number;
  /** p90 / expireSec, 0..1 — UI displays as a percentage. */
  utilization: number;
}

export interface IntegrationBreakdown {
  fortimanagerProxy: number;
  fortimanagerDirectParallelismSum: number;
  fortigate: number;
  entra: number;
  activedirectory: number;
  windowsserver: number;
  vcenter: number;
  azurearc: number;
  /** Unraid + TrueNAS SCALE integrations (optional: older callers predate them). */
  workload?: number;
}

export interface PgRecommendation {
  /** Friendly current display value (e.g. "128MB"), or null when unknown. */
  current: string | null;
  /** Friendly recommended value. */
  recommended: string;
  /** True when current is below recommended. */
  changeRequired: boolean;
  /** True when the current value was set explicitly via ALTER SYSTEM
   *  (postgresql.auto.conf) — a deliberate operator override the advisor honors
   *  rather than recommending a change. */
  operatorOverride?: boolean;
}

export interface AdvisorInputs {
  snapshot: CapacitySnapshot;
  integrations: IntegrationBreakdown;
  cadence: Record<CadenceKey, CadenceObservation>;
  /** Per-cadence cadence-interval seconds (resolved from MonitorSettings). */
  cadenceIntervals: Record<CadenceKey, number>;
  /** Per-cadence pg-boss handler timeout cap (`pgboss.queue.expire_seconds`),
   *  read live from the queue table. Null when the queue row hasn't been
   *  created yet (cursor mode pre-flip) or the read failed. Used both for
   *  tooltip context (showing headroom vs. observed p90) and for the
   *  `handlerTimeoutPressure` rollup that fires the matching watch reason. */
  handlerTimeoutSec: Record<CadenceKey, number | null>;
  /** Already-resolved per-cadence applicable asset population. */
  applicable: Record<CadenceKey, number>;
  /** Current env-var values for the worker / pool levers (numeric). */
  currentEnv: {
    DATABASE_POOL_SIZE: number;
    POLARIS_PGBOSS_POOL_SIZE: number;
    POLARIS_MONITOR_PROBE_WORKERS: number;
    POLARIS_MONITOR_FAST_WORKERS: number;
    POLARIS_MONITOR_HEAVY_WORKERS: number;
    POLARIS_MONITOR_LLDP_WORKERS: number;
    POLARIS_MONITOR_STORAGE_WORKERS: number;
    POLARIS_MONITOR_FLOATING_WORKERS: number;
    POLARIS_PROBE_CONCURRENCY: number;
    POLARIS_HEAVY_CONCURRENCY: number;
  };
  /** PG tuning current → recommended pairs (computed by serverSettings.buildPgRecommended). */
  pgTuning: {
    sharedBuffers: PgRecommendation;
    effectiveCacheSize: PgRecommendation;
    workMem: PgRecommendation;
    randomPageCost: PgRecommendation;
  };
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Min samples in the histogram before we trust p90; below this we fall back
 *  to COLD_START_P90_SEC. At a 60s probe cadence with 1000 monitored assets,
 *  1000 samples accumulate per minute — this threshold is reached in seconds. */
export const COLD_START_MIN_SAMPLES = 100;

export const COLD_START_P90_SEC: Record<CadenceKey, number> = {
  probe:        0.4,
  fastFiltered: 0.6,
  telemetry:    0.8,
  systemInfo:   1.0,
  // Phase 2 carve-outs default to roughly half the systemInfo p90 — they walk
  // one MIB family each (LLDP-MIB or HOST-RESOURCES-MIB hrStorageTable) plus
  // the vendor disk fallback for storage, much less work than the full
  // interfaces + storage + IPsec + LLDP combined pass.
  lldp:         0.5,
  storage:      0.5,
};

/** Cap on the per-cadence floor. Large fleets land here regardless of fleet
 *  size — the floor is a "modest burst absorber" idea, and at 48+ monitored
 *  assets the modeled workersNeeded is what matters anyway. */
const PER_CADENCE_FLOOR = 24;

/** Minimum per-cadence floor. Tiny installs (single-digit asset counts) still
 *  get a 4-worker headroom over the literal modeled need so probe-now bursts
 *  don't queue, but don't carry the full 24-worker cold-start cushion that
 *  was sized for production-shaped fleets. */
const PER_CADENCE_FLOOR_MIN = 4;

/** Cap on the floating worker pool baseline. Absorbs cross-queue imbalance
 *  at scale; smaller fleets get a proportionally smaller floating pool via
 *  FLEET_FLOOR_FACTOR. */
const FLOATING_FLOOR = 32;

/** Minimum floating worker pool size. Same rationale as PER_CADENCE_FLOOR_MIN
 *  — keep tiny installs from advertising tens of unused workers. */
const FLOATING_FLOOR_MIN = 4;

/** Scaling factor applied to monitoredAssetCount when computing the per-cadence
 *  and floating floors for small fleets. At 0.5, a fleet of N monitored assets
 *  gets a floor of ceil(N × 0.5) clamped between the *_MIN and *_FLOOR caps —
 *  so 6 assets → floor 4, 24 assets → floor 12, 48+ assets → cap. */
const FLEET_FLOOR_FACTOR = 0.5;

/** Multiplier applied to workersNeeded to absorb variance, retries, slow tail. */
const SAFETY_FACTOR = 1.5;

/** Empirical headroom for HTTP request bursts and scheduled jobs. */
const HTTP_JOB_OVERHEAD = 15;

/** Floor for the pg-boss internal connection pool. pg-boss uses this pool
 *  for its own queue mechanics (boss.fetch, boss.complete, boss.fail) —
 *  separate from the Prisma pool that workers use to do their actual
 *  work. Earlier this was hardcoded; in practice operators running with
 *  128 concurrent workers (24×4 dedicated + 32 floating) saw pg-boss
 *  queries queue up at 20 conns because every worker completion has to
 *  acquire a slot to call boss.complete()/fail(). The advisor now scales
 *  the recommendation with the total worker count (see `pgbossPoolForWorkers`
 *  in buildAdvisorState); this constant is the never-shrink-below floor. */
const PGBOSS_POOL_TARGET = 20;
/** Fraction of total worker count to allocate to the pg-boss pool. Sized
 *  for the completion-burst case — at 128 workers, 0.25 × 128 = 32 conns,
 *  comfortably absorbing simultaneous boss.complete()/fail() calls when a
 *  cadence tick finishes its batch. */
const PGBOSS_POOL_WORKER_FRACTION = 0.25;

/** Target fraction of max_connections we want Polaris to occupy at peak. */
const POLARIS_FRACTION_OF_MAX = 0.65;

/** Round up to nearest multiple — operator-friendly recommendations. */
const MAX_CONNECTIONS_ROUNDING = 50;

/** Round pool-size recommendations to this multiple for cleaner .env values. */
const POOL_ROUNDING = 50;

/** Asset-count threshold above which pgboss is the recommended queue mode. */
const PGBOSS_RECOMMEND_ASSETS = 500;

/** Fraction of `pgboss.queue.expire_seconds` at which observed p90 starts
 *  flagging timeout pressure. Below this the queue is healthy; above it,
 *  the handler is starting to brush against the kill cap and operators get
 *  a watch-severity nudge to either raise EXPIRE_BY_QUEUE for the cadence
 *  or trim the per-asset payload. 0.7 is conservative — picked to fire
 *  before any actual kills (which would corrupt the histogram-based p90
 *  used elsewhere by the advisor). */
const HANDLER_TIMEOUT_PRESSURE_RATIO = 0.7;

const ADVISOR_CACHE_TTL_MS = 10 * 60 * 1000;
const LAST_CHANGE_REQUIRED_SETTING_KEY = "capacity.advisor.lastChangeRequired";

// ─── Public utility: roundUpToNearest (exported for tests) ────────────────

export function roundUpToNearest(value: number, multiple: number): number {
  if (multiple <= 0 || !Number.isFinite(value)) return value;
  return Math.ceil(value / multiple) * multiple;
}

// ─── Histogram percentile parsing ──────────────────────────────────────────

const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60];

/**
 * Compute a percentile from prom-client histogram values, scoped to a single
 * cadence label. Aggregates bucket counts across all asset_type × transport
 * label combos for that cadence, then linear-interpolates within the matching
 * bucket. Returns null when fewer than COLD_START_MIN_SAMPLES samples exist.
 *
 * The histogram is `polaris_monitor_work_duration_seconds` with buckets
 * defined in src/metrics.ts:33 — keep HISTOGRAM_BUCKETS above in sync.
 */
export function percentile(
  values: HistogramBucketValue[],
  cadence: CadenceKey,
  p: 0.5 | 0.9,
): { value: number | null; sampleCount: number } {
  // Pre-prom-client emits per-bucket entries with metricName ending in
  // "_bucket" and labels.le set to the bucket boundary (or "+Inf"). The
  // "_count" rows (no le) carry the total sample count.
  const scoped = values.filter((v) => v.labels.cadence === cadence);

  // Sum cumulative bucket counts across asset_type × transport for each `le`.
  const bucketSums = new Map<string, number>();
  let totalCount = 0;
  for (const entry of scoped) {
    const m = entry.metricName;
    if (m && m.endsWith("_count")) {
      totalCount += entry.value;
      continue;
    }
    if (m && m.endsWith("_sum")) continue;
    const le = entry.labels.le;
    if (le === undefined) continue;
    const key = String(le);
    bucketSums.set(key, (bucketSums.get(key) ?? 0) + entry.value);
  }

  if (totalCount < COLD_START_MIN_SAMPLES) {
    return { value: null, sampleCount: totalCount };
  }

  const target = totalCount * p;
  let prevBoundary = 0;
  let prevCum = 0;
  for (const boundary of HISTOGRAM_BUCKETS) {
    const cum = bucketSums.get(String(boundary)) ?? 0;
    if (cum >= target) {
      // Linear interpolate within this bucket so the percentile estimate is
      // closer than just naming the bucket upper bound.
      const within = cum - prevCum;
      if (within <= 0) return { value: boundary, sampleCount: totalCount };
      const frac = (target - prevCum) / within;
      const interpolated = prevBoundary + (boundary - prevBoundary) * frac;
      return { value: interpolated, sampleCount: totalCount };
    }
    prevBoundary = boundary;
    prevCum = cum;
  }
  // Past the largest finite bucket — fall through to "+Inf"; return last
  // boundary as a conservative estimate.
  return { value: HISTOGRAM_BUCKETS[HISTOGRAM_BUCKETS.length - 1], sampleCount: totalCount };
}

async function observeCadences(): Promise<Record<CadenceKey, CadenceObservation>> {
  const out: Record<CadenceKey, CadenceObservation> = {
    probe:        { sampleCount: 0, p50: null, p90: null, usedDefault: true },
    fastFiltered: { sampleCount: 0, p50: null, p90: null, usedDefault: true },
    telemetry:    { sampleCount: 0, p50: null, p90: null, usedDefault: true },
    systemInfo:   { sampleCount: 0, p50: null, p90: null, usedDefault: true },
    lldp:         { sampleCount: 0, p50: null, p90: null, usedDefault: true },
    storage:      { sampleCount: 0, p50: null, p90: null, usedDefault: true },
  };
  try {
    const hist = await getMonitorWorkHistogramValues();
    for (const c of Object.keys(out) as CadenceKey[]) {
      const p50 = percentile(hist.values, c, 0.5);
      const p90 = percentile(hist.values, c, 0.9);
      out[c] = {
        sampleCount: p90.sampleCount,
        p50: p50.value,
        p90: p90.value,
        usedDefault: p90.value === null,
      };
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityAdvisor: histogram read failed; using cold-start defaults");
  }
  return out;
}

// ─── Pure compute: buildAdvisorState ──────────────────────────────────────

export function buildAdvisorState(inputs: AdvisorInputs): AdvisorState {
  const { snapshot, integrations, cadence, cadenceIntervals, handlerTimeoutSec, applicable, currentEnv, pgTuning } = inputs;
  const recommendations: AdvisorRecommendation[] = [];

  // 1. Per-cadence worker needs.
  //
  // The floor is the lower bound on each cadence's worker count, sized to
  // absorb modest bursts (manual probe-now from the UI, multi-operator use)
  // when the modeled need is tiny. It scales with monitoredAssetCount so a
  // 6-asset install doesn't get the same 24-worker cushion as a 600-asset
  // install — at the small end the cushion is bigger than the workload.
  const monitoredCount = snapshot.workload.monitoredAssetCount;
  const perCadenceFloor = Math.min(
    PER_CADENCE_FLOOR,
    Math.max(PER_CADENCE_FLOOR_MIN, Math.ceil(monitoredCount * FLEET_FLOOR_FACTOR)),
  );
  const floatingFloor = Math.min(
    FLOATING_FLOOR,
    Math.max(FLOATING_FLOOR_MIN, Math.ceil(monitoredCount * FLEET_FLOOR_FACTOR)),
  );
  const cadenceKeys: CadenceKey[] = ["probe", "fastFiltered", "telemetry", "systemInfo", "lldp", "storage"];
  const workersNeeded: Record<CadenceKey, number> = { probe: 0, fastFiltered: 0, telemetry: 0, systemInfo: 0, lldp: 0, storage: 0 };
  const handlerTimeoutPressure: HandlerTimeoutPressure[] = [];
  for (const c of cadenceKeys) {
    const p90 = cadence[c].p90 ?? COLD_START_P90_SEC[c];
    const interval = Math.max(1, cadenceIntervals[c]);
    const need = Math.ceil((applicable[c] * p90 * SAFETY_FACTOR) / interval);
    workersNeeded[c] = Math.max(need, perCadenceFloor);
    // Timeout-pressure check: when observed p90 climbs toward the pg-boss
    // handler kill cap, fire a watch reason BEFORE jobs start getting killed
    // (which would corrupt the histogram the advisor reads).
    const expire = handlerTimeoutSec[c];
    if (expire && p90 >= expire * HANDLER_TIMEOUT_PRESSURE_RATIO) {
      handlerTimeoutPressure.push({ cadence: c, p90Sec: p90, expireSec: expire, utilization: p90 / expire });
    }
  }
  const sumWorkersNeeded = Object.values(workersNeeded).reduce((a, b) => a + b, 0);
  const floatingWorkers = Math.max(floatingFloor, Math.ceil(sumWorkersNeeded * 0.25));
  const workerCeiling = sumWorkersNeeded + floatingWorkers;

  // 2. Discovery reserve.
  const discoveryReserve =
    integrations.fortimanagerProxy * 1 +
    Math.min(integrations.fortimanagerDirectParallelismSum, 20) +
    integrations.fortigate * 1 +
    // `?? 0` — older callers/tests may pass a breakdown built before the
    // vcenter member existed.
    (integrations.entra + integrations.activedirectory + integrations.windowsserver + (integrations.vcenter ?? 0)
      + (integrations.workload ?? 0)) * 2;

  // 3. Prisma / pg-boss / max_connections.
  //
  // The Prisma pool recommendation has to honor observed reality, not just the
  // worker-count model. If the rolling-peak pg_stat_activity count has been
  // bumping against the configured pool, the model under-predicted demand —
  // typically because HTTP request bursts or discovery cycles aren't fully
  // modeled by workerCeiling + discoveryReserve + httpOverhead. We size the
  // pool so the observed peak (minus the pg-boss share) lands at ≤80% pool
  // utilization, the same threshold db_pool_undersized used to fire at.
  //
  // peakObserved is GROUP-WIDE: it's `pg_stat_activity` filtered by current
  // database, so on a split-role install (web + N monitor + discovery) it
  // sums every process's open backends. DATABASE_POOL_SIZE is PER-PROCESS —
  // each Polaris process reads the env var to size its own pool. Before
  // letting peakObserved floor a per-process pool, divide it by processCount;
  // otherwise a 5-process group at 150 conns each (750 group-wide) would
  // advise each process to allocate a 900-conn pool, i.e. 4,500 backends
  // group-wide and well past any reasonable max_connections.
  const peakObserved = snapshot.database.connectionPool.peakObserved;
  // Multi-process group footprint. Each process (web producer, N monitor
  // replicas, discovery) opens its own Prisma + pg-boss pool. Set
  // POLARIS_MONITOR_REPLICAS on the web node to the number of polaris-monitor@N
  // units so the recommendation is right from day one; unset = single-process
  // ("all") = 1.
  const monitorReplicas = readEnvInt("POLARIS_MONITOR_REPLICAS", 0);
  const processCount = monitorReplicas > 0 ? monitorReplicas + 2 : 1; // web + N monitor + discovery
  // pg-boss pool sized to absorb the completion burst when many workers
  // finish simultaneously. Floors at PGBOSS_POOL_TARGET so installs below
  // ~80 workers stay on the historical 20-connection default.
  const pgbossTarget = Math.max(
    PGBOSS_POOL_TARGET,
    Math.ceil(workerCeiling * PGBOSS_POOL_WORKER_FRACTION),
  );
  const modeledPrismaTarget = workerCeiling + discoveryReserve + HTTP_JOB_OVERHEAD;
  // Per-process slice of the group-wide peak, then back out pg-boss's per-
  // process share so we're sizing the Prisma pool against Prisma demand only.
  // Floor at the modeled target if peakObserved hasn't surfaced demand the
  // model missed.
  const peakPerProcess = peakObserved / Math.max(1, processCount);
  const peakPrismaFloor = Math.ceil(Math.max(0, peakPerProcess - pgbossTarget) / 0.80);
  const prismaTarget = Math.max(modeledPrismaTarget, peakPrismaFloor);
  // max_connections must support Polaris's ACTUAL pool footprint, not just the
  // modeled target. The advisor's never-shrink rule keeps DATABASE_POOL_SIZE
  // and POLARIS_PGBOSS_POOL_SIZE at their current values when the model would
  // recommend less — so max_connections has to use those same never-shrink
  // values, otherwise we'd advise an operator that max_connections=300 is fine
  // while Polaris is configured for a 339-connection pool that'd refuse
  // connections the moment it hit 301.
  const effectivePrismaPool = Math.max(prismaTarget, currentEnv.DATABASE_POOL_SIZE);
  const effectivePgbossPool = Math.max(pgbossTarget, currentEnv.POLARIS_PGBOSS_POOL_SIZE);
  const perProcessPool = effectivePrismaPool + effectivePgbossPool;
  const polarisNeeded = perProcessPool * processCount;
  const polarisFloor = Math.max(polarisNeeded, peakObserved);
  const recommendedMax = roundUpToNearest(
    Math.ceil(polarisFloor / POLARIS_FRACTION_OF_MAX),
    MAX_CONNECTIONS_ROUNDING,
  );

  // 4. Queue mode.
  const activeMode = snapshot.database.queue.active;
  const recommendedMode: "cursor" | "pgboss" =
    monitoredCount > PGBOSS_RECOMMEND_ASSETS && isPgbossInstalled() ? "pgboss" : activeMode;

  // ── Recommendation: queue mode ─────────────────────────────────────────
  recommendations.push({
    key: "QUEUE_MODE",
    applyMode: "queue-mode-endpoint",
    current: activeMode,
    recommended: recommendedMode,
    rationale:
      recommendedMode === "pgboss" && activeMode !== "pgboss"
        ? `Monitoring ${monitoredCount} assets. pg-boss provides per-cadence isolation that scales further than the cursor queue.`
        : `Current queue mode fits the workload (${monitoredCount} monitored).`,
    breakdown: { monitoredAssetCount: monitoredCount, threshold: PGBOSS_RECOMMEND_ASSETS },
    changeRequired: activeMode !== recommendedMode,
  });

  // ── Recommendation: per-cadence workers ───────────────────────────────
  // pgboss mode levers
  const pgbossWorkerLevers: Array<{ key: AdvisorLeverKey; cad: CadenceKey | "floating"; need: number; current: number }> = [
    { key: "POLARIS_MONITOR_PROBE_WORKERS",    cad: "probe",        need: workersNeeded.probe,        current: currentEnv.POLARIS_MONITOR_PROBE_WORKERS    },
    { key: "POLARIS_MONITOR_FAST_WORKERS",     cad: "fastFiltered", need: workersNeeded.fastFiltered, current: currentEnv.POLARIS_MONITOR_FAST_WORKERS     },
    // HEAVY_WORKERS covers both telemetry + systemInfo — pick the larger gap.
    { key: "POLARIS_MONITOR_HEAVY_WORKERS",    cad: "telemetry",    need: Math.max(workersNeeded.telemetry, workersNeeded.systemInfo), current: currentEnv.POLARIS_MONITOR_HEAVY_WORKERS },
    { key: "POLARIS_MONITOR_LLDP_WORKERS",     cad: "lldp",         need: workersNeeded.lldp,         current: currentEnv.POLARIS_MONITOR_LLDP_WORKERS     },
    { key: "POLARIS_MONITOR_STORAGE_WORKERS",  cad: "storage",      need: workersNeeded.storage,      current: currentEnv.POLARIS_MONITOR_STORAGE_WORKERS  },
    { key: "POLARIS_MONITOR_FLOATING_WORKERS", cad: "floating",     need: floatingWorkers,            current: currentEnv.POLARIS_MONITOR_FLOATING_WORKERS },
  ];
  for (const lever of pgbossWorkerLevers) {
    const recommended = Math.max(lever.need, lever.current);
    let rationale: string;
    let breakdown: Record<string, number>;
    if (lever.cad === "floating") {
      rationale = `Floating pool absorbs cross-queue backlog. Sized at max(${floatingFloor}, 25% of dedicated workers).`;
      breakdown = { sumWorkersNeeded, floor: floatingFloor, quarterOfDedicated: Math.ceil(sumWorkersNeeded * 0.25) };
    } else {
      const cad = lever.cad as CadenceKey;
      const p90Sec = cadence[cad].p90 ?? COLD_START_P90_SEC[cad];
      const cadenceIntervalSec = cadenceIntervals[cad];
      const timeoutSec = handlerTimeoutSec[cad];
      // The "/ 60s" part of the formula is the cadence interval (how often
      // each asset is polled), NOT the pg-boss handler timeout. Label it
      // explicitly so operators don't conflate the two — they were the same
      // 60s value before bcd8d5e split the per-queue handler caps out.
      const base = `Workers needed = ceil(applicable=${applicable[cad]} × p90=${p90Sec.toFixed(2)}s × ${SAFETY_FACTOR} / cadence-interval=${cadenceIntervalSec}s). Floored at ${perCadenceFloor}.`;
      const timeoutNote = timeoutSec
        ? ` Handler timeout cap: ${timeoutSec}s (p90 at ${((p90Sec / timeoutSec) * 100).toFixed(0)}%). p90 above this cap would cause jobs to be killed and re-queued.`
        : " Handler timeout cap unknown (queue not yet created — fires on first pgboss boot).";
      rationale = base + timeoutNote;
      breakdown = {
        applicable: applicable[cad],
        p90Sec,
        cadenceIntervalSec,
        safetyFactor: SAFETY_FACTOR,
        workersNeeded: lever.need,
        floor: perCadenceFloor,
        ...(timeoutSec ? { handlerTimeoutSec: timeoutSec, p90PctOfTimeout: Math.round((p90Sec / timeoutSec) * 100) } : {}),
      };
    }
    recommendations.push({
      key: lever.key,
      applyMode: "env",
      current: lever.current,
      recommended,
      rationale,
      breakdown,
      changeRequired: recommended > lever.current,
      appliesAfterQueueModeFlip: activeMode === "cursor" && recommendedMode === "pgboss",
    });
  }

  // cursor mode levers
  const cursorWorkerLevers: Array<{ key: AdvisorLeverKey; need: number; current: number; rationale: string; breakdown: Record<string, number> }> = [
    {
      key: "POLARIS_PROBE_CONCURRENCY",
      need: workersNeeded.probe + workersNeeded.fastFiltered,
      current: currentEnv.POLARIS_PROBE_CONCURRENCY,
      rationale: "Cursor mode's light loop runs probe + fastFiltered together. Sized as sum of both cadence needs.",
      breakdown: {
        probeWorkers: workersNeeded.probe,
        fastFilteredWorkers: workersNeeded.fastFiltered,
      },
    },
    {
      key: "POLARIS_HEAVY_CONCURRENCY",
      need: workersNeeded.telemetry + workersNeeded.systemInfo,
      current: currentEnv.POLARIS_HEAVY_CONCURRENCY,
      rationale: "Cursor mode's heavy loop runs telemetry + systemInfo together. Sized as sum of both cadence needs.",
      breakdown: {
        telemetryWorkers: workersNeeded.telemetry,
        systemInfoWorkers: workersNeeded.systemInfo,
      },
    },
  ];
  for (const lever of cursorWorkerLevers) {
    const recommended = Math.max(lever.need, lever.current);
    recommendations.push({
      key: lever.key,
      applyMode: "env",
      current: lever.current,
      recommended,
      rationale: lever.rationale,
      breakdown: lever.breakdown,
      changeRequired: recommended > lever.current,
      appliesAfterQueueModeFlip: activeMode === "pgboss" && recommendedMode === "cursor",
    });
  }

  // ── Recommendation: Prisma + pg-boss pool ─────────────────────────────
  const prismaCurrent = currentEnv.DATABASE_POOL_SIZE;
  const prismaRecommended = roundUpToNearest(Math.max(prismaTarget, prismaCurrent), POOL_ROUNDING);
  recommendations.push({
    key: "DATABASE_POOL_SIZE",
    applyMode: "env",
    current: prismaCurrent,
    recommended: prismaRecommended,
    rationale: peakPrismaFloor > modeledPrismaTarget
      ? processCount > 1
        ? `Sized to keep observed peak below 80% pool utilization — peak demand (group-wide ${peakObserved}, ~${Math.ceil(peakPerProcess)}/process across ${processCount} processes) currently exceeds the worker-count model.`
        : "Sized to keep observed peak below 80% pool utilization — peak demand currently exceeds the worker-count model."
      : "Sized to cover the worker ceiling plus discovery reserve plus HTTP/job overhead.",
    breakdown: {
      workerCeiling,
      discoveryReserve,
      httpOverhead: HTTP_JOB_OVERHEAD,
      modeledTarget: modeledPrismaTarget,
      peakObserved,
      peakPerProcess: Math.ceil(peakPerProcess),
      processCount,
      peakPrismaFloor,
      target: prismaTarget,
    },
    changeRequired: prismaRecommended > prismaCurrent,
  });
  const pgbossCurrent = currentEnv.POLARIS_PGBOSS_POOL_SIZE;
  // Never shrink. Recommend the scaled `pgbossTarget` (sized to worker count
  // above) unless the operator has already configured something larger.
  const pgbossRecommended = roundUpToNearest(Math.max(pgbossTarget, pgbossCurrent), POOL_ROUNDING);
  recommendations.push({
    key: "POLARIS_PGBOSS_POOL_SIZE",
    applyMode: "env",
    current: pgbossCurrent,
    recommended: pgbossRecommended,
    rationale:
      pgbossTarget > PGBOSS_POOL_TARGET
        ? `Sized to ${Math.round(PGBOSS_POOL_WORKER_FRACTION * 100)}% of the ${workerCeiling}-worker ceiling so simultaneous boss.complete()/fail() bursts don't queue on pg-boss's internal pool.`
        : "Pg-boss queue ops are fast and multiplex many workers onto few connections — the 20-conn floor is plenty for this worker count.",
    breakdown: {
      workerCeiling,
      workerFraction: PGBOSS_POOL_WORKER_FRACTION,
      floor: PGBOSS_POOL_TARGET,
      target: pgbossTarget,
    },
    changeRequired: pgbossRecommended > pgbossCurrent,
    appliesAfterQueueModeFlip: activeMode === "cursor" && recommendedMode === "pgboss",
  });

  // ── Recommendation: max_connections (advisory-only) ───────────────────
  const maxConnectionsCurrent = snapshot.database.connectionPool.maxConnections || null;
  recommendations.push({
    key: "PG_MAX_CONNECTIONS",
    applyMode: "advisory-only",
    current: maxConnectionsCurrent,
    recommended: recommendedMax,
    rationale: processCount > 1
      ? `Set max_connections so the Polaris group (web + ${monitorReplicas} monitor + discovery = ${processCount} processes, ${perProcessPool} conns each) sits at ${Math.round(POLARIS_FRACTION_OF_MAX * 100)}% of max. Requires a PostgreSQL restart.`
      : `Set max_connections so Polaris's combined pool sits at ${Math.round(POLARIS_FRACTION_OF_MAX * 100)}% of max. Requires a PostgreSQL restart.`,
    breakdown: {
      polarisNeeded,
      peakObserved,
      polarisFloor,
      perProcessPool,
      processCount,
      monitorReplicas,
      polarisFraction: POLARIS_FRACTION_OF_MAX,
      rounding: MAX_CONNECTIONS_ROUNDING,
    },
    changeRequired: maxConnectionsCurrent !== null && recommendedMax > maxConnectionsCurrent,
  });

  // ── Recommendation: PG tuning (advisory-only) ────────────────────────
  recommendations.push({
    key: "PG_SHARED_BUFFERS",
    applyMode: "advisory-only",
    current: pgTuning.sharedBuffers.current,
    recommended: pgTuning.sharedBuffers.recommended,
    rationale: "25% of host RAM, minimum 128 MB. Requires a PostgreSQL restart.",
    changeRequired: pgTuning.sharedBuffers.changeRequired,
    operatorOverride: pgTuning.sharedBuffers.operatorOverride,
  });
  recommendations.push({
    key: "PG_EFFECTIVE_CACHE_SIZE",
    applyMode: "advisory-only",
    current: pgTuning.effectiveCacheSize.current,
    recommended: pgTuning.effectiveCacheSize.recommended,
    rationale: "75% of host RAM, minimum 256 MB. Requires a PostgreSQL reload.",
    changeRequired: pgTuning.effectiveCacheSize.changeRequired,
    operatorOverride: pgTuning.effectiveCacheSize.operatorOverride,
  });
  recommendations.push({
    key: "PG_WORK_MEM",
    applyMode: "advisory-only",
    current: pgTuning.workMem.current,
    recommended: pgTuning.workMem.recommended,
    rationale: "RAM/128, capped at 256 MB, minimum 32 MB. Requires a PostgreSQL reload.",
    changeRequired: pgTuning.workMem.changeRequired,
    operatorOverride: pgTuning.workMem.operatorOverride,
  });
  recommendations.push({
    key: "PG_RANDOM_PAGE_COST",
    applyMode: "advisory-only",
    current: pgTuning.randomPageCost.current,
    recommended: pgTuning.randomPageCost.recommended,
    rationale: "1.1 on SSD. Requires a PostgreSQL reload.",
    changeRequired: pgTuning.randomPageCost.changeRequired,
    operatorOverride: pgTuning.randomPageCost.operatorOverride,
  });

  const anyChangeRequired = recommendations.some((r) => r.changeRequired);
  const restartRequired = recommendations.some(
    (r) => r.changeRequired && (r.applyMode === "env" || r.applyMode === "queue-mode-endpoint"),
  );
  const usingColdStartDefaults = Object.values(cadence).some((c) => c.usedDefault);

  return {
    computedAt: new Date().toISOString(),
    usingColdStartDefaults,
    cadenceSamples: cadence,
    recommendations,
    anyChangeRequired,
    restartRequired,
    activeQueueMode: activeMode,
    recommendedQueueMode: recommendedMode,
    handlerTimeoutSec,
    handlerTimeoutPressure,
  };
}

/**
 * Read the per-queue `expire_seconds` from `pgboss.queue` so the advisor sees
 * what's actually in effect — not just what `EXPIRE_BY_QUEUE` in queueService.ts
 * would write on a fresh install. In cursor mode the queues don't exist yet and
 * every cadence comes back null; that's fine, the advisor just skips the
 * timeout-pressure check.
 */
async function readQueueTimeouts(): Promise<Record<CadenceKey, number | null>> {
  const out: Record<CadenceKey, number | null> = {
    probe: null, fastFiltered: null, telemetry: null, systemInfo: null,
    lldp: null, storage: null,
  };
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; expire_seconds: number | bigint }>>(
      `SELECT name, expire_seconds FROM pgboss.queue WHERE name = ANY($1::text[])`,
      Object.values(QUEUE_NAMES),
    );
    const reverse: Record<string, CadenceKey> = {};
    for (const c of Object.keys(QUEUE_NAMES) as CadenceKey[]) {
      reverse[QUEUE_NAMES[c]] = c;
    }
    for (const r of rows) {
      const c = reverse[r.name];
      if (c) out[c] = Number(r.expire_seconds);
    }
  } catch (err: any) {
    // Most common reason: pgboss schema doesn't exist yet (cursor-mode-only
    // installs, fresh DB before first pgboss boot). Debug-level so it doesn't
    // spam logs on those installs.
    logger.debug({ err: err?.message }, "capacityAdvisor: pgboss.queue read failed; handler timeout context unavailable");
  }
  return out;
}

// ─── Snapshot-driven recompute ─────────────────────────────────────────────

function readEnvInt(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

async function readIntegrationBreakdown(): Promise<IntegrationBreakdown> {
  const rows = await prisma.integration.findMany({
    where: { enabled: true },
    select: { type: true, config: true },
  });
  const out: IntegrationBreakdown = {
    fortimanagerProxy: 0,
    fortimanagerDirectParallelismSum: 0,
    fortigate: 0,
    entra: 0,
    activedirectory: 0,
    windowsserver: 0,
    vcenter: 0,
    azurearc: 0,
    workload: 0,
  };
  for (const r of rows) {
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    if (r.type === "fortimanager") {
      const useProxy = cfg.useProxy !== false; // default true
      if (useProxy) {
        out.fortimanagerProxy += 1;
      } else {
        const parallel = Number(cfg.discoveryParallelism ?? 5);
        out.fortimanagerDirectParallelismSum += Number.isFinite(parallel) ? Math.max(1, Math.min(parallel, 20)) : 5;
      }
    } else if (r.type === "fortigate") {
      out.fortigate += 1;
    } else if (r.type === "entraid") {
      out.entra += 1;
    } else if (r.type === "activedirectory") {
      out.activedirectory += 1;
    } else if (r.type === "windowsserver") {
      out.windowsserver += 1;
    } else if (r.type === "vcenter") {
      out.vcenter += 1;
    } else if (r.type === "azurearc") {
      out.azurearc += 1;
    } else if (isWorkloadPlatform(r.type)) {
      out.workload = (out.workload ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Reads the per-cadence applicable counts from the same SQL conventions used
 * by capacityService.projectSteadyStateSize: probe = monitored, telemetry +
 * systemInfo exclude managed FortiSwitches/APs on REST API, fastFiltered =
 * assets with at least one pin (interface / storage / ipsec tunnel).
 *
 * `fastFiltered` mirrors the gate in `jobs/monitorAssets.ts:236` —
 * `publishMonitorJob("fastFiltered", a.id, …)` fires once per ASSET (not per
 * pin) when `hasFastPin` is true. Counting `monitoredInterfaceCount` (the
 * sum of pin-array lengths across all assets) is wrong because an operator
 * who pins 12 ports on one switch produces 12 interface pins but only 1
 * fast-cadence job per tick. Diff is small on fleets with 1 pin per asset
 * but compounds badly when operators pin heavily — surfaced an over-sized
 * worker recommendation on the prod fleet at 2,080 assets × ~1 pin each.
 */
async function readApplicableCounts(snap: CapacitySnapshot): Promise<Record<CadenceKey, number>> {
  const monitored = snap.workload.monitoredAssetCount;
  const telemetryRow = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("cpuMemoryPolling" IS NULL OR "cpuMemoryPolling" = 'rest_api')
      )
  `);
  const systemInfoRow = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND NOT (
        "assetType" IN ('switch', 'access_point')
        AND ("interfacesPolling" IS NULL OR "interfacesPolling" = 'rest_api')
      )
  `);
  // Mirrors `hasFastPin` from src/jobs/monitorAssets.ts: any of the three
  // pin arrays non-empty. array_length(col, 1) returns NULL for an empty
  // array in Postgres, so COALESCE to 0 before the > 0 test.
  const fastRow = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND (
        COALESCE(array_length("monitoredInterfaces", 1), 0) > 0
        OR COALESCE(array_length("monitoredStorage", 1), 0) > 0
        OR COALESCE(array_length("monitoredIpsecTunnels", 1), 0) > 0
      )
  `);
  // Phase 2 carve-out applicability:
  //   - LLDP: monitored AND lldpPolling resolves to a non-null non-"disabled"
  //     method. The resolver does the actual fallthrough; this SQL counts the
  //     conservative case where the asset's own column is set to something
  //     truthful. Approximates the publisher's gate well enough for sizing.
  //   - Storage: monitored AND storagePolling = 'snmp' at any tier. Same
  //     conservative approximation.
  const lldpRow = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND ("lldpPolling" IS NOT NULL AND "lldpPolling" <> 'disabled')
  `);
  const storageRow = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
    SELECT COUNT(*)::bigint AS count FROM "assets"
    WHERE monitored = true
      AND "storagePolling" = 'snmp'
  `);
  return {
    probe:        monitored,
    fastFiltered: Number(fastRow[0]?.count ?? 0),
    telemetry:    Number(telemetryRow[0]?.count ?? monitored),
    systemInfo:   Number(systemInfoRow[0]?.count ?? monitored),
    lldp:         Number(lldpRow[0]?.count ?? 0),
    storage:      Number(storageRow[0]?.count ?? 0),
  };
}

export interface PgTuningExternal {
  sharedBuffers: PgRecommendation;
  effectiveCacheSize: PgRecommendation;
  workMem: PgRecommendation;
  randomPageCost: PgRecommendation;
}

/**
 * Build the advisor state from a capacity snapshot. The caller (capacityWatch
 * job + route handler) provides pgTuning current/recommended values via the
 * existing buildPgRecommended() path so we don't duplicate that logic.
 */
export async function recomputeAdvisorFromSnapshot(
  snap: CapacitySnapshot,
  pgTuning: PgTuningExternal,
): Promise<AdvisorState> {
  const [cadenceObs, integrations, applicable, handlerTimeoutSec] = await Promise.all([
    observeCadences(),
    readIntegrationBreakdown(),
    readApplicableCounts(snap),
    readQueueTimeouts(),
  ]);

  const inputs: AdvisorInputs = {
    snapshot: snap,
    integrations,
    cadence: cadenceObs,
    cadenceIntervals: {
      probe:        snap.workload.cadences.responseTimeSec,
      fastFiltered: snap.workload.cadences.responseTimeSec,
      telemetry:    snap.workload.cadences.telemetrySec,
      systemInfo:   snap.workload.cadences.systemInfoSec,
      // Phase 2 carve-out cadences default to systemInfo's interval — the
      // resolver inherits there at the floor and operators tune via the
      // per-class subtabs. capacityService.workload.cadences doesn't carry
      // LLDP / Storage cadences yet; using systemInfo's value matches what
      // a fresh install actually runs at.
      lldp:         snap.workload.cadences.systemInfoSec,
      storage:      snap.workload.cadences.systemInfoSec,
    },
    handlerTimeoutSec,
    applicable,
    currentEnv: {
      DATABASE_POOL_SIZE:                readEnvInt("DATABASE_POOL_SIZE", 25),
      POLARIS_PGBOSS_POOL_SIZE:          readEnvInt("POLARIS_PGBOSS_POOL_SIZE", 20),
      POLARIS_MONITOR_PROBE_WORKERS:     readEnvInt("POLARIS_MONITOR_PROBE_WORKERS", 24),
      POLARIS_MONITOR_FAST_WORKERS:      readEnvInt("POLARIS_MONITOR_FAST_WORKERS", 24),
      POLARIS_MONITOR_HEAVY_WORKERS:     readEnvInt("POLARIS_MONITOR_HEAVY_WORKERS", 24),
      POLARIS_MONITOR_LLDP_WORKERS:      readEnvInt("POLARIS_MONITOR_LLDP_WORKERS", 12),
      POLARIS_MONITOR_STORAGE_WORKERS:   readEnvInt("POLARIS_MONITOR_STORAGE_WORKERS", 12),
      POLARIS_MONITOR_FLOATING_WORKERS:  readEnvInt("POLARIS_MONITOR_FLOATING_WORKERS", 32),
      POLARIS_PROBE_CONCURRENCY:         readEnvInt("POLARIS_PROBE_CONCURRENCY", 16),
      POLARIS_HEAVY_CONCURRENCY:         readEnvInt("POLARIS_HEAVY_CONCURRENCY", 8),
    },
    pgTuning,
  };

  const state = buildAdvisorState(inputs);
  cachedState = state;
  cachedAt = Date.now();
  void recordAdvisorTransition(state);
  return state;
}

// ─── Cache ─────────────────────────────────────────────────────────────────

let cachedState: AdvisorState | null = null;
let cachedAt = 0;

export function getCachedAdvisorState(): AdvisorState | null {
  if (!cachedState) return null;
  if (Date.now() - cachedAt > ADVISOR_CACHE_TTL_MS) return null;
  return cachedState;
}

// ─── Summary for capacityService reasons ──────────────────────────────────

export interface AdvisorGapSummary {
  workersUndersized: boolean;
  poolUndersized: boolean;
  maxConnectionsUndersized: boolean;
  /** Brief text naming the worst worker gap, for the reason message. */
  worstGap?: string;
  /** Cadences whose observed p90 has climbed toward the pg-boss handler
   *  timeout cap. Copied from AdvisorState; non-empty drives the
   *  `monitor_handler_timeout_pressure` watch reason in capacityService. */
  handlerTimeoutPressure?: HandlerTimeoutPressure[];
}

/** Levers that only apply in cursor mode. Excluded from gap rollups when
 *  recommendedQueueMode is pgboss (and vice versa) so a pgboss-active install
 *  doesn't surface "POLARIS_HEAVY_CONCURRENCY undersized" — that lever does
 *  nothing in pgboss mode. Mirrors the UI's _advisorRecommendationsForView. */
const CURSOR_ONLY_LEVERS = new Set<AdvisorLeverKey>([
  "POLARIS_PROBE_CONCURRENCY",
  "POLARIS_HEAVY_CONCURRENCY",
]);
const PGBOSS_ONLY_LEVERS = new Set<AdvisorLeverKey>([
  "POLARIS_PGBOSS_POOL_SIZE",
  "POLARIS_MONITOR_PROBE_WORKERS",
  "POLARIS_MONITOR_FAST_WORKERS",
  "POLARIS_MONITOR_HEAVY_WORKERS",
  "POLARIS_MONITOR_LLDP_WORKERS",
  "POLARIS_MONITOR_STORAGE_WORKERS",
  "POLARIS_MONITOR_FLOATING_WORKERS",
]);

/** Distill the advisor state down to the flags capacityService.computeReasons needs. */
export function summarizeAdvisorGaps(state: AdvisorState): AdvisorGapSummary {
  const out: AdvisorGapSummary = {
    workersUndersized: false,
    poolUndersized: false,
    maxConnectionsUndersized: false,
  };
  const recommendedMode = state.recommendedQueueMode;
  let worstGapDelta = 0;
  let worstGapText = "";
  for (const r of state.recommendations) {
    if (!r.changeRequired) continue;
    // Skip levers that don't apply to the recommended queue mode — the UI
    // hides them, and so should the rollup that drives the watch reason.
    if (recommendedMode === "pgboss" && CURSOR_ONLY_LEVERS.has(r.key)) continue;
    if (recommendedMode === "cursor" && PGBOSS_ONLY_LEVERS.has(r.key)) continue;
    if (
      r.key === "POLARIS_MONITOR_PROBE_WORKERS" ||
      r.key === "POLARIS_MONITOR_FAST_WORKERS" ||
      r.key === "POLARIS_MONITOR_HEAVY_WORKERS" ||
      r.key === "POLARIS_MONITOR_LLDP_WORKERS" ||
      r.key === "POLARIS_MONITOR_STORAGE_WORKERS" ||
      r.key === "POLARIS_MONITOR_FLOATING_WORKERS" ||
      r.key === "POLARIS_PROBE_CONCURRENCY" ||
      r.key === "POLARIS_HEAVY_CONCURRENCY"
    ) {
      out.workersUndersized = true;
      const cur = typeof r.current === "number" ? r.current : 0;
      const rec = typeof r.recommended === "number" ? r.recommended : 0;
      const delta = rec - cur;
      if (delta > worstGapDelta) {
        worstGapDelta = delta;
        worstGapText = `${r.key.replace(/^POLARIS_(MONITOR_)?/, "").toLowerCase()} (${cur} → ${rec})`;
      }
    }
    if (r.key === "DATABASE_POOL_SIZE" || r.key === "POLARIS_PGBOSS_POOL_SIZE") {
      out.poolUndersized = true;
    }
    if (r.key === "PG_MAX_CONNECTIONS") {
      out.maxConnectionsUndersized = true;
    }
  }
  if (worstGapText) out.worstGap = worstGapText;
  if (state.handlerTimeoutPressure.length > 0) {
    out.handlerTimeoutPressure = state.handlerTimeoutPressure;
  }
  return out;
}

// ─── Transition Event ─────────────────────────────────────────────────────

interface StoredAdvisorTransition {
  anyChangeRequired: boolean;
  recordedAt: string;
}

async function readStoredChangeRequired(): Promise<boolean | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: LAST_CHANGE_REQUIRED_SETTING_KEY } });
    if (!row) return null;
    const v = row.value as Partial<StoredAdvisorTransition> | null;
    if (!v || typeof v.anyChangeRequired !== "boolean") return null;
    return v.anyChangeRequired;
  } catch {
    return null;
  }
}

async function writeStoredChangeRequired(value: boolean): Promise<void> {
  const stored: StoredAdvisorTransition = { anyChangeRequired: value, recordedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: LAST_CHANGE_REQUIRED_SETTING_KEY },
    update: { value: stored as any },
    create: { key: LAST_CHANGE_REQUIRED_SETTING_KEY, value: stored as any },
  });
}

async function recordAdvisorTransition(state: AdvisorState): Promise<void> {
  try {
    const prior = await readStoredChangeRequired();
    if (prior === state.anyChangeRequired) return;
    // Only emit an Event when the rollup flag flips — avoids per-tick spam.
    // Routed through logEvent so Setting.eventRetention.minLevel applies
    // (info-only event; operators with minLevel >= warning won't see this).
    await logEvent({
      action: "capacity_advisor.recomputed",
      resourceType: "system",
      actor: "system",
      level: "info",
      message: state.anyChangeRequired
        ? `Capacity Advisor: one or more settings now below recommended.`
        : `Capacity Advisor: all settings at or above recommended.`,
      details: {
        recommendations: state.recommendations
          .filter((r) => r.changeRequired)
          .map((r) => ({ key: r.key, current: r.current, recommended: r.recommended })),
      },
    });
    await writeStoredChangeRequired(state.anyChangeRequired);
  } catch (err: any) {
    logger.debug({ err: err?.message }, "capacityAdvisor: recordAdvisorTransition failed");
  }
}

// ─── Stage (apply selected recommendations) ───────────────────────────────

const ENV_KEY_MAP: Partial<Record<AdvisorLeverKey, string>> = {
  DATABASE_POOL_SIZE:               "DATABASE_POOL_SIZE",
  POLARIS_PGBOSS_POOL_SIZE:         "POLARIS_PGBOSS_POOL_SIZE",
  POLARIS_MONITOR_PROBE_WORKERS:    "POLARIS_MONITOR_PROBE_WORKERS",
  POLARIS_MONITOR_FAST_WORKERS:     "POLARIS_MONITOR_FAST_WORKERS",
  POLARIS_MONITOR_HEAVY_WORKERS:    "POLARIS_MONITOR_HEAVY_WORKERS",
  POLARIS_MONITOR_LLDP_WORKERS:     "POLARIS_MONITOR_LLDP_WORKERS",
  POLARIS_MONITOR_STORAGE_WORKERS:  "POLARIS_MONITOR_STORAGE_WORKERS",
  POLARIS_MONITOR_FLOATING_WORKERS: "POLARIS_MONITOR_FLOATING_WORKERS",
  POLARIS_PROBE_CONCURRENCY:        "POLARIS_PROBE_CONCURRENCY",
  POLARIS_HEAVY_CONCURRENCY:        "POLARIS_HEAVY_CONCURRENCY",
};

export type StageStatus = "applied" | "skipped" | "error";

export interface StageResult {
  key: AdvisorLeverKey;
  status: StageStatus;
  oldValue: string | null;
  newValue: string | null;
  reason?: string;
}

export interface StageReceipt {
  ok: boolean;
  results: StageResult[];
  restartRequired: boolean;
}

/**
 * Apply selected lever recommendations.
 *
 * - `applyMode === "env"`: write `setEnvVar(envName, recommended)` to `.env`.
 *   Takes effect at next Polaris restart. Errors return `status: "error"`.
 * - `applyMode === "queue-mode-endpoint"`: call `setQueueMode()` directly.
 *   Same path the existing `POST /server-settings/queue-mode` route uses.
 * - `applyMode === "advisory-only"`: skip with reason `"advisory-only"`.
 *
 * Server picks values from a fresh advisor recompute — never trusts client-
 * provided values. This means `Stage` isn't a generic env-write endpoint.
 */
export async function stageAdvisorState(
  keys: AdvisorLeverKey[],
  freshState: AdvisorState,
): Promise<StageReceipt> {
  const results: StageResult[] = [];
  const byKey = new Map(freshState.recommendations.map((r) => [r.key, r]));
  for (const key of keys) {
    const r = byKey.get(key);
    if (!r) {
      results.push({ key, status: "error", oldValue: null, newValue: null, reason: "unknown lever key" });
      continue;
    }
    if (r.applyMode === "advisory-only") {
      results.push({
        key,
        status: "skipped",
        oldValue: r.current !== null ? String(r.current) : null,
        newValue: String(r.recommended),
        reason: "advisory-only — requires PostgreSQL restart",
      });
      continue;
    }
    if (!r.changeRequired) {
      results.push({
        key,
        status: "skipped",
        oldValue: r.current !== null ? String(r.current) : null,
        newValue: String(r.recommended),
        reason: "already at or above recommended",
      });
      continue;
    }
    try {
      if (r.applyMode === "queue-mode-endpoint") {
        const mode = String(r.recommended) as "cursor" | "pgboss";
        if (mode !== "cursor" && mode !== "pgboss") {
          throw new AppError(500, `invalid queue mode: ${mode}`);
        }
        if (mode === "pgboss" && !isPgbossInstalled()) {
          throw new AppError(409, "pg-boss is not installed in this build");
        }
        await setQueueMode(mode);
        results.push({
          key,
          status: "applied",
          oldValue: r.current !== null ? String(r.current) : null,
          newValue: String(r.recommended),
        });
      } else if (r.applyMode === "env") {
        const envName = ENV_KEY_MAP[key];
        if (!envName) throw new AppError(500, `no env mapping for ${key}`);
        setEnvVar(envName, String(r.recommended));
        results.push({
          key,
          status: "applied",
          oldValue: r.current !== null ? String(r.current) : null,
          newValue: String(r.recommended),
        });
      }
    } catch (err: any) {
      results.push({
        key,
        status: "error",
        oldValue: r.current !== null ? String(r.current) : null,
        newValue: String(r.recommended),
        reason: err?.message ?? String(err),
      });
    }
  }
  const restartRequired = results.some((r) => r.status === "applied");
  return { ok: results.every((r) => r.status !== "error"), results, restartRequired };
}

export const __testing = {
  HISTOGRAM_BUCKETS,
  PER_CADENCE_FLOOR,
  FLOATING_FLOOR,
  SAFETY_FACTOR,
  HTTP_JOB_OVERHEAD,
  PGBOSS_POOL_TARGET,
  POLARIS_FRACTION_OF_MAX,
  MAX_CONNECTIONS_ROUNDING,
  POOL_ROUNDING,
  PGBOSS_RECOMMEND_ASSETS,
};
