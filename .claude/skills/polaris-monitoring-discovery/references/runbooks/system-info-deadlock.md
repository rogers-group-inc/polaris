# Runbook: system-info / telemetry collection wedge (SNMP gate)

**Symptom:** Heavy-cadence collection (telemetry + system-info) on one or more assets appears stuck; the heavy monitor loop falls behind; logs show `SNMP gate timeout for <host>:<port> after <ms>ms` and/or `SNMP gate wait > 5s`. Probe (light-loop) polling for the rest of the fleet keeps working.

> Note: there is no separate, individually-documented "system-info deadlock" prod incident in the codebase. This runbook is written around the real, documented mechanism — the per-host SNMP serialization gate wedging on a dead/slow host, and the two-loop monitor architecture that contains it. Treat "deadlock" here as "a wedged heavy collection backing work up behind a single slow host," not a Postgres deadlock. (Postgres lock contention has its own self-healing path — see `reclaimBloatedChunks` in `timescale-chunk-bloat.md`.)

---

## Background — the SNMP gate and the two-loop monitor

Many switch / AP SNMP agents are single-threaded: a heavy walk (IF-MIB + LLDP + storage) running in parallel with a cheap `sysUpTime` probe pins the agent's request queue and stretches the probe's response time, occasionally past its timeout (reads as packet loss). To prevent this, all SNMP entry points FIFO-serialize per `(host, port)` through `src/services/monitoring/snmpCore.ts -> withSnmpGate()`.

The wedge case: when the currently-running collector hangs (e.g. a dead host hitting net-snmp's ~60s timeout), it holds its gate slot for the full upstream duration. Without a bound, every queued caller behind it would block that whole time. So each waiter has a bounded wait — `POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS` (default 30000) — after which it fails fast with `SNMP gate timeout for <host>:<port> after <ms>ms` (`src/services/monitoring/snmpCore.ts -> snmpGateWaitTimeoutMs()`). **The timeout only bounds the wait for queued callers; the wedged slot itself still holds the gate until its upstream call returns.** Operator SNMP walks override the per-call wait to 50s (`SNMP_WALK_GATE_WAIT_MS`) to fit the SNMP Walk tab's 60s client countdown.

This is contained by the two-loop design in `src/jobs/monitorAssets.ts`: the **light loop** (probe + fastFiltered, every 5s) and the **heavy loop** (telemetry + systemInfo, every 30s) tick independently with separate `running` guards. A slow heavy pass on a wedged host blocks only **future heavy ticks**, never the light loop — so per-minute reachability polling for the rest of the fleet keeps firing.

---

## Diagnose

### 1. Confirm it's a gate wedge and find the host

```bash
# Split-role layout
sudo journalctl -u 'polaris-monitor@*' --since '30 min ago' --no-pager \
  | grep -Ei 'SNMP gate (timeout|wait)|gate_wait'
```

`SNMP gate timeout for 10.x.y.z:161 after 30000ms` names the `(host, port)` whose currently-running collector is wedged — the host in the message is where callers are stacking up, and the wedged collector is on that same host. `SNMP gate wait > 5s` (warn) is an early indicator before timeouts start.

### 2. Confirm the wedged host is actually unreachable / slow

The usual root cause is a host that answers ICMP-ish checks but whose SNMP agent is dead or overloaded (net-snmp then sits in its ~60s timeout):

```bash
# From the monitor host
snmpget -v2c -c <community> -t 5 -r 1 <host> 1.3.6.1.2.1.1.3.0   # sysUpTime
ping -c 3 <host>
```

A hang or timeout on the `snmpget` confirms the collector is wedged on the upstream call, not stuck in Polaris.

### 3. Confirm the heavy loop fell behind (not the whole monitor)

Check that the light loop is still ticking (recent probe activity / fresh `lastSeen`), which confirms the wedge is isolated to the heavy cadence as designed. The `polaris_monitor_*` metrics (heavy work duration, queue depth; see `observability.md`) show the heavy loop's backlog. On split-role, scrape each `polaris-monitor@N` `/metrics` endpoint (port `910N`) — registries are per-process.

### 4. Rule out a stuck worker vs. a slow host

If gate timeouts name many different hosts at once, suspect the heavy worker pool is saturated (too few workers for the fleet) rather than a single dead host — tune `POLARIS_MONITOR_HEAVY_WORKERS` / `POLARIS_HEAVY_CONCURRENCY` via the Capacity Advisor. If timeouts name one or a few hosts repeatedly, it's a per-host wedge — fix or stop monitoring those hosts.

### 5. Where Postgres logs live (if you suspect DB-side blocking, not the gate)

A genuinely stuck heavy worker that's blocked in the database (rare; the gate handles the common case) shows up in `pg_stat_activity`:

```sql
SELECT pid, state, wait_event_type, wait_event, now() - query_start AS runtime, left(query, 120)
  FROM pg_stat_activity
 WHERE state <> 'idle'
 ORDER BY runtime DESC;
```

Postgres server logs per platform:
- **RHEL/Rocky/Alma:** `/var/lib/pgsql/15/data/log/postgresql-*.log`
- **Ubuntu/Debian:** `/var/log/postgresql/postgresql-<ver>-main.log`
- **Windows:** `C:\Program Files\PostgreSQL\<ver>\data\log\`

(Use `POLARIS_DB_DIRECT_URL` for any direct psql session when PgBouncer is in front.)

---

## Recover

1. **Let it self-clear (usual case).** The gate timeout (30s default) drains queued callers automatically; once the wedged collector's upstream call returns (or net-snmp times out at ~60s), the gate releases and the next heavy tick proceeds. No action needed for a transient blip — the light loop never stopped.
2. **Stop monitoring a dead host.** If a host is permanently down or its SNMP agent is broken, the wedge will recur every heavy cadence. Set the asset to `maintenance`/`disabled`, or remove the SNMP polling stream for it, so collectors stop queueing against it. (Decommissioned/disabled assets are not monitored — see `polaris-business-rules` rule 10.)
3. **If the whole heavy loop seems hung (no progress across hosts):** restart the affected monitor process. The heavy-loop `running` guard releases on restart and the next tick re-evaluates due assets.
   ```bash
   sudo systemctl restart 'polaris-monitor@1'   # the affected instance
   ```
4. **If timeouts are fleet-wide from worker starvation:** raise heavy-worker concurrency via the Capacity Advisor (`POLARIS_MONITOR_HEAVY_WORKERS` / `POLARIS_HEAVY_CONCURRENCY`) rather than restarting — the wedge is capacity, not a single host.

---

## Prevent

- Keep `POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS` at a value that gives a legitimate heavy + telemetry back-to-back room (default 30s) but still surfaces a hang. Don't raise it to mask a genuinely dead host — fix or stop monitoring the host instead.
- Don't monitor known-dead hosts on the heavy cadence; let presence verification / status management age them out.
- Route every new SNMP entry point through `withSnmpGate()` so it inherits the per-host serialization + fail-fast wait. FortiOS REST and FMG calls have their own concurrency models and intentionally bypass the gate.
- Size the heavy worker pool for the fleet (scale-check at 100 and 2000 monitored assets per `CLAUDE.md`); a starved pool turns one slow host into fleet-wide heavy-loop lag.

---

## Related

- `polaris-deploy` → `env-vars.md` (`POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS`, `POLARIS_MONITOR_HEAVY_WORKERS`, `POLARIS_HEAVY_CONCURRENCY`).
- `observability.md` (per-process `/metrics`, monitor pass / heavy work duration metrics) and `polaris-business-rules` rule 10 (decommissioned/disabled not monitored).
- `polaris-change-impact` → `services/monitoring-collection.md` (`monitoringService.ts` entry).
- Code: `src/services/monitoring/snmpCore.ts` (`withSnmpGate()`, `snmpGateWaitTimeoutMs()`, `processNextSnmpSlot()`; moved out of monitoringService.ts by CQ-B061), `src/jobs/monitorAssets.ts` (light/heavy two-loop architecture).
- Sibling runbook: `timescale-chunk-bloat.md` for DB-volume / TimescaleDB issues.
