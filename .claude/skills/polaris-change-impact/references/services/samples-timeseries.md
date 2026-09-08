# Services — samples, rollups, retention, TimescaleDB, capacity

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/capacityAdvisorService.ts

**What it owns:** Derives recommended worker counts, pool sizes, PostgreSQL settings, and queue mode from observable workload (monitored-asset count, per-cadence P90 work duration, integration load, observed peak connections, host RAM). Advisory by default; a Stage POST writes the env-driven levers.

**Public API:** `buildAdvisorState`, `recomputeAdvisorFromSnapshot`, `stageAdvisorState`, `summarizeAdvisorGaps`, `getCachedAdvisorState`, `percentile`, `roundUpToNearest`, `AdvisorState`, `AdvisorRecommendation`, `CadenceKey`, `AdvisorLeverKey`, `ApplyMode`

**Cross-service deps:** `prisma`, `AppError`, `setEnvVar`, monitor-work histogram reader (metrics), `queueService` (queue mode + names), `capacityService` (CapacitySnapshot), `logEvent`.

**Used by:** `src/api/routes/serverSettings.ts` (`GET /capacity-advisor`, `POST /capacity-advisor/stage`), `src/jobs/capacityWatch.ts` + `src/services/capacityService.ts` (`recomputeAdvisorFromSnapshot` in the capacity-watch loop).

**Invariants:**
- Never recommends shrinking — `changeRequired` only when recommended > current.
- Cold-start substitutes a fixed P90 when the work-duration histogram has too few samples.
- Handler-timeout-pressure fires when P90 approaches the pg-boss `expire_seconds` cap; some worker levers are blocked behind a queue-mode flip until restart.

**When changing this:**
- P90 math depends on the metric's histogram buckets — keep in sync with `src/metrics.ts`.
- PG tuning recommendations come from an external builder in `serverSettings.ts`; cadence intervals resolve through `capacityService.workload`.

---

## services/capacityDbIo.ts

**What it owns:** Pure disk-read-pressure rate math — samples `pg_stat_database.blk_read_time` and turns deltas into a normalized "backends continuously blocked in read()" rate, making the signal storage-medium-aware. Only meaningful when `track_io_timing = on`.

**Public API:** `deriveDbIoVerdict`, `DbIoReading`, `DbIoVerdict`, `MIN_IO_WINDOW_MS`, `IO_VERDICT_STALE_MS`, `DB_IO_WATCH_BACKENDS`, `DB_IO_WARNING_BACKENDS`

**Cross-service deps:** none.

**Used by:** `src/services/capacityService.ts` — reads the counter via Prisma, computes the verdict, and feeds watch-reason thresholds.

**Invariants:**
- First call or a window < `MIN_IO_WINDOW_MS` returns `measured:false` (don't alarm); a counter reset (current < prev) returns unmeasured.
- Rate = Δblk_read_time / Δelapsed; verdict goes stale after `IO_VERDICT_STALE_MS`.

**When changing this:**
- WATCH/WARNING backend thresholds are tunable module exports consumed by capacityService.

---

## services/capacityService.ts

**What it owns:** Capacity snapshot (host/DB/workload), severity grading (`ok` / `watch` / `warning` / `critical` — renamed from the legacy `red`/`amber` color vocabulary), reason codes + families for severity-collapse, Event emission on severity transition, and steady-state DB size projection. Also orchestrates the two-pass `getCapacitySnapshotWithAdvisor` helper that interleaves Capacity Advisor recompute with reason-building.

**Public API:** `getCapacitySnapshot`, `getCapacitySnapshotWithAdvisor`, `recordCapacityTransition`, `collapseReasonsByFamily`, `normalizeSeverity`, `isStaleVacuumTable`, `AUTOVACUUM_BLOAT_DEAD_TUP_RATIO`. The projection's arithmetic is exported as pure, separately-tested helpers — `projectSteadyStateSize`, `projectDetailBytes`, `effectiveRetentionDays` — and `SAMPLE_TABLES` (the per-table projection list) is exported so `tests/unit/timescaleTables.test.ts` can drift-guard it against `timescaleService.ALL_HYPERTABLE_CANDIDATES`. Disk-I/O rate math lives in the sibling `capacityDbIo.ts` (`deriveDbIoVerdict` + `DB_IO_WATCH_BACKENDS`/`DB_IO_WARNING_BACKENDS` thresholds) — split out so it's testable without this module's import graph.

**Cross-service deps:** `monitoringService` (cadences, retention), `timescaleService` (hypertable check), `queueService` (pg-boss installed, boot/persisted mode), `deploymentContext` (DB co-location), `capacityDbIo` (pure disk-I/O rate math), `capacityAdvisorService` (dynamic import in `getCapacitySnapshotWithAdvisor`; type-only the other direction to avoid runtime cycle).

**Used by:** `src/jobs/capacityWatch.ts — 10-min capacity check + Event emission`; `src/api/routes/serverSettings.ts — /pg-tuning, /capacity-advisor, /capacity-advisor/stage endpoints`. ~6 call sites.

**Invariants:**
- Severity tiers: **critical** = disk <10%, DB >50% of free disk, stale autovacuum >7d on sample table (Timescale hypertables exempt — append-only chunks legitimately don't autovacuum), projected >8× RAM; **warning** = disk 10–20%, projected >4× RAM, dead-tup >20%, pgTuningNeeded, max_connections_undersized (advisor-driven), db_io_pressure (avgBackendsBlockedOnDisk ≥ 2.0); **watch** = disk 20–30%, db_io_pressure (avgBackendsBlockedOnDisk ≥ 0.5 — measured disk-read wait from pg_stat_database.blk_read_time, guarded on DB > host RAM; replaced the old size-based ram_insufficient heuristic), track_io_timing_off (DB > RAM but track_io_timing off so wait can't be measured — own family `pg_io_timing`), db_pool_undersized (>=80% of pool capacity), monitor_workers_undersized (advisor-driven rollup), monitor_handler_timeout_pressure (advisor-driven; p90 ≥ 70% of `pgboss.queue.expire_seconds` on any monitor cadence), timescale_recommended (sample tables >1 GB, extension not installed), metrics_token_unset, health_token_unset; **ok** = none.
- Severity vocabulary was renamed from `red`/`amber` (color names) to `critical`/`warning` (severity descriptors) to match the user-facing pill labels. `normalizeSeverity()` accepts either vocabulary on read so back-compat with persisted `Setting.capacity.lastSeverity` rows + cached browser snapshots stays clean during rollout. Frontend pill labels and CSS class names still use the color vocab (`capacity-pill-red`, etc.) — they're tied to the actual color, not the severity name; `_capacitySeverityCssClass(s)` maps severity → CSS suffix in `public/js/server-settings.js`.
- **Family-based severity collapse**: each reason carries an optional `family: string` tag. `collapseReasonsByFamily()` groups by family, keeps only the highest-severity entry per family, and concatenates suppressed reasons' `suggestion` text onto the winner (deduped by exact trimmed equality, prefixed `Also:`). Reasons without a family pass through unchanged — they're standalone concerns with no overlapping siblings. Families currently in use: `disk:db`, `disk:<role-set>`, `db_ram`, `pg_io_timing`, `autovacuum`, `timescale`, `db_pool`, `monitor_workers`, `monitor_handlers`, `db_max_connections`, `pg_tuning`, `metrics_token`, `health_token`. Different volumes (DB / app / state / backups) get their own family — they're independently actionable.
- The collapse pass is what makes the Maintenance card legible: the Critical "projected database growth exceeds free space" used to render alongside a redundant Watch "27% free" about the same volume; now the Watch is suppressed and its suggestion ("Watch the trend; expand before it crosses 20%") gets appended to the Critical's suggestion as "Also:". Same for `db_ram` family — the Warning "exceeds 4× host RAM" (projected growth) absorbs the lower-severity `db_io_pressure` watch about the same DB-vs-RAM concern. (`track_io_timing_off` is deliberately in its own `pg_io_timing` family so the "enable measurement" hint is never collapsed away by a growth warning.)
- Legacy `pgboss_recommended` / `pgboss_overdue` / `pgboss_pending` reasons were absorbed into the Capacity Advisor's QUEUE_MODE lever and no longer fire. The advisor's per-lever recommendations are the source of truth for queue-mode advice.
- Advisor-driven reasons (`monitor_workers_undersized`, `max_connections_undersized`, `monitor_handler_timeout_pressure`) only fire when callers pass `advisor` gap data into `computeReasons`. `getCapacitySnapshot` with `advisor: undefined` skips them; `getCapacitySnapshotWithAdvisor` builds the gaps and re-runs the snapshot in pass 2. `monitor_handler_timeout_pressure` carries per-cadence pressure entries lifted from `AdvisorState.handlerTimeoutPressure`, which the advisor populates by reading live `pgboss.queue.expire_seconds` values and comparing to observed histogram p90.
- Reason codes are unique per condition — `projected_exceeds_disk` (critical) and `projected_approaches_disk` (warning, >75%) compare *additional growth needed* (`max(0, steadyState - currentDbSize)`) against free disk on the DB volume, not the steady-state total — the bytes already on disk are part of the steady-state total but aren't future growth, so double-counting them was firing critical prematurely. Codes are deliberately distinct so transition Events stay distinguishable.
- **Message wording convention**: `<Subject> <state> (<metric context>). <Action>.` — subject is a noun phrase, state is an active-voice verb, parenthetical carries concrete metrics (numbers + units), action is an imperative one-sentence remediation. The collapse pass relies on the action being self-contained so concatenated "Also:" lines read naturally. Don't break the pattern when adding new reasons.
- Volumes deduped by `stat.dev` so single-LV box = one entry, STIG RHEL with separate /var = two.
- **Steady-state projection = `baseBytes` + projected sample bytes, where `baseBytes` = live DB size − the measured bytes of capacityService's OWN `SAMPLE_TABLES` list.** That subtraction is the load-bearing part: a managed hypertable missing from the list is not merely unprojected — its bytes stay in `baseBytes` and are carried into the answer at face value, so the figure TRACKS the live database size instead of forecasting it. `asset_service_log_samples` did exactly that at 13 GB of an 89 GB prod database (2026-09) after being added to `timescaleService.STANDALONE_SAMPLE_TABLES` without a projection entry. Guarded by `tests/unit/timescaleTables.test.ts`, which parses the actual list entries (a mention in a comment does not satisfy it) and demands an explicit `PROJECTION_EXEMPT` justification.
- **Per-table projection, in preference order.** DETAIL + standalone tiers: the MEASURED daily byte-rate (`measureDetailDailyBytes` → median of per-chunk `bytes ÷ ELAPSED days` over recent uncompressed chunks) × effective retention. Fallback for the tiered tables is the workload model (`count × rows/day/asset × CALIBRATED DEFAULT_BYTES_PER_ROW`); the standalone tables have no cadence row model, so their fallback is the table's current size — neutral, since it cancels their own contribution to `baseBytes`. Rollup tiers (hourly/daily) stay on the workload model, being mostly compressed at steady state. The per-row size is ALWAYS the calibrated default, never the live-measured `avgBytesPerRow` (relpages ÷ pg_stat tuples — unreliable on compressed/bloated hypertables; using it produced phantom 14–218 TB steady-states, 2026-06).
- **Retention is `configured + chunkInterval + pruneCadence`, and the projection is a PEAK.** `drop_chunks` reclaims a whole chunk at a time, only once all of it is past the cutoff, and only when the 24 h prune next runs. Only interface/storage/ipsec get `set_chunk_time_interval` (1 day); every other sample table sits on TimescaleDB's default 7 days, so prod's 7-day detail window held 12.58 days and its 3-day window up to 11. Pure helper `effectiveRetentionDays`. Modelling the configured number alone is what put the card 18 GB BELOW the live size (2026-09). Because it is a peak, the figure LEGITIMATELY exceeds current size while tables are still filling — do not "fix" that back.
- **The compression gate reads the CONFIGURED window; the multiplier reads the effective one.** Both the compression policy and the retention policy fire off a chunk's `range_end` plus their own window, so chunk slack changes how long data sits on disk but not which policy reaches the chunk first. Gating on the widened number silently kicks every 7d-retention/7d-compress detail table onto the workload guess — i.e. onto the fallback, on the largest tables in the database.
- A table whose detail retention is SHORTER than its chunk interval only ever has ONE chunk, whose `range_end` is in the future — which is why the daily-rate measurement uses each chunk's ELAPSED span and counts the currently-filling chunk. The predecessor "settled chunk" filter (`range_end` older than 24 h) matched nothing for those tables and sent them to the workload guess permanently; on prod that was `asset_hardware_sensor_samples`, 15 GB and the second-largest table.
- Sample table rows-per-asset-per-day (the fallback model): conservative defaults (e.g., asset_monitor_samples = 86400/intervalSeconds) when no samples yet.
- Connection-pool peak tracking: rolling high-water across all snapshots (resets on process restart); captured before snapshot read so it reflects current state.
- Transition logic: compare new severity to stored severity; emit Event only on change; Severity → Event level: critical→error, warning/watch→warning, ok→info.
- recordCapacityTransition() is best-effort (errors logged at debug, never thrown).

**When changing this:**
- Test volume dedup on multi-LV layouts (separate /var/lib/pgsql and /app).
- Verify the steady-state projection doesn't underestimate — and check RETENTION first, not the row rate. The 2026-09 18 GB shortfall was `effectiveRetentionDays` (chunk granularity), while `DEFAULT_ROWS_PER_ASSET_PER_DAY` is only the fallback for tables that can't be measured. A projection sitting BELOW the live database size is the signature of this class of bug: it means something is being carried through `baseBytes` rather than forecast.
- Adding a managed hypertable → add it to `SAMPLE_TABLES` here in the same change (`countKey: null` for a standalone table with no per-asset cadence), or the drift guard fails.
- Check connection-pool peak doesn't reset unexpectedly (module-local state should survive across route calls).
- Confirm Event emission only fires once per severity change (no duplicate "critical" events on each tick).
- Test fallback PG data directory candidates on RHEL/Windows when `SHOW data_directory` fails (non-superuser app role).
- When adding a new reason, ALWAYS pick a `family` if it overlaps with any existing reason about the same concern — otherwise both reasons render side-by-side and re-introduce the noise the collapse pass was built to fix. Reasons that are genuinely orthogonal (no overlap) leave `family` undefined.
- Stick to the `<Subject> <state> (<metric>). <Action>.` wording pattern when adding reasons; the collapse pass concatenates suggestions across family members and the result reads poorly if one reason's suggestion ends mid-sentence or carries the metric inside the action.

---

## services/sampleQueryRouter.ts

**What it owns:** Pure tier-selection — routes a chart-history query to the detail / hourly / daily tier based on the requested range and the operator-configured retention windows. No I/O.

**Public API:** `pickSampleTier`, `pickSampleTierForAsset`, `SampleTier`, `TierPick`, `DEFAULT_TIER_RETENTION`

**Cross-service deps:** `sampleRetentionService` (retention windows + FOREVER + entities).

**Used by:** `src/services/sampleHistoryService.ts` (`SampleTier` type) and `src/api/routes/assets.ts` (history endpoints dispatch through `pickSampleTierForAsset`).

**Invariants:**
- Tier decision uses ONLY the `since` timestamp (the oldest point binds the tier), not `until`; `DEFAULT_TIER_RETENTION` applies when per-asset overrides aren't available.
- The returned `bucketSeconds` (0 / 3600 / 86400) signals to the client whether rates are pre-computed (rollup) or client-diffed (detail).

**When changing this:**
- Retention edits flow through `sampleRetentionService` (read per call behind its short cache); tier-picking logic itself rarely changes.

---

## services/sampleRetentionService.ts

**What it owns:** Global per-entity sample-retention policy (Server Settings → Retention), stored in `Setting("sampleRetention")`. Axis is per-entity (assets / cpuMem / hardware / interfaces / storage / ipsec / perfSla — 7 entities), not per-asset-class; selection-aware entities apply configured retention only to selected/monitored rows. (SD-WAN rules are current-state and NOT a retention entity.)

**Public API:** `getSampleRetention`, `updateSampleRetention`, `invalidateSampleRetentionCache`, `getRetentionDays`, `defaultSampleRetention`, `unselectedSlowPruneWindow`, `tieredPruneWindow`, `SETTING_KEY`, `FOREVER`, `UNSELECTED_DETAIL_HOURS`, `RetentionEntity`, `RETENTION_ENTITIES`, `SELECTION_AWARE_ENTITIES`

**Cross-service deps:** `prisma`.

**Used by:** `src/services/sampleQueryRouter.ts`, `src/api/routes/serverSettings.ts` (`GET`/`PUT /sample-retention`), `src/services/capacityService.ts` + `src/services/monitoringService.ts`, `src/jobs/migrateSampleRetentionToEntities.ts`.

**Invariants:**
- Encoding: positive = N days, 0 = tier off (pruned), `FOREVER` = -1 (keep forever); short in-process cache TTL, invalidated on every write; partial PUT merges into stored value.
- Unselected rows keep a fixed short detail window with no rollup; the unselected-slow-prune window respects the compress-after frontier to avoid expensive decompression.
- **`interfaces` no longer produces unselected rows at all** (pinned-only cutover, 2026-08): `persistInterfaceSampleStream` and the agent's `ingestInterfaces` enqueue PINNED interfaces only, and current state for every interface moved to the `AssetInterface` table. So `asset_interface_samples` is now all-`cadence="fast"` and keeps the configured detail retention like an ordinary stream. The slow arm of `pruneSelectionAwareDetail` is kept for it as a **legacy drain** (it clears pre-cutover rows within 24h of deploy, then matches nothing) — and because the same arm still serves storage + ipsec, which DO still write slow rows. Capacity mirrors this: `capacityService.UNSELECTED_DOMINATED_ENTITIES` excludes `interfaces`, so its detail is no longer projected under the conservative 24h cap (that cap would now under-project by the full retention multiple), and its row rate keys off the fleet's pinned-interface count across BOTH the system-info and probe cadences.

**When changing this:**
- `RETENTION_ENTITIES` has eight entries (the two SD-WAN streams included) — keep it aligned with the sample-table inventory.

---

## services/sampleRollupService.ts

**What it owns:** Rolls the seven source sample tables up into hourly and daily aggregates (fourteen rollup tables, 2 tiers × 7 sources); the daily tier reads from the hourly tier, not from detail. Counter tables store first/last for rate derivation, gauges store avg/min/max. (The SD-WAN rules rollup was removed when rules became current-state.)

**Public API:** `rollupHourly`, `rollupDaily`, `RollupTier`, `SourceTable`

**Cross-service deps:** `prisma`, `logger`, metrics (rollup timer).

**Used by:** `src/jobs/runSampleRollup.ts` (hourly + daily ticks).

**Invariants:**
- `INSERT … ON CONFLICT DO UPDATE` (idempotent — re-running the same window rewrites buckets in place); hourly uses a short lookback for late-arriving samples, daily a longer one.
- Counter rate = (last − first) / elapsed with negative deltas treated as resets; daily aggregates are sampleCount-weighted.

**When changing this:**
- **A new COLUMN on a detail sample table is a four-place change**, not one: the Prisma model + migration, the `sampleWriteBuffer` row type (`createMany` passes rows straight through), the hourly SQL's aggregate, AND the daily SQL's re-aggregate — where a column added later must be `COALESCE(..., 0)`'d, since one NULL hourly bucket would otherwise wipe the whole day. `dependencyFailureCount` (the dependency-down probe count behind the grey chart dive) is the worked example.
- A new sample source needs a new `SourceTable` variant, a `DEFS` entry, and matching hourly + daily SQL builders — the SQL is brittle (verify bucket cardinality + aggregate semantics).

---

## services/sampleHistoryService.ts

**What it owns:** Tier-aware readers for the asset chart-history endpoints (monitor, telemetry, hardware sensors, storage, interfaces, IPsec, perf-SLA) — returns serialized rows + stats matching the chart renderers, with overflow-boundary points for unbroken polylines. (SD-WAN rules are current-state — read directly from `prisma.assetSdwanRule` in the route, no history reader here.) Also the merge-comparison **polling-history summary** (`readPollingHistorySummary`): oldest/newest sample + stitched non-double-counting sample count across the monitor + telemetry streams' three tiers, served by `GET /assets/:id/polling-history`.

**Public API:** `readMonitorHistory`, `readLastMonitorSuccessAt`, `readTelemetryHistory`, `readHardwareSensorHistory`, `readStorageHistory`, `readInterfaceHistory`, `readIpsecHistory`, `readPerfSlaHistory`, `readSdwanMembers`, `readPollingHistorySummary`

**Cross-service deps:** `sampleQueryRouter` (`SampleTier`), `prisma`.

**Used by:** `src/api/routes/assets.ts` (`/assets/:id/*-history` + `/sdwan-members` endpoints).

**Invariants:**
- Detail tier reads the source tables; hourly/daily tiers read rollups and translate aggregate columns back to source field names so renderers consume both shapes.
- Counter tables (interface, ipsec) return values for client/rollup rate computation; gauge tables return avg/min/max; BigInt coerced to number with a safe-integer cap; the fetch-since window can extend past `since` for chart continuity while stats stay within the visible range.
- A rollup row's `timestamp` IS its `bucketStart`, so no consumer may read data *freshness* off a rollup series (a daily bucket is up to 24h old when written, and the daily rollup only runs at 02:30 UTC). `readLastMonitorSuccessAt` exists for exactly that: the response-time chart's stale banner reads it (surfaced as `lastSuccessAt` on `monitor-history`, rollup tiers only) instead of the newest sample's timestamp, which otherwise made a healthy 1-minute probe read "Last successful update 17h ago" on the 30d range.

**When changing this:**
- Rollup schema changes require matching SQL in `sampleRollupService`; a new stream needs schema + a tier-aware reader + rollup SQL + router support.

---

## services/probeOutageService.ts

**What it owns:** "When was this device unreachable?", answered from the response-time probe stream — for the charts of streams that carry no failure record of their own (telemetry, storage, interface counters).

**Public API:** `OutageKind`, `foldProbeOutages` (pure), `readProbeOutages`, `readProbeOutagesAtTier`, `serializeOutages`

**Cross-service deps:** `sampleQueryRouter` (`pickSampleTierForAsset`, `SampleTier`), `prisma`.

**Used by:** `src/api/routes/assets.ts` — served as `outages` on `/assets/:id/telemetry-history`, `/storage-history` and `/interface-history`. Consumed browser-side by `_outageMarkers` in `public/js/assets.js` and its two ports (`public/js/mobile/charts.js`, `public/js/assets-compare.js`). `alertChartService.failSpansFrom` also delegates to `foldProbeOutages`, so the alert-email charts and the in-app charts cannot disagree about where an outage began and ended.

**Invariants:**
- **Read-only, and deliberately so.** An earlier design wrote synthetic failure rows into the telemetry/storage/interface tables so those streams would carry their own flag. Rejected: the alert engine (`notificationEngine` selects raw rows and aggregates them), the hourly/daily rollups, and the vanished-state sweep all read those tables with no way to tell a marker from a reading — and a failure row would have had to invent a `mountPath` / `ifName` for a poll that never ran. Never add a writer here.
- **The heavy cadences do not run while an asset is down** (`runsHeavyCadences` gates telemetry / systemInfo / lldp / storage / processes on `up`), so a skipped poll leaves NO row. That is the whole reason this service exists: there is nothing in the stream's own table to mark, and the probe — which runs in every state — is the only record.
- **Partial loss is not an outage.** On the rollup tiers only `sampleCount > 0 && successCount === 0` counts; a bucket with some successes still plots its average. An empty bucket (`sampleCount === 0`) is a gap in the probe stream itself, not a failure.
- **Windows are CLASSIFIED, not merely found** (2026-08). Each carries `kind`: `"dependency"` when EVERY failure in it was taken while the asset was dependency-suppressed (`AssetMonitorSample.dependencyDown`), else `"outage"`. Grey vs red — the shape is identical, since nothing was measured either way; only the accusation changes. A run splits at a change of kind, so misses that were unexplained when they happened are never retroactively excused by the parent going down later, and a tail that keeps failing after the parent recovers goes back to red. On the rollup tiers the whole bucket must qualify (`dependencyFailureCount >= failureCount`), and a NULL count — a bucket rolled up before the column existed — reads as red.
- **Response-time poll only** (`probeKind` NULL or `"primary"`), matching `readMonitorHistory`. The ICMP loss sampler is a different transport that never calls `recordProbeResult` and cannot move `monitorStatus`; its failures are not the same claim.
- **Maintenance needs no special case.** Polling stops entirely inside a maintenance window, so the window contains no failed probes and yields no outage — the purple band explains the gap and no red dive is drawn over it. UI-GUIDE section 15 requires exactly that ("never band a missed poll"; the two states are opposites), and the heuristic this replaced got it wrong.
- **Tier is picked against the `assets` retention entity**, independently of whichever entity the calling chart reads. `assets` and `cpuMem` retention are configured separately, so an install keeping CPU history longer than probe history loses outage shading at the far end of a wide range; the chart degrades to an unmarked gap, which is honest — the evidence is gone.

**When changing this:**
- The browser-side collision guard lives in `_outageMarkers`, not here: a marker landing on a real sample is dropped, because the Polaris Agent pushes on its own schedule and is not gated on `monitorStatus`, so an agent host can keep reporting CPU straight through an outage of the server-side probe transport.
- The dependency grey is duplicated in FOUR places by design — `_CHART_DEP_COLOR` (public/js/assets.js, also read by assets-compare.js), `DEP_COLOR` (public/js/mobile/charts.js) and `DEP_COLOR` (src/utils/sparklineSvg.ts, the alert email) — for the same reason the red is. Change one, change all four, or one outage renders two ways.
- `_outageMarkers` + `_medianCadenceMs` exist in three copies by design (desktop / mobile / compare) — the mobile and compare files say so in their headers. Keep them in step.
- Adding `outages` to a new chart endpoint means adding it to the renderer too, or the payload grows for nothing.
- `openToMs` rides a still-failing run out to the window end (a device down as the chart is drawn is down up to the right edge). Only the FINAL run qualifies, and it is a `Math.max` — a window end older than the last failure must never shorten an outage.

---

## services/sampleWriteBuffer.ts

**What it owns:** Periodic batch-flush buffer for the seven append-only monitor sample tables (asset_monitor_samples / asset_telemetry_samples / asset_hardware_sensor_samples / asset_interface_samples / asset_storage_samples / asset_ipsec_tunnel_samples / asset_perf_sla_samples). Collapses per-work-item `prisma.<table>.create*` calls into one `createMany` per 2 s flush window so the monitor hot loop stops eating DB pool capacity per probe. (SD-WAN **rules** are no longer buffered — they're current-state, written via `persistSdwanRules`; only the SD-WAN SLA-metrics stream `asset_perf_sla_samples` rides this buffer.)

**Public API:** `enqueueMonitorSample`, `enqueueTelemetrySample`, `enqueueHardwareSensorSamples`, `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, `enqueuePerfSlaSamples`, `flushAllSampleBuffers`, `startSampleWriteBuffer`, `shutdownFlushSampleBuffers`, `FLUSH_INTERVAL_MS`, all seven row-type interfaces.

**Cross-service deps:** `prisma` (db.js), `retryOnDeadlock` (utils/dbRetry.js), `startSampleWriteTimer` + `setSampleBufferDepth` (metrics.js), `logger` (utils/logger.js).

**Writers (the only callers of `enqueue*`):**
- `src/services/monitoringService.ts:recordProbeResult` — `enqueueMonitorSample` for the probe outcome row.
- `src/services/monitoringService.ts:runLossSampleFor` — `enqueueMonitorSample` for an ICMP packet-loss sample (`probeKind:"icmp"`, `responseTimeMs: null`). The ONE writer that reaches this buffer WITHOUT going through `recordProbeResult`, and deliberately so: the sampler must not move the monitor state machine's counters (business rule 30). Adding a field to `MonitorSampleRow` therefore means checking BOTH writers.
- `src/services/monitoringService.ts:recordTelemetryResult` — `enqueueTelemetrySample` (CPU/memory only).
- `src/services/monitoringService.ts:recordHardwareSensorResult` — `enqueueHardwareSensorSamples` (per-sensor; dispatched by the separate `collectHardwareSensors` call that `runTelemetryFor` issues in parallel with `collectTelemetry`).
- `src/services/monitoringService.ts:recordSystemInfoResult` — `enqueueInterfaceSamples`, `enqueueStorageSamples`, `enqueueIpsecTunnelSamples`, plus `enqueuePerfSlaSamples` when the heavy pass ran `collectSdwanFortinet` (gated by `Integration.config.pullSdwan`; perfSla rows are stamped cadence="fast"). SD-WAN **rules** are persisted in the same flow via `persistSdwanRules` (current-state delete-replace, NOT buffered). Also folds EVERY scraped interface MAC into `AssetMacAddress` (source="monitor-interface") via `reconcileInterfaceMacs` — contiguous MACs coalesce into `[mac, macEnd]` range rows; the replace is scoped to that source, and `reconcileMacAddresses` symmetrically filters monitor-interface entries + scopes its deletes, so the discovery and interface-fold writers never churn each other's rows.
- `src/services/monitoringService.ts:recordFastFilteredResult` — same three as systemInfo, smaller subset (pinned interfaces only).
- `src/api/routes/agents.ts:POST /samples` — the Polaris Agent ingestion path: `enqueueMonitorSample` (responseTime, also via `recordProbeResult`), `enqueueTelemetrySample` + `enqueueHardwareSensorSamples` (telemetry), `enqueueInterfaceSamples`, `enqueueStorageSamples`. The `interfaces` stream also mirrors `recordSystemInfoResult`'s interface MAC fold — `reconcileInterfaceMacs` (source="monitor-interface", contiguous MACs coalesced into range rows) over every pushed NIC MAC, since for agent-monitored hosts this push IS the system-info source. **This writer runs on the `web` role**, not monitor — which is why the web role must also run the flush tick (see Boot).

**Readers:** none directly. The sample tables are read by `assets.ts` route handlers (chart endpoints), `capacityService.ts` (sample-table breakdown), and Cytoscape topology builders — none of those see the buffer, only the persisted rows after a flush.

**Boot + shutdown:**
- `src/app.ts:startSampleWriteBuffer()` called once after queue init, gated on `cfg.runsWriteBuffers`. **That flag is true for BOTH `monitor` AND `web`** (and `all`) — monitor produces samples via probes, web produces them via the agent `/samples` + `/probe-now` ingestion. If web ever loses the flush tick (it did before this was fixed — `runsWriteBuffers` was monitor-only), agent-sourced rows pile up in the web process's in-memory buffer and only land on the next graceful shutdown flush, while `lastTelemetryAt` (a direct synchronous `Asset.update`, not buffered) stays misleadingly fresh.
- `src/app.ts` SIGTERM/SIGINT hook awaits `shutdownFlushSampleBuffers()` before `process.exit(0)` so a graceful restart drains the buffer — this is the ONLY thing that flushed agent samples while the web role lacked the tick.

**Invariants:**
- **`probeKind` decides who may read a row.** NULL (and `"primary"`) = the response-time poll; `"icmp"` = the loss sampler. Loss counts every kind; every response-time reader filters to primary, INCLUDING all rollups — so a sampler row never outlives the detail retention window. If you add a reader of `asset_monitor_samples`, decide which side it is on before you write the query (the primary-only list is in the skill references' (formerly ARCHITECTURE.md's) AssetMonitorSample block).
- **Append-only.** No conflicts on createMany — every row is a fresh time-series sample with a synthetic UUID `id`. Don't try to add upsert/dedupe logic; if you need replace semantics, do it synchronously in the record function before enqueueing (cf. `persistLldpNeighbors`, which is NOT buffered for this reason).
- **Snapshot-on-flush.** `flushTable` splices the current array up front so concurrent enqueues during the awaited `createMany` land in a fresh array. On retry-exhausted failure the snapshot is re-prepended for the next tick.
- **Per-table flush guard.** `flushing[key]` prevents re-entry on the same table — a 2 s tick that fires while a slow flush is still mid-write becomes a no-op for that table, no concurrent writer per table.
- **Trade-off documented:** up to 2 s of sample rows lost on hard crash. Acceptable because samples are an append-only time series and the next cadence tick re-supplies. Asset-level state (status pill, counters, lastMonitorAt) is buffered separately by `src/services/probePatchBuffer.ts` with last-write-wins semantics — same 2 s window, different shape because state needs replace + read-your-writes, the append-only contract here doesn't fit.
- **Detail tier only.** This buffer covers the eight SOURCE tables. The sixteen `*_hourly` / `*_daily` rollup tables use INSERT...ON CONFLICT DO UPDATE from `sampleRollupService.ts` instead — rollup writes are inherently upsert (idempotent re-runs over the same window must rewrite buckets in place) and the append-only buffer contract has no upsert path.

**When changing this:**
- New sample table → add a `BufferKey`, an `enqueueXxx` helper, a `TABLE_LABEL` entry, and a `switch` arm in `writeBatch`. Touch the test file too — same shape.
- Flush interval change → consider both UI latency (samples take this long to appear on charts) and crash-window data loss. The current 2 s was the explicit operator choice.
- Don't add a `prisma.$transaction` here. `createMany` is one network round-trip already; wrapping it in a transaction just adds round-trips without giving us anything (each table is independent, no cross-table invariant).

---

## services/timescaleService.ts

**What it owns:** TimescaleDB extension detection and hypertable migration for the seven sample tables + fourteen rollup tables + the standalone detail-only `asset_custom_widget_samples` (22 hypertable candidates); `dropChunks` pre-filter for retention pruning. Boot-time detection caches hypertable status; subsequent `isHypertable()` checks return cached value without round-tripping. (SD-WAN rules — `asset_sdwan_rules` — are a plain current-state table, not a hypertable candidate.)

**Public API:** `detectTimescale`, `isTimescaleAvailable`, `isHypertable`, `getDetectionState`, `dropChunks`, `getEffectiveCompressAfterDays`, `migrateToHypertables`, `SAMPLE_TABLES`, `ROLLUP_TABLES`, `STANDALONE_SAMPLE_TABLES`, `ALL_HYPERTABLE_CANDIDATES`, `SampleTableName`, `RollupTableName`, `StandaloneSampleTableName`, `ManagedHypertableName`, `DetectionState`.

**Cross-service deps:** none.

**Used by:** `src/app.ts` — boot detection and hypertable migration; `src/services/monitoringService.ts` — `dropChunks` calls in pruning + `getEffectiveCompressAfterDays` to lower-bound the selection-aware slow prune off compressed chunks; `src/services/capacityService.ts` — hypertable status for capacity snapshot; `src/jobs/reclaimBloatedChunks.ts` — `isHypertable` gate before scanning for compressed-chunk heap bloat.

**Invariants:**
- **Boot-time detection cache:** `detectTimescale()` caches result; cache updates only on successful probe. Re-detection runs after `migrateToHypertables()` completes so `isHypertable()` reflects post-conversion state.
- **`dropChunks` no-op on plain Postgres:** checks `isHypertable(tableName)` early and returns immediately if false; safe to call unconditionally as a pre-filter before per-class `deleteMany`.
- **`migrateToHypertables()` idempotent:** creates hypertables only if not already present. The compression policy is only removed + re-added when the `compress_after` window actually CHANGED (`compressionPolicyMatches` introspects `timescaledb_information.jobs.config->>'compress_after'`) — an unconditional recreate every boot resets the policy's `next_start` ~12h out, so a host that reboots more often (in-app updates cycle `polaris.target`; crash loops) would never let the policy reach its first run, and chunks would never compress. `TIMESCALE_COMPRESS_AFTER_DAYS` changes still take effect next startup (window differs → recreate).
- **Boot-time self-heal compression (`compressEligibleBacklog`):** after the conversion loop, compresses any chunk already past its window but still uncompressed — does immediately what the 12h policy scheduler otherwise might never get to. Sequential + oldest-first + capped at `MAX_BACKLOG_COMPRESS_CHUNKS_PER_TABLE` (8) per table so a large first-run/post-outage backlog can't stall boot or saturate the DB; remaining chunks resume next boot or via the policy. Only touches chunks older than the window, so it never compresses a chunk the unselected 24h `deleteMany` still writes to. This is the guard against the uncompressed delete-churn bloat that ballooned `asset_interface_samples` to 114 GB in prod (single 63 GB uncompressed chunk). Best-effort — per-chunk errors logged, never thrown.
- **Chunk-granular drops:** `drop_chunks` can only drop a chunk when ALL rows are older than cutoff; fast O(1) filter for old chunks before residue cleanup via `deleteMany`.

**When changing this:**
- Verify `detectTimescale()` is called before any sample write so hypertable status is fresh.
- If modifying `SAMPLE_TABLES` / `ROLLUP_TABLES`, keep in sync across detection, pruning, and migration logic, plus capacityService's local per-table projection map. `tests/unit/timescaleTables.test.ts` drift-guards the inventory against sampleRollupService, the monitoringService prune layer, and prisma/schema.prisma (with an explicit exemption list — `asset_custom_widget_samples` is the one known unmanaged sample table).
- Test plain-Postgres fallback path: verify `dropChunks` no-op and `deleteMany` handles all pruning when extension unavailable.
- Check compression policy drift if operators change `TIMESCALE_COMPRESS_AFTER_DAYS` mid-boot cycle (only takes effect next restart).
- If TimescaleDB ever renames the compression-policy config key (`compress_after`), update `compressionPolicyMatches` — but its catch-all returns `false` (recreate) on any introspection failure, so a key rename degrades to the old always-recreate behavior + the backlog pass, never breaks.

---

## services/storageForecastService.ts

**What it owns:** Per-filesystem "days until full" forecasting — the ONE shared computation behind the Storage Forecast dashboard widget (nocDashboardService `storageForecast` feed) and the `storageDaysUntilFull` automation metric (notificationEngine's asset-metric resolver).

**Public API:** `computeStorageForecast(assetIds | null, lookbackDays?, minPoints?)` → `StorageForecastRow[]` (assetId, mountPath, daysUntilFull, usedPct, slopeBytesPerDay, points; soonest-full first), plus the tuning constants `FORECAST_LOOKBACK_DAYS` (30), `FORECAST_MIN_POINTS` (7), `FORECAST_MAX_DAYS` (365).

**Cross-service deps:** `prisma` (raw regr_slope aggregate over `asset_storage_samples` + `asset_storage_samples_daily`), `utils/linearTrend.daysUntilFull`.

**Used by:** `nocDashboardService.getStorageForecast` (widget feed), `notificationEngine.resolveAssetMetricReadings` (the `storageDaysUntilFull` case — dimKey = mountPath, so single-trigger rules alert per filesystem and composite leaves fold ANY-mount).

**Invariants:**
- Trend source is a UNION of day-bucketed DETAIL samples (7-day retention — covers every storage-scraped asset, incl. the slow 24h cadence) and the DAILY rollups (365-day retention but **cadence='fast' pinned assets only** — sampleRollupService's sqlStorageHourly cadence filter). Never rely on the rollups alone: unpinned assets would silently vanish from the forecast.
- Growing mounts only (regr_slope > 0 in the HAVING) with ≥ minPoints distinct days — a flat/shrinking/new filesystem produces NO row, which is what keeps `storageDaysUntilFull <= N` automations silent for healthy mounts (absence of a reading is never a firing signal).
- READ-ONLY over the hypertable + rollup table; one aggregate query, flat at 2000 assets.

**When changing this:** The lookback/min-points defaults are user-visible semantics (widget copy + metric help in notificationTypes) — change them in lockstep. If storage rollups ever stop filtering on cadence, the UNION dedup keeps working but the detail arm becomes redundant past 7 days.

---
