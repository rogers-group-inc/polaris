---
name: polaris-monitoring-discovery
description: "How Polaris polls devices and discovers inventory: the monitoring architecture (four-tier polling-method hierarchy, the eight streams, SNMP/SSH/WinRM/REST/ICMP/agent/vcenter/fortimanager collectors, probes and the failure bucket, samples and rollups, packet-loss sweep, down detection, dependency suppression, the controller-link sweep that tells you whether a FortiGate still holds the FortiLink session to a managed FortiSwitch or the CAPWAP tunnel to a managed FortiAP), the seven discovery workflows (FortiManager, FortiGate, Entra/Intune, AD, Windows Server, vCenter, Azure Arc) phase by phase, the ~64 background jobs, the Prometheus metric catalogue, and the FMG/SNMP/TimescaleDB incident runbooks. Load for anything about probes, cadence, monitorStatus, collectors, MIBs/OIDs, discovery phases, integrations, jobs, metrics, FortiLink or CAPWAP link state, or an outage on the monitor/discovery role."
---

# Polaris monitoring and discovery

Two halves. **Monitoring** polls devices on the operator's configured transport at the
configured cadence (`monitoringService`, the light + heavy `monitorAssets` loops, pg-boss
queues per cadence) and writes samples. **Discovery** pulls inventory from seven integration
types (`discoveryEngine`, per-integration services, `discoveryScheduler`) and projects it
onto Assets, Subnets and Reservations.

## Which file

| You need… | Read |
|---|---|
| the eight streams (`responseTime` / `cpuMemory` / `temperature` / `interfaces` / `lldp` / `storage` / `processes` / `eventLog`) × methods (`icmp` / `snmp` / `ssh` / `winrm` / `rest_api` / `agent` / `vcenter` / `fortimanager`), what each transport can and cannot do, per-asset REST credentials, the FMG auth note | [references/polling-methods-streams.md](references/polling-methods-streams.md) |
| how a polling method is resolved (asset → class → integration per-class → integration flat → manual → floor), compatibility vs capability, agentless host streams, credential resolution | [references/monitoring-architecture-polling.md](references/monitoring-architecture-polling.md) |
| FortiSwitch/FortiAP polling and auto-monitor, the decommission sweep, CMDB-vs-monitor policy, offline-gate CMDB pull, proxy vs direct, reservation push + queued push lifecycle, quarantine push, verbose logging | [references/monitoring-architecture-fortinet.md](references/monitoring-architecture-fortinet.md) |
| process roles (`all` / `web` / `monitor` / `discovery` / `dash`), queue-backed discovery, cancel tiers, singletons, connection budgeting | [references/process-roles-runtime.md](references/process-roles-runtime.md) |
| the seven integrations at a glance, asset projection priority, hybrid-join, GAL search/sync, presence verification | [references/discovery-overview.md](references/discovery-overview.md) |
| FortiManager phase by phase (FMG worker dual lanes, direct-mode warm cache, proxy field filtering, stale sweeps, auto-monitor apply, change events, description-sync reconcile, scoped re-discovery) + standalone FortiGate | [references/discovery-fortinet.md](references/discovery-fortinet.md) |
| Entra ID / Intune, Active Directory (+ hybrid-join), vCenter, Azure Arc | [references/discovery-directory-vcenter-arc.md](references/discovery-directory-vcenter-arc.md) |
| every background job, its schedule and purpose, the one-shot markers | [references/background-jobs.md](references/background-jobs.md) |
| the `polaris_*` metric catalogue, `/health`, `/metrics`, multi-process scrape | [references/observability.md](references/observability.md) |
| the operator-facing FMG decision tree (transport mode, roster filters, per-class knobs, single-gate re-discovery) | [references/fmg-discovery-decision-tree.md](references/fmg-discovery-decision-tree.md) |

## Runbooks (symptom → file)

| Symptom | Runbook |
|---|---|
| FortiManager RPC `-11` "no valid session" churn, discovery/monitor both failing FMG calls | [references/runbooks/fmg-rpc-session-churn.md](references/runbooks/fmg-rpc-session-churn.md) |
| heavy cadence (system-info / telemetry) wedged behind one dead host, `SNMP gate timeout` logs | [references/runbooks/system-info-deadlock.md](references/runbooks/system-info-deadlock.md) |
| DB volume growing after asset deletes, compressed-chunk bloat, `reclaimBloatedChunks` | [references/runbooks/timescale-chunk-bloat.md](references/runbooks/timescale-chunk-bloat.md) |

## Invariants to carry into any change here

- **Down is the covering automation's `missedPolls`, counted at the probe as a leaky bucket with a ceiling** (`utils/monitorStatus.ts` — `nextFailureBucket` + `monitorStatusFor`); a device no down automation covers reads `passive`. ICMP loss sweeps never call `recordProbeResult`. Rules 29, 30, 36.
- **A probe may decline to be a reading** (`ProbeResult.skipped`): vCenter/FMG unreachable, or `responseTimePolling === "disabled"`. A skip is not a miss.
- **`Asset.lastSeen` only through `bumpLastSeen()`**; polling is authoritative for monitored assets (rule 12). Discovery never writes status over a maintenance asset (rule 16).
- **Sample tables are TimescaleDB hypertables with no FK to Asset** — never row-DELETE/UPDATE where a compressed chunk may hold the row; prune via `drop_chunks`.
- **Resolve a FortiSwitch/FortiAP's parent through `utils/fortinetParentKey.ts`**, never by matching `controllerFortigate` to a hostname.
- **FortiManager ↔ standalone FortiGate parity**: a feature added to one integration ships on the other unless structurally FMG-only.
- **Implementing a collector flips `utils/pollingCapability.ts` and its `_collectorExists` mirror in `public/js/integrations.js` in the same commit.**
- **Scale-check at 100 and 2000 monitored assets**: no `for…of { await prisma… }` in a tick; batch with `$transaction` / `updateMany` / `Promise.all`; tight `select`s on hot loops.
- **Adding a job or a metric**: name the job in the file map and the jobs table, define the metric in `src/metrics.ts` + `observability.md` + the Grafana dashboard JSON (`/polaris-docs-sync` has the checklist).

Related skills: `polaris-agent` (the `agent` method and everything the Go agent does),
`polaris-domain-model` (`samples-rollups.md`, `assets-inventory-tables.md`),
`polaris-change-impact` (`five-state-monitor-machine`, `polling-method-resolver`,
`dependency-aware-monitoring-suppression`, `tiered-sample-retention`, `integration-type-onboarding`,
services `monitoring-collection` / `discovery-fortinet` / `discovery-directory-cloud`),
`polaris-business-rules` (12–17, 22–24, 26, 29–30, 33–38, 40–42).
