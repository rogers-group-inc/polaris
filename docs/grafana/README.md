# Polaris Grafana dashboard

`polaris-monitoring-dashboard.json` is the Grafana dashboard for the Prometheus metrics Polaris exposes at `/metrics`. It covers:

- **Fleet overview** — monitored asset count, status breakdown (up / down / unknown), probe success rate, probe rate per second
- **Cadence health** — monitor pass duration p50/p95/p99, queue depth by cadence, work outcome rates
- **Probe latency by transport** — p95 by `monitorType` (fortimanager / fortigate / snmp / winrm / ssh / icmp / activedirectory) plus per-transport rate split by outcome
- **Process health** — Node.js event-loop lag (p99 + mean), RSS / heap memory, CPU usage
- **Capacity & growth** — overall capacity severity pill, DB pool (current / peak / capacity / max), DB pool % utilization with thresholds, current DB size vs projected steady-state, disk free ratio per volume, dead-tuple ratio per sample table
- **Throughput & queue health** — pg-boss oldest job age per queue, sample-write p95 per table, discovery duration p95 by integration type, discovery rate by integration + outcome
- **HTTP latency** — p95 by route (top 10), in-flight gauge, request rate by status class
- **Job health** — duration p95 per scheduled job, failure rate per job
- **Integration connection tester** — per-tick auto-test outcome rate (success / failure / skipped) by integration_type, from the 10-min `integrationConnectionTester` job. A run of `failure` ticks without a `success` follow-up explains an integration that stayed in the Failed state across multiple ticks; `skipped` is the in-discovery-run branch.
- **Monitor work duration** — p95 sliced by cadence, by transport, and by cadence × asset_type (same histogram the Capacity Advisor reads to recommend worker counts)
- **FMG worker** — per-integration queue depth, proxy-lane inflight (the strict-concurrency=1 lane), native-lane inflight (CMDB / dvmdb / auth)
- **Write buffers & rollups** — pg-boss queue jobs by queue × state, sample rollup p95 by tier × table, sample buffer depth per table, probe-patch buffer depth + write p95
- **Discovery phases** — per-phase p95 wall-clock by integration type × phase (top 20)
- **Boot-time config snapshot** — queue mode (cursor vs pgboss), DB connection mode (direct vs pgbouncer), workers per cadence queue, DB pool role capacity by `POLARIS_ROLE`
- **Process crashes** — `increase(polaris_process_crash_total[1h])` by role × kind, plus a 24h total stat that is red above zero. Emitted by the last-resort `unhandledRejection` / `uncaughtException` handlers immediately before the process exits, so the counter dies with the process and any single scrape reads 0 or 1 — the signal is the restart, which is what `increase()` shows. Steady state is a flat zero. A non-zero bar means a role died and systemd's `Restart=on-failure` brought it back; the structured fatal line naming the origin is in `journalctl -u polaris-<role>`. Repeating bars are a crash loop, which is otherwise invisible outside journald.
- **Active-instance guard** — refused boots by heartbeat holder (1h) plus a 24h total stat, from `polaris_ha_active_instance_conflict_total`. Read a bar as the guard WORKING: a second app instance was pointed at this database and was stopped, not admitted. Same dies-with-the-process reading as Process crashes, with one extra caveat — the refusing process exits immediately, so a scrape can miss the increment: a non-zero `increase()` is definitive, its absence is not. `POLARIS_HA_HEARTBEAT=off` disables the guard and therefore this row.
- **Path checks** — agent-run path-check results ingested per minute by outcome, and a 1h path-change stat, from `polaris_agent_path_check_samples_total` / `polaris_path_check_path_changes_total` (business rule 85). A rising `fail` line is the fleet reporting unreachable targets; a sustained `rejected` line is an agent running a stale check list.
- **Controller link sweep** — controller reads by outcome and a 1h link-change stat, from `polaris_fortilink_controller_read_total` / `polaris_fortilink_transition_total` (business rule 59: does each FortiGate still hold a FortiLink session to its switches, a CAPWAP tunnel to its APs). The `failure` line is the one to watch, and it is a SILENT failure — the sweep refuses to write anything for a controller it cannot read, so those devices hold their last link state and no alert can fire. A sustained failure rate means link alerting is dark for that controller's fleet, not that its links are healthy; cross-check the Integration connection tester row.

## Prerequisites

1. Polaris running with the metrics endpoint reachable. By default `/metrics` is open; if you've set `METRICS_TOKEN` in `.env`, your Prometheus scrape config needs a matching `Authorization: Bearer <token>` header.
2. A Prometheus instance scraping Polaris.

A minimal Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: polaris
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:3000']
    # Uncomment if METRICS_TOKEN is set:
    # bearer_token: '<your-METRICS_TOKEN-value>'
```

### Multi-process (split-role) deployments

In the split-role layout (`polaris-web` + `polaris-monitor@N` + `polaris-discovery`) **prom-client registries are per-process**. The web process exposes `/metrics` on its main HTTPS listener; the monitor and discovery processes each boot a standalone HTTP `/metrics` listener (see [src/utils/metricsServer.ts](../../src/utils/metricsServer.ts)). The shipped systemd units default to:

| Role | Port | Bind | File |
|---|---|---|---|
| `web` (and `all` / single-process) | main HTTPS port (3000) | as configured | served by the Express app |
| `monitor` instance `N` | `910N` (9101, 9102, …) | `127.0.0.1` | `deploy/polaris-monitor@.service` |
| `discovery` | `9110` | `127.0.0.1` | `deploy/polaris-discovery.service` |

Prometheus must scrape **every** role endpoint or the dashboard will show "no data" for any metric stamped from inside a monitor worker (`polaris_probe_*`, `polaris_monitor_work_duration_seconds`, `polaris_sample_write_duration_seconds`, write/probe-patch buffer depths) or discovery consumer (`polaris_discovery_*`, FMG proxy lane). Dashboard queries aggregate across instances — `sum` for per-process partitions (db_pool, sample buffers, monitor workers) and `max` for fleet-wide gauges that one process broadcasts (monitored asset counts, capacity severity, disk/DB size, FMG worker depth, queue/mode flags). Histograms wrapped in `rate(...) + sum by (...)` were already correct; the bare-gauge panels were patched in the same change. Example for two monitor replicas + a discovery worker, all on the same host as Prometheus:

```yaml
scrape_configs:
  - job_name: polaris-web
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:3000']
    # bearer_token: '<METRICS_TOKEN>'

  - job_name: polaris-monitor
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:9101', '127.0.0.1:9102']
        labels: { polaris_role: monitor }
    # bearer_token: '<METRICS_TOKEN>'

  - job_name: polaris-discovery
    metrics_path: /metrics
    static_configs:
      - targets: ['127.0.0.1:9110']
        labels: { polaris_role: discovery }
    # bearer_token: '<METRICS_TOKEN>'
```

The same `METRICS_TOKEN` from `.env` gates every role endpoint. If Prometheus runs on a different host from the workers, set `POLARIS_METRICS_BIND=0.0.0.0` per-process and adjust the target addresses; the units pin `127.0.0.1` by default so the metrics endpoint isn't world-reachable.

### Behind nginx (Phase 1 nginx-front mode — recommended for off-host Prometheus)

If you've run `deploy/migrate-to-nginx.sh` (see [docs/UPGRADING.md](../UPGRADING.md#migrating-an-existing-install-to-the-nginx-front-end)), nginx terminates TLS on 443 and path-routes the four metrics endpoints to the localhost-bound listeners. This is the **cleanest setup for off-host Prometheus**: one bearer-over-TLS scrape job per role, all targeting the same `polaris.example.com:443`, no firewall rules for 9101/9102/9110, no plain-HTTP bearer travel.

```yaml
scrape_configs:
  - job_name: polaris-web
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:443']
    bearer_token: '<METRICS_TOKEN>'

  - job_name: polaris-monitor
    scheme: https
    metrics_path: /metrics-monitor-1
    static_configs:
      - targets: ['polaris.example.com:443']
        labels: { polaris_role: monitor, polaris_instance: "1" }
    bearer_token: '<METRICS_TOKEN>'

  # Per-instance jobs because the nginx config has one location per replica.
  # Add more (/metrics-monitor-2, etc.) for additional polaris-monitor@N units.
  - job_name: polaris-monitor-2
    scheme: https
    metrics_path: /metrics-monitor-2
    static_configs:
      - targets: ['polaris.example.com:443']
        labels: { polaris_role: monitor, polaris_instance: "2" }
    bearer_token: '<METRICS_TOKEN>'

  - job_name: polaris-discovery
    scheme: https
    metrics_path: /metrics-discovery
    static_configs:
      - targets: ['polaris.example.com:443']
        labels: { polaris_role: discovery }
    bearer_token: '<METRICS_TOKEN>'
```

The reference nginx config (`deploy/nginx/polaris.conf`) already IP-allowlists each `/metrics-*` location to the Prometheus host (`allow <PROMETHEUS_IP>; deny all;`) so even without the bearer there's no public read-access. HTTP/3 is advertised via `Alt-Svc`; Prometheus itself uses HTTP/2 over TCP, so the QUIC listener isn't on the scrape path.

### Docker Compose

The shipped `docker-compose.yml` already wires `POLARIS_METRICS_PORT=9101` on the `monitor` service and `9110` on `discovery`, both bound `0.0.0.0` (per-container — replicas share the port because each has its own network namespace). Prometheus running on the same Docker network reaches them by container name:

```yaml
scrape_configs:
  - job_name: polaris-web
    static_configs: [ { targets: ['polaris-web:3000'] } ]
  - job_name: polaris-monitor
    static_configs:
      - targets: ['polaris-monitor-1:9101', 'polaris-monitor-2:9101']
        labels: { polaris_role: monitor }
  - job_name: polaris-discovery
    static_configs:
      - targets: ['polaris-discovery:9110']
        labels: { polaris_role: discovery }
```

## Importing

In Grafana → **Dashboards → New → Import**:

1. Click **Upload JSON file** and pick `polaris-monitoring-dashboard.json`
2. When prompted, select your Prometheus datasource for the `DS_PROMETHEUS` variable
3. Click **Import**

## Customizing

- **Refresh interval** — default 30 s. Change in the dashboard time-picker if you want faster or slower updates.
- **Time range** — default last 1 hour. Set to "last 24h" if you're investigating a longer-running pattern.
- **Thresholds** — the event-loop lag panel marks 50 ms as yellow and 100 ms as orange. These match the operational ranges Polaris is tuned for (15 ms p99 measured on a production fleet of roughly 1,800 monitored assets). Adjust for your environment if needed.

## Reading the dashboard

The single most important panel for cadence health is **Monitor pass duration** (p99 line specifically). If it's hovering well below your configured `monitor.intervalSeconds` (default 60 s), the worker pool has headroom. If p99 is climbing toward — or past — the cadence interval, the publisher is producing work faster than the pool can drain it; expect cadence drift and consider raising worker concurrency (`POLARIS_PROBE_CONCURRENCY` / `POLARIS_HEAVY_CONCURRENCY`) or switching to the pg-boss queue (Maintenance tab → recommendation alert).

For per-transport investigation, the **Probe duration p95 by transport** panel separates the fortinet / snmp / winrm / ssh / icmp paths so you can see if one specific integration is slow without it polluting the overall probe-duration line.

> Two panels in the **Cadence health** row are cursor-mode only by design and will stay "no data" on pg-boss installs: **Monitor pass duration p50/p95/p99** (`polaris_monitor_pass_duration_seconds` is observed inside `runMonitorPass`, which pg-boss mode skips in favor of `publishDueWork`) and **Queue depth by cadence** (`polaris_monitor_queue_depth` is only set by the cursor path). On pg-boss installs, read **Pg-boss oldest job age** + **pg-boss queue jobs by queue × state** under "Throughput & queue health" / "Write buffers & rollups" instead. The third panel in that row — **Work item rate by cadence + outcome** — works in both modes.

For bottleneck spotting at scale, the four most actionable panels are:

1. **DB pool utilization** (peak / capacity) under "Capacity & growth" — when the line approaches 1, the app is about to stall at pool acquisition. Crank `DATABASE_POOL_SIZE` / `POLARIS_PGBOSS_POOL_SIZE` (within the `polaris_db_pool_max` ceiling) before the next monitor pass tries to grab a connection.
2. **Pg-boss oldest job age** under "Throughput & queue health" — pg-boss-only. A queue with depth > 0 AND age climbing past 60 s = stalled worker. The watchdog auto-recovers within a minute, but the gauge confirms it happened.
3. **HTTP p95 by route (top 10)** under "HTTP latency" — climbing across all 10 ≈ DB pool exhausted (cross-check panel 1); climbing on one route = that handler is hanging on a slow downstream.
4. **Sample-write p95 by table** under "Throughput & queue health" — splits DB-write cost out of monitor work duration. If `asset_interface_samples` or `asset_lldp_neighbors` p95 is climbing, autovacuum is falling behind your insert rate; the dead-tuple-ratio panel confirms it.

For capacity planning, watch the gap between **current DB size** and **projected steady-state** (under "Capacity & growth") — that's your remaining growth runway at the current cadences and retention.

## Keeping the dashboard in sync with `/metrics`

The dashboard is intended to cover every `polaris_*` metric Polaris emits. When a metric is added, renamed, gains a label, or is removed, this JSON has to be updated in the same change — Prometheus itself picks up the new/dropped series automatically, but Grafana panel queries pin specific metric names and labels and will quietly go blank or break otherwise. The contract is encoded in [polaris-change-impact → cross-cutting/observability-metrics](../../.claude/skills/polaris-change-impact/references/cross-cutting/observability-metrics.md) under "When changing this."

The full list of Polaris-emitted metric names lives in [src/metrics.ts](../../src/metrics.ts); the helpers there also document what's recorded where.

## Adding more panels (out-of-process sources)

For data Polaris doesn't proxy — Postgres internals, host-level disk/CPU/memory beyond what `prom-client` defaults emit, network — point Prometheus at `postgres_exporter` / `node_exporter` and import a community Grafana dashboard alongside this one. There is no separate pg-boss dashboard: pg-boss has no built-in exporter, and the app-side view (`polaris_pgboss_queue_jobs`, `polaris_pgboss_oldest_job_age_seconds`) lives in the **Write buffers & rollups** + **Throughput & queue health** rows above.
