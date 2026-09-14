# Release notes — Monitoring scale work

> **Historical record — two statements below have since been superseded.**
> TimescaleDB stopped being optional on **2026-09-11**: every install path now
> provisions it and the setup scripts fail without it (`docs/INSTALL.md` →
> *Required: TimescaleDB*). The `pgboss_recommended` alert and its inline
> "Enable on next restart" button were folded into the Capacity Advisor's
> queue-mode lever and no longer exist. The rest stands as written.

Window: this release bundles ~17 commits across two phases of monitoring-stack work plus four post-deploy hotfixes. Code touched the cursor queue, persistence layer, and most discovery write paths. Rough scope: ~3,500 lines across four schema migrations.

## TL;DR for the operator

- **Apply the update normally via the in-app updater** (Server Settings → Maintenance → Updates). Migrations run automatically.
- **Re-enter the FortiManager API tokens** in the integration edit modal (both the `apiToken` and `fortigateApiToken` fields). The pre-existing masked-secret save bug had poisoned them with literal bullet characters. Fixed in this release.
- **TimescaleDB is recommended but optional.** Polaris detects it at boot; if absent, the Maintenance tab will eventually surface a `timescale_recommended` alert when sample tables exceed 1 GB. See `docs/INSTALL.md` for the install steps.
- **pg-boss is bundled but inactive by default.** The Maintenance tab will surface a `pgboss_recommended` alert when monitored asset count crosses 500; click [Enable on next restart] to switch.
- **/metrics endpoint is live** (open by default; gate via `METRICS_TOKEN` for public deployments). Starter Grafana dashboard JSON: `docs/grafana/polaris-monitoring-dashboard.json`.

## Required actions

| # | Action | Why |
|---|---|---|
| 1 | Apply the update | Schema migrations + new behavior |
| 2 | Re-enter FMG `apiToken` AND `fortigateApiToken` in the integration edit modal | Pre-existing save bug poisoned both with the masked-display sentinel; this release fixes the bug but can't recover the original value |
| 3 | (Optional) install TimescaleDB | Storage compression + chunk-drop prune. See `docs/INSTALL.md` → "Recommended: TimescaleDB" |
| 4 | (Optional) wire your Prometheus to `/metrics` | Visibility into pass duration, queue depth, probe latency |

## Phase 1 — foundation

### Cadence drift fix (the original pain point)

Previously: `monitorAssets.ts` used a single `TICK_MS = 5_000` loop with `if (running) return`. When one slow systemInfo call (up to 75 s on a wedged FortiOS host) blocked the pass, every subsequent tick was dropped until the pass completed. Effective probe cadence stretched to 7+ minutes.

Now: two independent ticking loops with separate `running` guards.

- **Light loop** (probe + fastFiltered) ticks every 5 s, default concurrency `cpus().length × 2` (clamped 8..64), env-overridable via `POLARIS_PROBE_CONCURRENCY`
- **Heavy loop** (telemetry + systemInfo) ticks every 30 s, default `cpus().length` (clamped 4..32), env-overridable via `POLARIS_HEAVY_CONCURRENCY`. Daily sample-retention prune lives here too.

A wedged systemInfo on dead hosts now blocks ONLY future heavy ticks. Probes keep firing on their own clock.

### Prometheus metrics endpoint

`GET /metrics` exposes:

- Default Node.js process / GC / event-loop metrics (un-prefixed so standard Grafana dashboards work)
- `polaris_monitor_pass_duration_seconds` — pass wall-clock histogram
- `polaris_monitor_work_duration_seconds{cadence}` — per-cadence work duration histogram
- `polaris_monitor_work_total{cadence,outcome}` — work outcomes counter
- `polaris_monitor_queue_depth{cadence}` — items queued at start of pass
- `polaris_probe_duration_seconds{transport}` — per-probe RTT
- `polaris_probe_total{transport,outcome}` — per-transport outcomes
- `polaris_monitored_assets` / `polaris_monitored_assets_by_status{status}` — fleet gauges

Optional Bearer-token gate via `METRICS_TOKEN` env var (mirrors `/health`).

### TimescaleDB integration (detect-and-degrade)

If the `timescaledb` extension is installed at boot, Polaris automatically:
- Converts the six monitoring sample tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_temperature_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`) to hypertables
- Migrates existing rows in place via `create_hypertable(migrate_data => TRUE)` — brief lock during conversion, sub-second on small tables, longer on large ones
- Enables column compression with `compress_segmentby = "assetId"` + `compress_orderby = "timestamp" DESC`
- Adds a compression policy with the `TIMESCALE_COMPRESS_AFTER_DAYS` window (default 7)
- Prune layer becomes `drop_chunks(...)` instead of `deleteMany` (instant chunk drops, no seq-scan)

If absent, Polaris stays on plain-Postgres prune. The Maintenance tab surfaces a `timescale_recommended` alert when sample tables exceed 1 GB. Suggestion text adapts via deployment-context heuristics — local-DB shops get install instructions, remote/managed shops get DBA-coordination guidance, container shops get `docker-compose` advice.

Schema change required for hypertable conversion: the six sample tables now use composite PKs `(id, timestamp)`. Same columns, same client queries — the codebase never used findUnique on these tables.

### Connection pool sizing

`DATABASE_POOL_SIZE` env var (default 25) lets operators raise the pg pool above the @prisma/adapter-pg default of 10. With monitor workers + HTTP request handlers + background jobs all pulling from the pool, 10 was undersized at any meaningful scale.

### Composite index

`@@index([monitored, monitorType, lastMonitorAt])` on `assets` covers the runMonitorPass candidate query (`WHERE monitored = true AND monitorType IS NOT NULL`). The existing `(monitored, lastMonitorAt)` index is preserved.

### pg-boss queue (opt-in)

A second monitor queue implementation, optional. The cursor queue (Phase 1 above) handles small/medium fleets fine. pg-boss becomes recommended once the fleet crosses 500 monitored assets — the Maintenance tab surfaces a `pgboss_recommended` alert with an [Enable on next restart] button. Click writes `Setting.monitor.queueMode = "pgboss"`; the running process keeps its boot-time mode, the new mode takes effect at next restart.

When active, pg-boss runs four queues — `polaris-monitor-probe` / `polaris-monitor-fastfiltered` / `polaris-monitor-telemetry` / `polaris-monitor-systeminfo` — each with its own `localConcurrency` (env-overridable: `POLARIS_MONITOR_PROBE_WORKERS` / `_FAST_WORKERS` / `_HEAVY_WORKERS`). `policy: "exclusive"` + per-asset singletonKey gives natural coalescing.

## Phase 2 — per-write optimizations

### B7: parallelize FortiOS REST calls within a collection

`collectSystemInfoFortinet` previously did 5 sequential `fgRequest` calls (cmdb interface → monitor interface → ipsec phase1 cmdb → ipsec monitor → lldp). Now fans out as one `Promise.all` over four streams. Healthy host: 3-5× wall-clock reduction. Wedged host: 75 s → 15 s.

### B8: normalize associatedIps to side table

Replaces the legacy `Asset.associatedIps` JSONB column with `AssetAssociatedIp` rows. The system-info persist now does a single delete-non-manual + createMany in one `$transaction` instead of read-modify-write of the JSON. API surface unchanged: list/get response continues to expose `associatedIps: [...]` as a JSON array.

### B9: single-roundtrip ipHistory upsert

The Prisma extension `recordIpHistory` was findUnique + (update | create) — two round-trips per Asset write that touched ipAddress. Replaced with one `INSERT ... ON CONFLICT` statement.

### B10: batch LLDP persist

`persistLldpNeighbors` did 1 fetch + N per-row upserts + 1 deleteMany. For a switch with 40 LLDP neighbors that was 42 round-trips per system-info pass. Now: createMany (new neighbors) + `$transaction(updates)` + deleteMany. Three round-trips total.

### B11: exponential backoff on chronic-down hosts

A confirmed-down host previously got probed every 60 s forever. Now bucketed by `consecutiveFailures`:

| consecutiveFailures (down) | Probe interval |
|---|---|
| ≤ 10 | max(base, 5 min) |
| ≤ 30 | max(base, 15 min) |
| > 30 | max(base, 30 min) |

`max(base, ...)` so operators with deliberately long intervals don't get probes accelerated. The first successful probe resets `consecutiveFailures` to 0 and the asset returns to base cadence — recovery detected within at most 30 min.

### B12: normalize macAddresses to side table

Same pattern as B8, applied to `Asset.macAddresses`. Replaces the JSONB column with `AssetMacAddress` rows. Discovery code (FMG / FortiGate DHCP, device-inventory, Intune, conflict ghost-merge) hydrates `asset.macAddresses` from rows on load, modifies in JS as before, then calls `reconcileMacAddresses(assetId, macs)` after the asset.update lands.

The reconcile uses a single bulk `INSERT ... ON CONFLICT` statement (sorted by mac for deadlock-resistance) plus retry-on-deadlock. API surface unchanged: list/get continues to expose `macAddresses: [...]` JSON, sorted by lastSeen desc.

## Phase 3 partial — C16 (bulk operations)

### bulk-monitor: single updateMany

`POST /assets/bulk-monitor` previously did N sequential `prisma.asset.update` calls — 1000 assets ≈ 10 s blocking. Now one `updateMany` lands the change in one round-trip regardless of selection size. Validates the body once up-front; per-asset errors collapse to "id not in DB."

### Phase 11 projection: bulk source fetch

The fortigate-endpoint projection re-pass previously did N `assetSource.findMany` calls (one per touched endpoint). Now a single bulk findMany over the whole touched set + Map-based dispatch in JS.

## Hotfixes during this deploy

These were caught + fixed during the deploy itself:

1. **Maintenance tab 500** — `pg_total_relation_size(quote_ident(relname))` failed once pg-boss installed its `pgboss.version` table because `quote_ident` produces unqualified relation names that Postgres tries to resolve via search_path. Fixed by filtering `pg_stat_user_tables` to `schemaname = 'public'`.
2. **Masked-secret save bug** (pre-existing, surfaced when discovery resumed) — the integration edit modal echoed back `"••••••••"` for sensitive fields, and the save handler's falsy-only check (`!input.config.apiToken`) let the bullets through as the literal token. Fixed with an `isMaskedSecretSentinel()` helper; operators must re-enter affected tokens once.
3. **MAC reconcile transaction timeouts** — `reconcileMacAddresses` wrapped delete + N upserts in `$transaction`; with 50 batchSettled workers in parallel each holding a transaction, the connection pool saturated and individual transactions exceeded Prisma's 5-second default. Replaced with a single bulk `INSERT ... ON CONFLICT` SQL statement.
4. **MAC reconcile deadlocks** — concurrent reconciles contended on the secondary `mac` index pages. Sorted VALUES by mac for deterministic lock ordering + retry-on-40P01 absorbs the residual.

## Verification checklist

After applying the update, walk through:

- [ ] Maintenance tab loads (was failing pre-update for any deploy that enabled pg-boss)
- [ ] FMG integration discovery completes without ByteString errors (re-enter both tokens first)
- [ ] Maintenance tab → Database card shows TimescaleDB status: "Enabled (6 hypertables)" if Timescale installed, "Not installed" otherwise
- [ ] Maintenance tab → Database card shows Monitor queue: "Cursor (pg-boss installed, not active)" until you flip via the recommendation alert
- [ ] `curl -s http://localhost:3000/metrics | head -20` returns Prometheus text
- [ ] `nodejs_eventloop_lag_p99_seconds` < 0.05 under normal load
- [ ] After a discovery cycle, no `40P01` or `Transaction API error` in journal logs
- [ ] Asset details panel still shows MAC and associated-IP entries (relation-backed but same JSON shape)

## Operational reference

| Need to... | Where |
|---|---|
| See pass duration trend | Grafana dashboard → Cadence health row |
| Check event-loop health | Grafana dashboard → Process health row, or `curl /metrics \| grep nodejs_eventloop_lag` |
| Tune probe concurrency | `POLARIS_PROBE_CONCURRENCY` / `POLARIS_HEAVY_CONCURRENCY` env vars |
| Tune pg-boss worker count | `POLARIS_MONITOR_PROBE_WORKERS` / `_FAST_WORKERS` / `_HEAVY_WORKERS` env vars (only consulted when queueMode is pgboss) |
| Switch to pg-boss queue | Maintenance tab → recommendation alert → [Enable on next restart], then restart Polaris |
| Switch back to cursor | Same alert flips to [Cancel — stay on cursor] until restart, OR manually `UPDATE settings SET value = '{"mode":"cursor"}' WHERE key = 'monitor.queueMode'` |
| Tune Timescale compression window | `TIMESCALE_COMPRESS_AFTER_DAYS` env var (default 7) |
| See pruned chunk count | Polaris doesn't surface this; query `SELECT * FROM timescaledb_information.chunks WHERE hypertable_name = 'asset_monitor_samples'` |

## What's NOT in this release (deferred)

- **C13** — Piscina worker pool for SNMP packet decode. Skipped because event-loop p99 measured 15 ms on prod; threshold to bother is 50-100 ms.
- **C14** — TimescaleDB compression policy refinement. The default 7-day window is reasonable for the scale tested.
- **C15** — Horizontal poller tier (multi-process workers). Not needed below 5K monitored assets.

These items remain in the backlog and can be picked up if specific pain emerges.
