# Process roles — runtime behavior

Verbatim from ARCHITECTURE.md → Multi-process architecture (the deployment half is in `polaris-deploy/references/multi-process-deployment.md`).

Polaris can run as one process (default) or split across specialized processes
that coordinate through the shared PostgreSQL + pg-boss queue (the SolarWinds
Orion model: many supervised services + a grouping wrapper). The role is chosen
by `POLARIS_ROLE`; capability gating lives in `src/utils/role.ts` (`roleConfig`),
and `src/app.ts` branches on the capability flags at boot.

| Role | Boots | Notes |
|---|---|---|
| `all` (default, unset) | everything | Local dev (`npm run dev`) — runs everything in one process for fast iteration. Not a production deployment target since Phase 3 (no `polaris.service` unit is shipped). |
| `web` | Express/HTTPS/agent-WS, **all singleton schedulers**, one-shot migrations, pg-boss **producer** connection, **sample/probe write buffers** (the Polaris Agent `/samples` + `/probe-now` endpoints ingest here, so the web role must run the flush tick or agent-sourced rows never persist) | Single instance — the control plane. Owns the in-app updater (restarts the whole group). |
| `monitor` | pg-boss **monitor-queue consumers** + floating pool, sample/probe write buffers | Run **N replicas** — pg-boss hands each job to exactly one worker, so replicas never double-execute. |
| `discovery` | pg-boss **discovery-queue consumer** (`runDiscovery`) | Executes discovery runs off the `polaris-discovery-run` queue. |

**Discovery is queue-backed.** `triggerDiscovery` (route + scheduler) validates,
upserts a `queued` `DiscoveryRun`, and `publishDiscoveryJob`s to the
`polaris-discovery-run` queue (singletonKey = integrationId → one active run per
integration). The discovery worker runs `runDiscovery`, transitioning the
`DiscoveryRun` row (queued → running → completed/aborted/error) and flushing a
progress accumulator to it; the web process reads that row for the
`/discoveries` endpoint, `isDiscoveryRunning`, the slow-run check, and renders
cancel by setting `cancelRequested` (the worker polls it → aborts its local
AbortController). When pg-boss is off (cursor mode), `triggerDiscovery` runs
`runDiscovery` in-process — the single code path across topologies. See
`src/services/discoveryRunState.ts` and `DiscoveryRun` in the domain model.

**Cancel has two tiers.** The abort signal is observed natively by every HTTP
transport under discovery (fgRequest 15s cap, FMG rpc 10s cap + bounded
retries, geocoder 8s) and cooperatively by `syncDhcpSubnets`, which throws
`DiscoveryAbortError` at each `phaseMark` boundary (`utils/errors.ts` —
`name="AbortError"` so the terminal handler counts the run as aborted, not
errored; the `__end__` mark is exempt so a fully-committed sync isn't
discarded). For wedges the signal cannot reach — a Prisma query blocked on a
Postgres lock has no statement timeout, ignores the signal, and keeps the 60s
heartbeat ticking so the reaper never fires either (prod incident 2026-07-20:
one FortiGate held a run "running" 5+ hours through a cancel) —
`discoveryCancelWatchdog` is armed on abort and disarmed in runDiscovery's
finally: if the run hasn't unwound 2 minutes after abort, it logs the stuck
devices, finalizes the row `aborted`, writes `integration.discover.force_exit`,
and exits 1 so systemd restarts the process (same exit-and-restart pattern
as the operator /restart endpoint). Under `all`/cursor-mode-fallback the exit
takes the whole process — matching /restart semantics. If pg-boss redelivers
the interrupted job, runDiscovery sees `cancelRequested` still set at startup
and aborts cleanly.

**Singletons** (monitor producer ticks, discovery scheduler, reconcilers,
rollups, prune, one-shot migrations) are pinned to `web`/`all` so they run in
exactly one process; monitor/discovery stay pure consumers.

**Connection budgeting.** Each process opens its own Prisma + pg-boss pool, so
the group footprint ≈ `(monitor replicas + 2) × per-process pool`. Size so it
stays under Postgres `max_connections` (PgBouncer absorbs the Prisma pools but
pg-boss pools always hit Postgres directly). Each process emits
`polaris_db_pool_role_capacity{role}`; the Capacity Advisor's max_connections
model multiplies by `POLARIS_MONITOR_REPLICAS` (and `peakObserved` is already
group-wide via `pg_stat_activity`).
