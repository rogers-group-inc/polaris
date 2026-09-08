/**
 * src/metrics.ts — Prometheus metrics registry + helpers
 *
 * Exposes a single Registry and a small surface of typed helper functions
 * so callers don't need to import metric objects directly. Default Node.js
 * process / event-loop metrics are registered here with no prefix so the
 * standard Node.js Grafana dashboards work without modification; everything
 * Polaris-specific is prefixed `polaris_`.
 *
 * Endpoint: GET /metrics on the main HTTP listener (mounted in `src/app.ts`).
 * Optional Bearer-token gate via the METRICS_TOKEN env var; when unset the
 * endpoint is open (mirroring the /health convention).
 */

import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// ─── Polaris-specific metrics ──────────────────────────────────────────────

const monitorPassDuration = new Histogram({
  name: "polaris_monitor_pass_duration_seconds",
  help: "Wall-clock duration of one runMonitorPass call.",
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 900],
  registers: [registry],
});

const monitorWorkDuration = new Histogram({
  name: "polaris_monitor_work_duration_seconds",
  help: "Wall-clock duration of a single monitor work item, by cadence, asset_type, and transport. `transport` is the resolved polling method for that cadence (probe=responseTimePolling, telemetry=telemetryPolling, systemInfo + fastFiltered=interfacesPolling); falls back to 'unknown' if the worker can't resolve it. Lets operators slice work duration by device-class × transport to find which combo is the bottleneck.",
  labelNames: ["cadence", "asset_type", "transport"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

const monitorWorkTotal = new Counter({
  name: "polaris_monitor_work_total",
  help: "Number of monitor work items processed, by cadence, asset_type, transport, and outcome.",
  labelNames: ["cadence", "asset_type", "transport", "outcome"] as const,
  registers: [registry],
});

const monitorQueueDepth = new Gauge({
  name: "polaris_monitor_queue_depth",
  help: "Queued monitor work items at the start of the pass, by cadence (cursor mode only).",
  labelNames: ["cadence"] as const,
  registers: [registry],
});

const probeDuration = new Histogram({
  name: "polaris_probe_duration_seconds",
  help: "Per-probe wall-clock duration, by transport.",
  labelNames: ["transport"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

const probeTotal = new Counter({
  name: "polaris_probe_total",
  help: "Number of probes by transport and outcome.",
  labelNames: ["transport", "outcome"] as const,
  registers: [registry],
});

const monitoredAssets = new Gauge({
  name: "polaris_monitored_assets",
  help: "Number of assets with monitored=true.",
  registers: [registry],
});

const monitoredAssetsByStatus = new Gauge({
  name: "polaris_monitored_assets_by_status",
  help: "Monitored assets grouped by current monitorStatus.",
  labelNames: ["status"] as const,
  registers: [registry],
});

// ─── Down detection (automation-owned) ──────────────────────────────────────
// The down-detection index resolves which automation defines "down" for each
// asset. It sits on the probe hot path, and a fleet with no covering automation
// is judged by nothing at all — so both its cost and its coverage are worth
// seeing. `passive` climbing is the signal that devices stopped being judged.

const downDetectionBuildDuration = new Histogram({
  name: "polaris_down_detection_build_seconds",
  help: "Time to rebuild the down-detection index (rule set x monitored fleet).",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const downDetectionAssets = new Gauge({
  name: "polaris_down_detection_assets",
  help: "Monitored assets by whether a down-detection automation covers them.",
  labelNames: ["coverage"] as const,
  registers: [registry],
});

const downDetectionUnavailable = new Counter({
  name: "polaris_down_detection_unavailable_total",
  help: "Times the down-detection index could not be built and every asset was treated as passive.",
  registers: [registry],
});

const pgbossQueueJobs = new Gauge({
  name: "polaris_pgboss_queue_jobs",
  help: "pg-boss job counts by queue and state (pg-boss mode only).",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

const monitorQueueModeGauge = new Gauge({
  name: "polaris_monitor_queue_mode",
  help: "Active monitor queue mode at boot (1 = this mode is running). Labels: mode=cursor|pgboss.",
  labelNames: ["mode"] as const,
  registers: [registry],
});

const monitorWorkers = new Gauge({
  name: "polaris_monitor_workers",
  help: "Configured worker count by cadence queue. Set once at boot from cpus().length + env-var overrides; static for the life of the process. In pg-boss mode this is each queue's localConcurrency. In cursor mode probe/fastFiltered map to the light-loop concurrency cap and telemetry/systemInfo map to the heavy-loop cap.",
  labelNames: ["queue"] as const,
  registers: [registry],
});

const fmgWorkerQueueDepth = new Gauge({
  name: "polaris_fmg_worker_queue_depth",
  help: "Queued FMG tasks awaiting dispatch on the per-integration single-consumer worker. FMG drops parallel API calls past 1-2 concurrent requests, so every FMG-bound code path (discovery, reservation push, quarantine push, manual proxy, test-connection) funnels through one worker per integration id.",
  labelNames: ["integrationId"] as const,
  registers: [registry],
});

const fmgWorkerInflight = new Gauge({
  name: "polaris_fmg_worker_inflight",
  help: "1 when the FMG worker's PROXY lane (strict concurrency=1) is currently executing a task; 0 when idle. Proxy lane carries every /sys/proxy/json call; FMG drops parallel proxy connections past 1-2 so this stays serialized by design.",
  labelNames: ["integrationId"] as const,
  registers: [registry],
});

const fmgWorkerNativeInflight = new Gauge({
  name: "polaris_fmg_worker_native_inflight",
  help: "Count of native FMG calls (CMDB, dvmdb, auth — anything that ISN'T /sys/proxy/json) currently in flight for this integration. Unbounded by design — native endpoints hit FMG's own DB and don't share the proxy concurrency constraint. Persistently high values indicate genuine native-call parallelism (good) rather than a bottleneck.",
  labelNames: ["integrationId"] as const,
  registers: [registry],
});

// ─── Capacity & connection pool (sourced from capacityService snapshots) ───

const dbPoolInUse = new Gauge({
  name: "polaris_db_pool_in_use",
  help: "Current active connections from this app to PostgreSQL, sampled from pg_stat_activity at every capacityWatch tick (10 min) and on every Maintenance-tab fetch.",
  registers: [registry],
});

const dbPoolPeakObserved = new Gauge({
  name: "polaris_db_pool_peak_observed",
  help: "Highest pg_stat_activity count this process has seen since boot. Module-local high-water mark; resets on restart.",
  registers: [registry],
});

const dbConnectionMode = new Gauge({
  name: "polaris_db_connection_mode",
  help: "DB connection topology Polaris detected at boot. 1 for the active mode; the other label stays at 0. `pgbouncer` = Polaris's application connections go through PgBouncer (DATABASE_URL points at it; POLARIS_DB_DIRECT_URL points at Postgres for pg-boss / pg_dump / pg_stat_activity). `direct` = single DATABASE_URL pointed straight at Postgres.",
  labelNames: ["mode"] as const,
  registers: [registry],
});

const dbPoolPolarisCapacity = new Gauge({
  name: "polaris_db_pool_polaris_capacity",
  help: "Combined Polaris-owned connection capacity = DATABASE_POOL_SIZE (Prisma) + POLARIS_PGBOSS_POOL_SIZE (pg-boss, if pg-boss mode is active). The ceiling above which the app stalls at pool acquisition.",
  registers: [registry],
});

const dbPoolMax = new Gauge({
  name: "polaris_db_pool_max",
  help: "PostgreSQL `SHOW max_connections` — the server-side ceiling shared with every other connection holder on the cluster.",
  registers: [registry],
});

const dbPoolRoleCapacity = new Gauge({
  name: "polaris_db_pool_role_capacity",
  help: "This process's configured Polaris connection capacity (Prisma DATABASE_POOL_SIZE + pg-boss POLARIS_PGBOSS_POOL_SIZE when this process opens a pg-boss pool), labeled by POLARIS_ROLE. Stamped once at boot. In a multi-process deployment, sum this across role series (and over monitor-replica instances) for the group's true footprint against max_connections — no single process sees the whole group.",
  labelNames: ["role"] as const,
  registers: [registry],
});

/** Stamp this process's configured pool capacity under its role label. */
export function setDbPoolRoleCapacity(role: string, capacity: number): void {
  dbPoolRoleCapacity.labels(role).set(capacity);
}

const capacitySeverity = new Gauge({
  name: "polaris_capacity_severity",
  help: "Overall capacity severity: 0=ok, 1=watch, 2=warning, 3=critical. Mirrors the Maintenance-tab pill and the sidebar critical-alert state.",
  registers: [registry],
});

const diskFreeRatio = new Gauge({
  name: "polaris_disk_free_ratio",
  help: "Free-space ratio (0..1) per filesystem Polaris/Postgres write to. Volumes are pre-deduped by stat.dev so a single-LV install shows one entry. The `roles` label is comma-joined from {app, state, backups, db}.",
  labelNames: ["volume", "roles"] as const,
  registers: [registry],
});

const dbDeadTupleRatio = new Gauge({
  name: "polaris_db_dead_tuple_ratio",
  help: "Dead-tuple ratio (0..1) per monitored sample table. Sourced from pg_class.n_dead_tup / (n_live_tup + n_dead_tup). High values indicate autovacuum is falling behind the insert rate.",
  labelNames: ["table"] as const,
  registers: [registry],
});

const dbSizeBytes = new Gauge({
  name: "polaris_db_size_bytes",
  help: "Total Polaris database size in bytes (pg_database_size).",
  registers: [registry],
});

const dbSteadyStateSizeBytes = new Gauge({
  name: "polaris_db_steady_state_size_bytes",
  help: "Projected PEAK steady-state DB size at current cadences, retention, and monitored asset count — what the database grows to if nothing changes. Computed by capacityService from each sample table's measured daily byte-rate × its EFFECTIVE retention (configured window + one TimescaleDB chunk interval + one prune cycle, since drop_chunks reclaims a whole chunk at a time). Legitimately exceeds polaris_db_size_bytes while tables are still filling; it read BELOW it before the 2026-09 fix.",
  registers: [registry],
});

// ─── Pg-boss job age (oldest waiting job per queue × state) ───────────────

const pgbossOldestJobAge = new Gauge({
  name: "polaris_pgboss_oldest_job_age_seconds",
  help: "Age in seconds of the oldest pg-boss job in this queue × state. `state` is 'created' (queued, not yet picked up) or 'active' (being processed). Refreshed every 15s alongside polaris_pgboss_queue_jobs. Pg-boss mode only — stays at 0 in cursor mode.",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
});

// ─── Discovery duration ───────────────────────────────────────────────────

const discoveryDuration = new Histogram({
  name: "polaris_discovery_duration_seconds",
  help: "Wall-clock duration of an end-to-end discovery run, by integration type. Recorded once per completed run alongside the existing recordSample() that feeds the slow-run baseline.",
  labelNames: ["integration_type"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

const discoveryTotal = new Counter({
  name: "polaris_discovery_total",
  help: "Number of discovery runs by integration type and outcome (success | failure | aborted).",
  labelNames: ["integration_type", "outcome"] as const,
  registers: [registry],
});

const integrationTestTotal = new Counter({
  name: "polaris_integration_test_total",
  help: "Number of integrationConnectionTester ticks for each integration by outcome (success | failure | skipped). `skipped` is the in-discovery branch where the tester preserves prior lastTestAt/Ok to avoid stamping a false-positive failure on a healthy FMG during a discovery run; `failure` and `success` mirror the lastTestOk write. Watch sustained failures on one integration_type to spot a wedged credential or unreachable endpoint that the per-tick logger.info line in journalctl explains.",
  labelNames: ["integration_type", "outcome"] as const,
  registers: [registry],
});

const discoveryPhaseDuration = new Histogram({
  name: "polaris_discovery_phase_duration_seconds",
  help: "Wall-clock duration of one phase inside a discovery run. Observed at every phaseMark() transition in syncDhcpSubnets (FMG + standalone FortiGate). `phase` is the marker name used in code (e.g. '1', '2', '2a', '3b', '7.5', '13.5'). Always-on regardless of the integration's verboseLogging flag — the verbose log is the per-line journalctl story; this histogram is the bucketed-distribution story across many runs.",
  labelNames: ["integration_type", "phase"] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
  registers: [registry],
});

// ─── Sample-table write duration ─────────────────────────────────────────

const sampleWriteDuration = new Histogram({
  name: "polaris_sample_write_duration_seconds",
  help: "Wall-clock duration of a single bulk write into a monitor sample table. Splits DB-write cost out of the broader monitor work duration so a slow autovacuum / index bloat / lock contention is visible separately from network probe time.",
  labelNames: ["table"] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const sampleBufferDepth = new Gauge({
  name: "polaris_sample_buffer_depth",
  help: "Rows currently held in the in-memory write buffer for each monitor sample table. Oscillates between near-0 and the steady-state batch size between 2s flush ticks; a persistently rising value means the flush can't keep up with the enqueue rate.",
  labelNames: ["table"] as const,
  registers: [registry],
});

const probePatchWriteDuration = new Histogram({
  name: "polaris_probe_patch_write_duration_seconds",
  help: "Wall-clock duration of one bulk UPDATE flush from the probe-patch buffer. Splits the per-flush state-write cost out of the broader monitor-work duration so a slow DB write (lock contention, index bloat) is visible separately from network probe time. One observation per 2 s flush tick — a single observation covers state writes for many assets.",
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const probePatchBufferDepth = new Gauge({
  name: "polaris_probe_patch_buffer_depth",
  help: "Patches currently held in the in-memory probe-patch buffer. Oscillates between near-0 and the steady-state batch size between 2 s flush ticks; a persistently rising value means the flush can't keep up with the enqueue rate.",
  labelNames: ["table"] as const,
  registers: [registry],
});

const sampleRollupDuration = new Histogram({
  name: "polaris_sample_rollup_duration_seconds",
  help: "Wall-clock duration of one INSERT...ON CONFLICT rollup statement against a single source table. `tier` is hourly | daily; `table` is the logical source name (monitor / telemetry / temperature / interface / storage / ipsec). Hourly cadence runs every 30 minutes; daily runs once a day. Watch this to spot a rollup tick that starts dragging behind its cadence at fleet growth.",
  labelNames: ["tier", "table"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
  registers: [registry],
});

// ─── HTTP server ──────────────────────────────────────────────────────────

const httpRequestDuration = new Histogram({
  name: "polaris_http_request_duration_seconds",
  help: "HTTP request latency. `route` is the matched Express route template (e.g. /api/v1/assets/:id) so cardinality stays bounded; unmatched paths roll up to `unmatched`. `status_class` is one of 2xx / 3xx / 4xx / 5xx. /metrics and /health are excluded.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 5],
  registers: [registry],
});

const httpInFlight = new Gauge({
  name: "polaris_http_in_flight",
  help: "Number of HTTP requests currently being handled. Useful for spotting handler backpressure when the DB pool saturates or a route hangs.",
  registers: [registry],
});

// ─── Periodic-job execution ───────────────────────────────────────────────

const jobDuration = new Histogram({
  name: "polaris_job_duration_seconds",
  help: "Wall-clock duration of one tick of a scheduled background job. `job` label is the job's stable identifier (e.g. dependencyReconciler, capacityWatch, monitorAssets.probe). Lets you see when a tick starts taking longer than its interval — a lagging-job signal.",
  labelNames: ["job"] as const,
  buckets: [0.05, 0.5, 1, 5, 30, 60, 300, 900],
  registers: [registry],
});

const jobTotal = new Counter({
  name: "polaris_job_total",
  help: "Number of scheduled-job tick executions by job and outcome (success | failure).",
  labelNames: ["job", "outcome"] as const,
  registers: [registry],
});

// ─── Process crashes ──────────────────────────────────────────────────────
//
// Incremented by the last-resort handlers in src/index.ts immediately before
// the process exits. The counter itself dies with the process, so its value is
// always 0 or 1 in a single scrape — the operational signal is the *restart*:
// `increase(polaris_process_crash_total[1h])` across a role's instances turns
// an invisible systemd Restart=on-failure loop into a graph.

const processCrashTotal = new Counter({
  name: "polaris_process_crash_total",
  help: "Process terminations caused by an unhandled promise rejection or uncaught exception, labelled by role and kind. Scraped as 0 in a healthy process; a non-zero increase() over time means a role is crash-looping.",
  labelNames: ["role", "kind"] as const,
  registers: [registry],
});

// ─── Helpers ───────────────────────────────────────────────────────────────

export type Cadence = "probe" | "telemetry" | "systemInfo" | "fastFiltered" | "lldp" | "storage" | "processes" | "eventLog" | "lossSample";
export type WorkOutcome = "success" | "failure" | "crash";
export type ProbeOutcome = "success" | "failure";

export function startPassTimer(): () => number {
  return monitorPassDuration.startTimer();
}

export interface WorkLabels {
  /** Asset.assetType — one of the 8 AssetType enum values; "unknown" when the worker can't resolve. */
  assetType: string;
  /** Resolved per-cadence polling method (e.g. "rest_api", "snmp", "icmp"); "unknown" when not resolved. */
  transport: string;
}

export function startWorkTimer(cadence: Cadence, labels: WorkLabels): () => number {
  return monitorWorkDuration.startTimer({
    cadence,
    asset_type: labels.assetType,
    transport: labels.transport,
  });
}

export function recordWorkOutcome(
  cadence: Cadence,
  outcome: WorkOutcome,
  labels: WorkLabels,
): void {
  monitorWorkTotal.inc({
    cadence,
    outcome,
    asset_type: labels.assetType,
    transport: labels.transport,
  });
}

export function recordProbe(transport: string, durationSeconds: number, outcome: ProbeOutcome): void {
  probeDuration.observe({ transport }, durationSeconds);
  probeTotal.inc({ transport, outcome });
}

export function setMonitoredAssets(
  total: number,
  byStatus: { up: number; down: number; unknown: number; passive?: number },
): void {
  monitoredAssets.set(total);
  monitoredAssetsByStatus.set({ status: "up" }, byStatus.up);
  monitoredAssetsByStatus.set({ status: "down" }, byStatus.down);
  monitoredAssetsByStatus.set({ status: "unknown" }, byStatus.unknown);
  // Optional so a caller that predates the sixth state still compiles; passive
  // assets would otherwise land in `unknown` and read as "never probed".
  monitoredAssetsByStatus.set({ status: "passive" }, byStatus.passive ?? 0);
}

export function recordDownDetectionBuild(durationSeconds: number): void {
  downDetectionBuildDuration.observe(durationSeconds);
}

export function setDownDetectionAssets(covered: number, passive: number): void {
  downDetectionAssets.set({ coverage: "covered" }, covered);
  downDetectionAssets.set({ coverage: "passive" }, passive);
}

export function recordDownDetectionUnavailable(): void {
  downDetectionUnavailable.inc();
}

export function setQueueDepth(depths: Partial<Record<Cadence, number>>): void {
  if (depths.probe        !== undefined) monitorQueueDepth.set({ cadence: "probe" }, depths.probe);
  if (depths.fastFiltered !== undefined) monitorQueueDepth.set({ cadence: "fastFiltered" }, depths.fastFiltered);
  if (depths.telemetry    !== undefined) monitorQueueDepth.set({ cadence: "telemetry" }, depths.telemetry);
  if (depths.systemInfo   !== undefined) monitorQueueDepth.set({ cadence: "systemInfo" }, depths.systemInfo);
  if (depths.lldp         !== undefined) monitorQueueDepth.set({ cadence: "lldp" }, depths.lldp);
  if (depths.storage      !== undefined) monitorQueueDepth.set({ cadence: "storage" }, depths.storage);
  if (depths.processes    !== undefined) monitorQueueDepth.set({ cadence: "processes" }, depths.processes);
  if (depths.lossSample   !== undefined) monitorQueueDepth.set({ cadence: "lossSample" }, depths.lossSample);
}

export function setPgbossQueueJobs(queue: string, state: string, count: number): void {
  pgbossQueueJobs.set({ queue, state }, count);
}

export function recordQueueMode(mode: string): void {
  monitorQueueModeGauge.set({ mode }, 1);
}

/** Stamp the detected DB connection mode (one-shot, called once at boot). */
export function recordDbConnectionMode(mode: "direct" | "pgbouncer"): void {
  dbConnectionMode.reset();
  dbConnectionMode.set({ mode }, 1);
}

export function setMonitorWorkers(
  counts: Partial<Record<Cadence, number>> & { floating?: number },
): void {
  if (counts.probe        !== undefined) monitorWorkers.set({ queue: "probe" },        counts.probe);
  if (counts.fastFiltered !== undefined) monitorWorkers.set({ queue: "fastFiltered" }, counts.fastFiltered);
  if (counts.telemetry    !== undefined) monitorWorkers.set({ queue: "telemetry" },    counts.telemetry);
  if (counts.systemInfo   !== undefined) monitorWorkers.set({ queue: "systemInfo" },   counts.systemInfo);
  if (counts.lldp         !== undefined) monitorWorkers.set({ queue: "lldp" },         counts.lldp);
  if (counts.storage      !== undefined) monitorWorkers.set({ queue: "storage" },      counts.storage);
  if (counts.processes    !== undefined) monitorWorkers.set({ queue: "processes" },    counts.processes);
  if (counts.floating     !== undefined) monitorWorkers.set({ queue: "floating" },     counts.floating);
}

export function setFmgWorkerQueueDepth(integrationId: string, depth: number): void {
  fmgWorkerQueueDepth.set({ integrationId }, depth);
}

export function setFmgWorkerInflight(integrationId: string, value: 0 | 1): void {
  fmgWorkerInflight.set({ integrationId }, value);
}

export function setFmgWorkerNativeInflight(integrationId: string, count: number): void {
  fmgWorkerNativeInflight.set({ integrationId }, count);
}

export type Severity = "ok" | "watch" | "warning" | "critical";
const SEVERITY_VALUES: Record<Severity, number> = { ok: 0, watch: 1, warning: 2, critical: 3 };

export interface DbPoolGauges {
  currentInUse: number;
  peakObserved: number;
  prismaPoolSize: number;
  pgbossPoolSize: number | null;
  maxConnections: number;
}

export function setDbPoolGauges(p: DbPoolGauges): void {
  dbPoolInUse.set(p.currentInUse);
  dbPoolPeakObserved.set(p.peakObserved);
  dbPoolPolarisCapacity.set(p.prismaPoolSize + (p.pgbossPoolSize ?? 0));
  dbPoolMax.set(p.maxConnections);
}

export interface CapacityVolumeGauge {
  /** Stable label — first path resolved to this filesystem. */
  volume: string;
  /** Comma-joined role names (app, state, backups, db). */
  roles: string;
  freeBytes: number;
  totalBytes: number;
}

export interface CapacitySampleTableGauge {
  table: string;
  deadTupRatio: number;
}

export interface CapacityGauges {
  severity: Severity;
  volumes: CapacityVolumeGauge[];
  sampleTables: CapacitySampleTableGauge[];
  databaseSizeBytes: number;
  steadyStateSizeBytes: number;
}

export function setCapacityGauges(c: CapacityGauges): void {
  capacitySeverity.set(SEVERITY_VALUES[c.severity]);
  // Reset volume + table gauges before re-stamping. Volumes come and go when
  // operators add/remove mounts; sample tables can appear after a Timescale
  // migration — clearing leaves no orphan series with stale values.
  diskFreeRatio.reset();
  for (const v of c.volumes) {
    const ratio = v.totalBytes > 0 ? v.freeBytes / v.totalBytes : 0;
    diskFreeRatio.set({ volume: v.volume, roles: v.roles }, ratio);
  }
  dbDeadTupleRatio.reset();
  for (const t of c.sampleTables) {
    dbDeadTupleRatio.set({ table: t.table }, t.deadTupRatio);
  }
  dbSizeBytes.set(c.databaseSizeBytes);
  dbSteadyStateSizeBytes.set(c.steadyStateSizeBytes);
}

export function setPgbossJobAge(queue: string, state: string, ageSeconds: number): void {
  pgbossOldestJobAge.set({ queue, state }, ageSeconds);
}

export type DiscoveryOutcome = "success" | "failure" | "aborted";

export function recordDiscovery(
  integrationType: string,
  durationSeconds: number,
  outcome: DiscoveryOutcome,
): void {
  // Only record duration on success — failures/aborts have wildly different
  // durations and would skew the histogram. Counters fire for every outcome.
  if (outcome === "success" && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    discoveryDuration.observe({ integration_type: integrationType }, durationSeconds);
  }
  discoveryTotal.inc({ integration_type: integrationType, outcome });
}

export type IntegrationTestOutcome = "success" | "failure" | "skipped";

export function recordIntegrationTest(
  integrationType: string,
  outcome: IntegrationTestOutcome,
): void {
  integrationTestTotal.inc({ integration_type: integrationType, outcome });
}

export function observeDiscoveryPhase(
  integrationType: string,
  phase: string,
  durationSeconds: number,
): void {
  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    discoveryPhaseDuration.observe({ integration_type: integrationType, phase }, durationSeconds);
  }
}

export function startSampleWriteTimer(table: string): () => number {
  return sampleWriteDuration.startTimer({ table });
}

export function startSampleRollupTimer(tier: "hourly" | "daily", table: string): () => number {
  return sampleRollupDuration.startTimer({ tier, table });
}

export function setSampleBufferDepth(table: string, depth: number): void {
  sampleBufferDepth.set({ table }, depth);
}

export function startProbePatchWriteTimer(): () => number {
  return probePatchWriteDuration.startTimer();
}

export function setProbePatchBufferDepth(table: string, depth: number): void {
  probePatchBufferDepth.set({ table }, depth);
}

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export function statusToClass(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export function startHttpRequestTimer(): (
  method: string,
  route: string,
  statusClass: StatusClass,
) => number {
  const end = httpRequestDuration.startTimer();
  return (method, route, statusClass) => end({ method, route, status_class: statusClass });
}

export function incHttpInFlight(): void {
  httpInFlight.inc();
}

export function decHttpInFlight(): void {
  httpInFlight.dec();
}

export type JobOutcome = "success" | "failure";

export function startJobTimer(job: string): () => number {
  return jobDuration.startTimer({ job });
}

export function recordJobOutcome(job: string, outcome: JobOutcome): void {
  jobTotal.inc({ job, outcome });
}

export type CrashKind = "unhandled_rejection" | "uncaught_exception";

export function recordProcessCrash(role: string, kind: CrashKind): void {
  processCrashTotal.inc({ role, kind });
}

export interface HistogramBucketValue {
  labels: Record<string, string | number>;
  value: number;
  metricName?: string;
}

export interface HistogramValues {
  values: HistogramBucketValue[];
}

export async function getMonitorWorkHistogramValues(): Promise<HistogramValues> {
  const data = await monitorWorkDuration.get();
  return { values: data.values as HistogramBucketValue[] };
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
