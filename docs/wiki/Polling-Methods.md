# Polling methods

Every stream on every asset resolves to exactly one **polling method**. There is
no per-asset "monitor type" column — the answer is computed, per stream, from a
four-tier hierarchy.

---

## The hierarchy

```
per-asset  *Polling column
  → MonitorClassOverride
    → Integration.config.monitorSettings.polling
      (or the Manual tier, for assets with no integration)
        → the source default
```

Where each tier is edited:

| Tier | Where |
|---|---|
| **Manual** | Assets → Settings → *Manual Monitoring*. Accepts any method — it covers any source |
| **Integration** | the integration's edit modal → **Monitoring** → Cadence & Retention. Filtered to the integration's source kind |
| **Class override** | Assets → Settings → *Class Overrides*. Re-renders when the source picker changes |
| **Per asset** | the asset's edit modal → **Monitoring**. Filtered to the asset's source kind |

`GET /assets/:id/effective-monitor-settings` returns the resolved values **plus
per-field provenance** (`asset` / `class` / `integration` / `manual`), which is
what draws the tier badges in the asset modal.

Every **Inherit** option is labelled with what you would actually inherit —
*"Source default: REST API"*, *"Source default: ICMP"*, *"Not delivered for this
source"* — so you can see the fallback without clicking through.

A method that does not apply to the asset's source kind is **silently ignored at
resolution time**; the route layer rejects it at write time with a clear 400.

---

## The methods

| Method | Notes |
|---|---|
| `icmp` | the cheapest universal liveness probe. **Batched** |
| `snmp` | v2c / v3 authenticated GETs |
| `ssh` | |
| `winrm` | |
| `rest_api` | FortiOS REST |
| `agent` | the Polaris Agent installed on the host. **Never appliances** |
| `vcenter` | reads the vCenter server, not the guest |
| `fortimanager` | reads FortiManager's device database, not the device |
| `disabled` | universally allowed — *do not poll this stream* |

> The **`http`** method was retired in 2026-08. The HTTP check it ran is now a
> **manufacturer custom widget** ([rule 33](Business-Rules#rule-33)) — see
> [below](#the-http-check).

---

## Source defaults

| Source | responseTime | cpuMemory | temperature | interfaces | lldp | storage |
|---|---|---|---|---|---|---|
| **FortiManager / FortiGate** | `icmp` | `rest_api` | `rest_api` | `rest_api` | `disabled` | `disabled` |
| **AD / Entra / Windows Server / Manual** | `icmp` | — | — | — | — | — |
| **vCenter** | `vcenter` | `vcenter` | — | `vcenter` | — | `vcenter` |

**Response time defaults to ICMP across every source kind**, because ICMP is the
cheapest universal liveness probe. Operators wanting a heavier transport —
FortiOS `/sys/status`, SNMP `sysUpTime` — opt in per asset, per class, or at the
integration tier.

FortiOS storage defaults to `disabled` because FortiOS appliances expose no
meaningful mountable storage, so the SNMP walk would burn cycles every scrape.
Flip it to `snmp` per asset where you have a device that does.

### The FortiManager proxy gotcha

Those `rest_api` defaults assume Polaris can make a FortiOS call **to the
device**. On a **FortiManager on the proxy transport with no FortiGate API
token** it cannot: every FortiOS collector dials the asset's own IP and needs
that token.

So on that configuration the defaults become `disabled` for cpuMemory,
temperature and interfaces, and a **stored** `rest_api` is skipped the same way
— non-destructively, since the stored value returns the moment a token is
supplied. The dropdowns grey out with a note naming the token as the thing that
unlocks them.

**Response time is deliberately unchanged** (`icmp`): moving it would silently
change how up/down is decided for every gate on every affected install.

Note the condition is **not "proxy mode"** — proxy *with* a token is a
legitimate setup (discovery and writes ride FMG, monitoring reaches the gates
directly) and keeps the normal REST defaults.

The one exception is a managed **FortiSwitch / FortiAP's response time**, which
stays `rest_api`: that read goes to the **parent gate's controller table**, the
one monitoring path that honours the proxy setting, and works on FMG's own
credential.

---

## Agentless host streams

`ssh` and `winrm` deliver **cpuMemory, interfaces, storage, processes and
eventLog**.

| | Linux (SSH) | Windows (WinRM) |
|---|---|---|
| CPU | `/proc/stat` read **twice, a second apart** — CPU is a rate | `Win32_OperatingSystem` |
| Memory | `/proc/meminfo` (`MemAvailable`) | same |
| Interfaces | `/sys/class/net/*` | `Get-NetAdapter` + `Get-NetAdapterStatistics` |
| Storage | `df -PkT` | `Get-Volume` |
| Processes | inventory + a 60 s pinned/mapped sub-pass | same |
| Event log | `journalctl -o json -p warning` | `Get-WinEvent` levels 1–3 |

Interfaces and storage ride **one connection per host per tick** when both are
on the same transport.

**Still absent over a shell, and correctly reported as such:**

- **Temperature** — Linux hwmon is readable, but `MSAcpi_ThermalZoneTemperature`
  is unimplemented on most real Windows hardware. Neither side ships rather than
  working on half a fleet.
- **LLDP** — no shell equivalent at all.

Two design notes on the event-log stream:

- The window is derived from the stream's own interval (**1.5×**) rather than a
  row count. Asking for "the last N entries" either misses a burst or
  re-ingests a quiet hour; asking for "everything since a bit longer ago than my
  last run" does neither. The deliberate overlap is cheap because the sink
  dedupes.
- The cadence anchor is stamped **even on failure**. An agentless stream that
  re-fires every tick against a bad credential is an AD-lockout risk, and this
  is the one stream where a retry storm would also flood the table it writes
  into.

It stays **opt-in everywhere** (PII and volume), gated by the same global master
switch the agent's event log uses — an operator who turned the feature off must
not have an agentless poller keep filling the audit log.

`processes` is the exception: it is **agent-default-ON**, so an agent host
collects its process inventory automatically.

---

## The `vcenter` method

Covers **four** streams — responseTime, cpuMemory, interfaces **and** storage —
and is the source default for all four, on both VMs and ESXi hosts. That is what
lets a vCenter fleet be monitored with **no credential in the guest, no SNMP on
ESXi, and no reachable guest IP**.

Two warm caches back it (30 s TTL, one SOAP round trip per integration per
tick): VM quick-stats, and a host snapshot paired with the datastore inventory
in one session.

**Absent is not unreachable.** vCenter answering *without this asset in it* is a
real finding and fails the probe; Polaris being unable to **ask** skips it. So a
vCenter outage can never declare an entire virtual fleet down at once.

A host's interfaces arrive **nested**: each vSwitch is written as an aggregate
row with its uplink pNICs and VMkernel ports stamped as children — the
FortiSwitch-trunk shape, so the System tab nests it unchanged. A vSwitch's
operational status is derived (up while any uplink is up, and **null with no
uplinks at all** — an internal-only vSwitch is not an outage).

---

## The `fortimanager` method

**Response-time only**, on the FortiManager source only. It asks FortiManager's
own device database instead of touching the device: one native `/dvmdb` call
covers the whole fleet, so ~187 gates cost **one round trip** — and it reaches a
gate Polaris has no route to, since only FortiManager must be reachable.

Keyed by **serial, never the FMG device name**. FortiManager's device name
diverges from the gate's configured hostname on real fleets, and a name mismatch
would read as "gone from FortiManager".

**FortiManager unreachable ⇒ skipped, never a miss.** One manager outage must
not down a fleet.

What it trades away, and why it is one stream rather than a transport: the
reading is FMG's, on FMG's check-in cadence, so it is **lagged and second-hand**
— it says the chassis is talking to its manager, not that it is serving traffic.
It carries **no uptime**, so it drives no reboot detection. And FMG's database
holds no CPU, memory, temperature, interface counters or session count.

**Not a source default.** Response time stays ICMP, because repointing a default
would silently change how up/down is decided for every gate on every FMG
install.

---

## The HTTP check

Not a polling method. A **manufacturer custom widget**, keyed by manufacturer
plus an optional model pattern ([rule 33](Business-Rules#rule-33)).

The reason is ownership of the *definition*. As a polling method the check had
to ride an `http`-typed credential, so the row answering "how do I log in to
this vendor" also carried "which path, expecting what" — and a second path meant
a second copy of the same password. A check varies by vendor **and model**; a
login varies by vendor.

How it behaves:

| | |
|---|---|
| Body match | **load-bearing** — a 200 whose body does not match **fails**. There is no lax toggle |
| Order | status is judged **before** content |
| Redirects | **never followed** |
| Body | capped at 64 KB |
| Credential | **authentication only**, with no "none" mode |
| Auth mode | **stated, not guessed**. Digest is a handshake — fire bare, read the challenge, re-fire **exactly once** |
| Writes | `AssetStateSample` 0/1 pass-or-fail plus a success-only RTT gauge |
| `monitorStatus` | **never moved** |

---

## FortiManager authentication

FortiManager 7.4.7+ / 7.6.2+ removed `access_token` query-string support.
Polaris uses the Bearer `Authorization` header exclusively, and the standalone
FortiGate integration uses the same pattern.

> **Never call `/sys/logout`.** Polaris authenticates with a predefined REST API
> Admin api-key, which per Fortinet's own best-practices guide is permanent and
> shares one session per user. An hourly logout tore that shared session out
> from under the split-role monitor and discovery processes and caused RPC
> `-11` "no valid session" churn.

The transport retries transient faults only (5xx / network, ≤ 2 retries,
exponential backoff, serialised) and fails fast on permanent ones (401, 403,
404, 405, `-11`).
