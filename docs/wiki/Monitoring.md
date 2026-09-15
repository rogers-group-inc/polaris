# How monitoring works

Polaris polls devices on a cadence you set, over a transport you choose, per
**stream**. Nothing about that is a single global setting — it resolves from a
hierarchy, per stream, per asset.

Companion pages: [Polling methods](Polling-Methods) ·
[Monitor states and down detection](Monitor-States) ·
[Dependency suppression](Dependency-Suppression) ·
[Maintenance windows](Maintenance-Windows).

---

## The eight streams

| Stream | Collects |
|---|---|
| **responseTime** | is it answering, and how fast — the liveness probe |
| **cpuMemory** | CPU and memory utilisation |
| **temperature** | hardware sensors and their alarm bits |
| **interfaces** | per-port state, counters, PoE, IP, LLDP-adjacent data |
| **lldp** | LLDP neighbours |
| **storage** | filesystems and mounts |
| **processes** | the process / service inventory, plus CPU/RAM for pinned ones |
| **eventLog** | OS event log / journal entries, curated into the audit log |

Each has its own cadence, its own queue and its own worker pool. A slow stream
cannot starve a fast one.

---

## What "monitored" means

`Asset.monitored` is the operator's statement that Polaris should poll this
device. It gates:

- whether the device is polled at all;
- whether it appears in the dashboard's fleet counts;
- **whether any automation may fire about it**
  ([rule 37](Business-Rules#rule-37)).

Four statuses **cannot** carry monitoring — `decommissioned`, `disabled`,
`storage`, `quarantined` ([rule 10](Business-Rules#rule-10)). Staging one of
them clears the flag in every write path.

`quarantined` joined that list because a quarantined device is isolated at the
FortiGate, so **every probe fails by design** — a security action was producing
an outage alert storm about the isolation working. Because quarantine is
reversible, the flag is *parked* and restored on release; otherwise releasing a
quarantine handed the device back with nobody watching it.

`maintenance` is deliberately **not** on the list: a window pauses polling while
`monitored` keeps your intent, so it survives the window.

---

## Cadence

Each stream's interval resolves from the same hierarchy the polling method
does — **per asset → class override → integration → manual tier → hardcoded
floor**. The figure the monitor-settings card reports is the figure you get.

Exactly **one** clamp is applied on top: dependency suppression doubles the
interval for a device whose parent is dark. That is it.

### What a probe can decline to be

A probe can return `skipped`, which **writes no sample and moves no counter** —
it bumps the cadence anchor alone, so spacing is preserved. Three sources:

| Source | Why |
|---|---|
| **vCenter unreachable** | the thing that answers for the device is not the device — one vCenter outage must not down a virtual fleet |
| **FortiManager unreachable** | same reasoning, for the `fortimanager` method |
| **`responseTimePolling = "disabled"`** | the operator saying *do not poll this* |

That last one was a *failure* until 2026-08-28. Every other stream's publisher
checked its resolved method before queueing and the probe's did not, so
`disabled` reached the dispatcher, fell past every branch to an unknown-method
error, and was recorded as a **missed poll** — switching Response Time off drove
the device to `down`.

**A skip is not a miss**, so N consecutive misses still means N times the
transport actually answered nothing about a device it could reach.

### A re-queued job is not a second reading

The probe queue lets one job queue behind an active job with the same key, and a
batched ICMP chunk can outlive the 5-second publisher tick. The same poll
therefore ran twice, seconds apart: **two samples per cycle, and two misses
toward the threshold**. Jobs now carry their resolved interval and the worker
re-runs the due check at pickup; a duplicate records nothing at all.

---

## Transports, and which ones batch

| Transport | Batching |
|---|---|
| **ICMP** | **batched** — due assets are published as chunks and pinged through one `fping` per distinct timeout, one echo each |
| SNMP | one job per asset — OIDs batch *within* a session, never across hosts |
| SSH / WinRM | one connection per host per tick; interfaces and storage ride the same one |
| REST (FortiOS) | one per asset, **except** two cross-device caches |
| vCenter | two warm caches, one SOAP round trip per integration per tick |
| Agent | the agent pushes on its own schedule |

The two cross-device REST batchers matter at scale: **one FortiManager
`/dvmdb` read serves every gate it manages**, and the vCenter warm caches answer
four streams for every VM and host in one fetch.

### Reading timestamps correctly

An ICMP chunk runs until its slowest target times out, which can be a whole
publisher tick. Each reading is recorded at **the instant the echoes were
sent**, not when the chunk finished.

---

## Packet loss is a separate measurement

A **uniform burst of 5 echoes at every eligible asset each cycle** — `down`
and dependency-suppressed devices included — batched through `fping` (one
process per 500 targets), falling back to per-host `ping` bursts where `fping`
is not available.

Two things about it ([rule 30](Business-Rules#rule-30)):

- **It never records a probe result.** ICMP does not authenticate the device it
  reaches, so the sweep informs the loss ratio and **can never move
  `monitorStatus`**.
- **It is uniform**, unlike the per-asset sampler it replaced, which ran only
  while an asset looked unhealthy — itself a sampling bias.

"`fping` not available" covers **not installed** *and* installed-but-unexecutable:
on Debian, `fping` and `ping` carry `cap_net_raw=ep`, so a process without
`CAP_NET_RAW` fails at exec.

---

## Credentials

A polling method needing authentication walks four tiers, most specific first:

```
per-stream asset credential
  → the asset's generic monitor credential
    → the class override's per-stream credential
      → the integration's fallback
```

The integration fallback is: FortiManager / FortiGate firewalls read the
integration's SNMP credential or its stored API token; AD-discovered hosts read
the integration's bind DN and password.

**The asset's credential picker is type-agnostic** — you pair it with the
polling method you chose. A mismatch is allowed and falls through to a clear
error at probe time ("No WinRM credential selected"), rather than being refused
at save.

### Per-asset FortiOS REST credentials

An integration's API token is fleet-wide by construction — the field's own hint
says it must be the same across all managed FortiGates. A fleet where each gate
carries its own api-user therefore could not be polled over REST at all.

Since 2026-09 a `restapi`-typed credential selected on an asset's stream is
preferred. It contributes **authentication, port and TLS verification only —
the target stays the asset's own address**, so one credential mistakenly
selected on twenty gates cannot poll one device and file its CPU under all
twenty.

> This is worth knowing because of what it fixed. The asset modal had been
> offering that picker on every REST stream all along, while the collector never
> read it: the selection persisted, resolved, rendered — and **collected
> nothing, forever, with the tick reporting success.**

---

## Compatibility vs capability

Two different questions, and only the first used to be checked:

- **Compatibility** — is this method *meaningful* for this source kind?
- **Capability** — does the **collector actually exist**?

A stream could be configured into permanent quiet: `ssh`/`winrm` on several
streams, `snmp` on processes, `rest_api` on FortiOS storage, `eventLog` on
anything but the agent — all resolved fine and collected nothing while the tick
recorded success.

Now the validators **warn** (not refuse — a 400 would punish re-saving an
existing value), the dropdowns stop offering them, and an audit names what is
already stored. One case is a hard refusal: **ICMP on a non-response-time
stream** via the per-asset route.

---

## Sub-asset pinning

Interfaces, IPsec tunnels and storage mounts each have a pin array on the asset.
**The pin is a gate on alerting, never a side effect of retention**
([rule 57](Business-Rules#rule-57)) — every stream writes samples for unpinned
members too, permanently inside the engine's lookback.

An unpinned member **never alerts**, and there is no opt-out. Un-pinning is how
alerting stops.

Storage was the last dimension to be closed and the one that hurt most: a device
reports every filesystem it has, so a fleet-wide "disk over 90 %" automation
alerted on removable volumes, ISO mounts, recovery partitions, mapped network
drives and archive shares that are **full by design**.

Pin from the asset's own tabs, from an integration's auto-monitor pass
(additive only), or in bulk from
[Assets → Settings → Mass Pinning](Assets#mass-pinning) (which can also unpin).

---

## Samples, rollups and retention

Samples land in TimescaleDB hypertables and are rolled up hourly and daily.
Retention is tiered and configured at **Server Settings → Retention**.

Prune is by `drop_chunks`, never by row delete — sample tables carry **no
foreign key to Asset** and are never row-updated where a row could sit in a
compressed chunk. That is why deleting an asset does not cascade into its
history.

**Server Settings → Maintenance** reports a capacity snapshot, a steady-state
size projection and a disk forecast, all measured on your install.

---

## Observability

Polaris exports Prometheus metrics at `GET /metrics`, gated by `METRICS_TOKEN`
when set and additionally by an nginx `allow` block in production. Grafana
dashboards ship in
[`docs/grafana/`](https://github.com/rogers-group-inc/polaris/tree/main/docs/grafana).

`GET /health` answers 200 whenever the process is up and **checks nothing at
all** — the setup wizard polls it before a database exists, so a database check
here would deadlock provisioning.

`GET /health/ready` is the one a **load balancer** should monitor: 200 only when
the local PostgreSQL is a **writable primary**, otherwise 503 with a reason
(`in-recovery`, `db-error`, `timeout`). It runs on its own one-connection pool
over the direct database URL, never the application pool — a saturated pool must
not be able to flap a healthy site out of a load balancer.
