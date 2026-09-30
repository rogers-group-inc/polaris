# How discovery works

Discovery is how devices, networks, reservations and VIPs get into Polaris
without anyone typing them.

Seven integration types feed it. Every one is **optional and absent by
default** — but they are what Polaris is built around. An install with none
still works (hand-entered assets, monitored over SNMP / SSH / WinRM / ICMP or
the agent, plus the address registry), it just does the smaller half of the
job.

| Type | Reads | Produces |
|---|---|---|
| **[FortiManager](Integration-Fortinet)** | many FortiGates via FMG | assets, networks, reservations, VIPs |
| **[FortiGate](Integration-Fortinet)** (standalone) | one device via REST | same |
| **[Entra ID / Intune](Integration-Directory)** | Microsoft Graph | assets |
| **[Active Directory](Integration-Directory)** | LDAP / LDAPS | assets |
| **[Windows Server](Integration-Windows-Server)** | WinRM DHCP | networks, reservations |
| **[VMware vCenter](Integration-vCenter)** | vSphere REST + two SOAP calls | assets, datastores |
| **[Azure Arc](Integration-Azure-Arc)** | Azure Resource Manager | assets |

Runs are triggered manually, or by the scheduler on each integration's
`pollInterval` (hours).

---

## The multi-source model

This is the idea that makes discovery safe, and it is worth understanding before
anything else.

**Discovery never writes straight over the asset.** Every pathway upserts an
`AssetSource` row — one report, from one system, keyed on
`(sourceKind, externalId)`. Then `projectAssetFromSources()` derives the Asset
row by **priority per field**:

```
polaris-agent          the host's own truth
  > vcenter-vm / vcenter-host
  > arc-FQDN > AD-FQDN > Intune > Entra > arc-short
  > FortiGate sources
```

For **OS, OS version, serial, manufacturer and model**, Azure Arc ranks
second — directly below the agent. The Connected Machine agent reads the
*running* OS and live SMBIOS **in-guest on every check-in**, whereas AD's
`operatingSystem` lags until the computer object re-registers, and VMware Tools
reports the *configured* guest-OS identifier.

So an asset that AD, Intune, Arc and a FortiGate all know about carries four
source rows, each with its own answer, and the Asset row shows the
highest-priority one per field. The asset's **Sources tab** shows all of them.

### Three operator pins freeze a projected field

| Pin | Set by | Cleared by |
|---|---|---|
| `hostnameOverride` | editing Hostname in the asset form | blanking it |
| `ipOverride` | editing IP | blanking it |
| manual coordinates | setting them by hand | — |

The hostname pin is enforced centrally: any write staging a hostname has the pin
re-asserted over it. Pinned assets are also excluded from the
duplicate-hostname ghost merge.

**The IP pin gets a vote from discovery.** A discovery write staging the
*same* IP as the pin **releases it** in that write (self-disabling, audited). A
*different* staged IP is re-asserted back to the pin and raises **one pending
conflict per asset** — accept adopts the discovered IP and releases the pin;
reject keeps it and suppresses re-raise for that same IP.

### How a device is re-found across runs

In order:

1. `AssetSource` on `(sourceKind, externalId)`
2. **on-prem SID match** — this is what links AD to Entra/Intune for a
   hybrid-joined device
3. **Ethernet MAC match** (Entra only)
4. **hostname collision** — which raises a **conflict**, never a silent merge

---

## A run reports what it could not read

**A device a run could not read keeps the data it already had — so it is
named** ([rule 53](Business-Rules#rule-53)).

Two counters that must never be summed into one "skipped" figure:

| Counter | Means |
|---|---|
| `skippedOffline` | **routine.** A staged gate awaiting deployment sits offline in FortiManager for weeks, and Polaris reads its cached configuration on purpose |
| `skippedError` | the device was **never reached** |

`unread` devices are additionally **named** in a warning Event, because the
alternative is silence. The Discovery Activity widget and the nav's status
panel render them as separate `· N offline` / `· N unread` parts.

> Why this matters more than it sounds. A FortiGate that direct-mode discovery
> cannot reach is not *partially* discovered — it is dropped from the run
> entirely. Every field discovery owns keeps its last value and keeps presenting
> it as current, because the projection writes are null-guarded precisely so an
> absent read never *blanks* a good value. The same guard means an absent read
> never *corrects* one either. Meanwhile monitoring dials a different address
> with a possibly different credential, so the gate polls green throughout:
> **"it is being monitored fine" is not evidence that anything has read it.**

---

## Post-sync passes

After the type-specific phases, a run performs up to four fleet-wide passes:

| Pass | Applies to | Default |
|---|---|---|
| **Agent auto-deploy** | AD / Entra / Arc workstation and server classes | **off** |
| **Interface + storage auto-monitor** | same (storage is AD/Entra only) | off |
| **Network-presence verification** | AD / Entra / Arc / vCenter | **on** |
| **Directory (GAL) sync** | Entra / AD | **off** |

**Presence verification** establishes `Asset.lastSeen` for directory-sourced
assets, cheapest signal first: already-fresh lastSeen → agent heartbeat →
answering monitor probe → a single ICMP against the DNS name. **A failed ping
writes nothing.**

Auto-monitor pins land the cycle *after* an agent first reports, since these
devices only report interfaces and mounts via the agent. That is self-healing,
not a bug.

Directory sync runs **last**, so a directory outage cannot affect the asset
passes, and it is never its own scheduler job.

---

## `Asset.lastSeen` means verified network presence

One rule governs every writer ([rule 12](Business-Rules#rule-12)):

- It is written through **one function**, which never regresses it and stamps
  provenance.
- **Polling is authoritative for monitored assets.** When `monitored = true`,
  the discovery-origin sources — plain discovery, device inventory, DHCP lease,
  vCenter, Arc — are **refused**, so they cannot advance presence past what
  polling established.
- **A failed probe writes nothing.**
- Device inventory outranks the DHCP lease for unmonitored assets.
- Fortinet-discovery-owned infrastructure never takes client-sighting presence
  at all.

---

## Scoped (single-device) discovery

The asset slide-over's **Discover Now** button narrows a run to one device.
Polaris picks the right integration and the right scope:

| Asset | Scope |
|---|---|
| FortiGate | that device in FortiManager |
| FortiSwitch / FortiAP | its **controller gate** |
| Entra / Intune | a Graph device-id filter |
| AD computer | an LDAP `objectGUID` filter — keyed on the GUID because a DN changes when an object moves OU |
| vCenter VM / host | by managed-object reference |
| Arc machine | by ARM resource id |

A scoped run:

- **never** stamps the integration's last-discovery time or feeds the duration
  baseline;
- **skips all four post-sync passes** — they read the database fleet-wide, and
  auto-deploy in particular would start agent installs across the whole fleet
  from one click;
- for vCenter, additionally suppresses the dependency-edge delete-replace, the
  datastore delete-replace, and the **disappearance sweep** (which
  decommissions assets, so it carries a second independent guard).

Entra, AD and Arc need no such mode — none of those syncs has a fleet-absence
pass.

---

## Deciding what has gone away

Each integration answers "this device is no longer here" differently, and the
differences are deliberate.

| Integration | Decommission signal |
|---|---|
| FortiManager / FortiGate | absence from the roster, with HA-awareness and a CMDB vouching pass |
| vCenter | **absence, but only if nothing else claims the asset** |
| Entra / Intune / AD | only the directory object's own **disabled** flag |
| Azure Arc | **never writes status at all** |

**The vCenter rule is the one to internalise**: when a VM or host leaves the
inventory, the stale vCenter source rows are deleted — and an asset thereby left
with **no `AssetSource` row at all** is flipped to `decommissioned`. Any
surviving source — a directory record, an Arc row, a reporting agent, the
`manual` row of an operator-created asset — leaves the asset untouched.

And **absence only counts when the read was whole**: an incomplete inventory (a
per-host VM list failed) or an empty one skips the pass, deletes included. VMs
still present in the raw pre-filter listing are retained, so changing an
include/exclude filter **decommissions nothing**.

---

## Conflicts

Discovery raises a conflict rather than guessing. See
[Conflict resolution](Conflict-Resolution) for the whole queue.

| Flavour | Raised when |
|---|---|
| field conflict | a discovered value differs from an existing **manual** reservation |
| hostname collision | a new device's hostname matches an existing asset |
| `duplicate-ip` | two network-present devices claim one address |
| `chassis-replaced` | a network's serving FortiGate reports a different chassis serial |
| ip-override | discovery disagrees with an operator's IP pin |

---

## Running and watching a discovery

**Integrations** page → the row's **Discover** button, or the scheduler.

The **Discovery Activity** dashboard widget shows in-flight runs with per-run
progress and amber telemetry for slow runs. The sidebar carries a status panel
for the same thing.

Every run writes Events. A run that hit errors writes them at warning level with
the device names attached.

### Verbose logging

Every integration has a **Verbose Debug** section at the bottom of its General
tab. Turning it on makes the next discovery cycle — **and every monitor job for
assets owned by that integration** — emit step-by-step structured logs at info
level.

High volume. Flip it on to diagnose, flip it off when done.

### The Query API

Every integration type has a **Query API** button that proxies a raw read to the
upstream system. It is the operator's self-service way to answer *"why didn't
device X get discovered?"*.

When a FortiGate query cannot connect at all, the response reads
**Could not reach FortiGate at `<address>:<port>` — `<reason>`**, where the reason
is a timeout, a refused connection, no route, a TLS certificate rejection, or a
reply that was not JSON. On a FortiManager integration in **Directly to
FortiGate** mode the address is not one you typed: it is the device's
management IP as FortiManager reports it on the integration's **Management
Interface**, and the message says so. A device that is up but unreachable at
that address usually means the interface resolves to an IP Polaris cannot
route to, the gate's HTTPS admin port is not 443, or HTTPS admin access is off
on that interface. Try the same query in **FortiManager (JSON-RPC)** mode to
confirm the device itself answers.
