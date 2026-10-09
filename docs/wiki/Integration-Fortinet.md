# FortiManager and standalone FortiGate

The two Fortinet integrations are **paired surfaces**. FortiManager fronts many
FortiGates; standalone FortiGate talks to one. They reach the same FortiOS
device fleet over different transports, so most features exist on both and the
modal tab layouts are deliberately identical.

Only genuinely FMG-only things differ: the multi-FortiGate device filter, ADOM
scoping, and FMG-proxy concurrency tuning.

---

## Configuring FortiManager

### General

On-premises FortiManager **7.4.7+ or 7.6.2+** only (not FortiManager Cloud) —
older versions do not support bearer-token authentication.

| Field | Default | |
|---|---|---|
| Host | — | FortiManager address |
| Port | 443 | |
| API user | — | a **predefined REST API Admin** |
| API token | — | secret |
| ADOM | `root` | |
| Management interface | — | which interface name to read for a gate's management IP |
| Verify SSL | **on** | |
| Enabled / Enable auto-discovery | on | |
| Auto-Discovery Interval | 12 hours | 1–24 |
| Verbose logging | off | always last |

The transport settings are **not** on General. They sit at the top of the
**Monitoring** tab's **FortiGate** subtab, under *Direct polling*:

| Field | Default | |
|---|---|---|
| **Direct Polling** | **off** (= proxy mode) | see below |
| Parallel FortiGate Queries | 5 in direct mode | 1–20; proxy mode is always one at a time |
| FortiGate API user / token | — | used by Direct Polling **and** by any monitoring stream set to REST API, in either mode. One token for the whole fleet; a gate with its own api-user takes a REST API credential on its stream instead |
| Verify SSL certificate on FortiGates | **on** | |

> **Never configure Polaris to call `/sys/logout`.** It authenticates with a
> predefined REST API Admin api-key, which per Fortinet's own best-practices
> guide is permanent and **shares one session per user**. A logout tears that
> shared session out from under the split-role monitor and discovery processes
> and produces RPC `-11` "no valid session" churn.
>
> Also note FortiManager 7.4.7+ / 7.6.2+ does not accept an `access_token`
> query string; Polaris uses the Bearer header exclusively.

### Proxy vs direct mode

| | **Proxy** (`useProxy: true`, Direct Polling unticked — the default) | **Direct** |
|---|---|---|
| Discovery reads | through FMG's `/sys/proxy/json` | straight to each FortiGate's REST API |
| Needs | FMG reachable | Polaris routable to every gate |
| Concurrency | FMG's proxy lane is **concurrency-1** | parallel per gate |
| FortiGate token | optional for discovery | **required** |

**The combination that surprises people:** proxy mode **with no FortiGate API
token** cannot make a FortiOS call at all, because every FortiOS *monitoring*
collector dials the asset's own IP and needs that token. So cpuMemory,
temperature and interfaces fall back to `disabled`, the dropdowns grey out, and
a note names the token as the thing that unlocks them. See
[Polling methods](Polling-Methods#the-fortimanager-proxy-gotcha).

**Proxy *with* a token is a legitimate setup** — discovery and writes ride FMG,
monitoring reaches the gates directly — and keeps the normal REST defaults.

### Filters

Each filter is an **Include** or **Exclude** list — one mode at a time —
with wildcards (`port*`, `*wan`, `FG-*`). Empty means everything.

| Filter | Matches |
|---|---|
| FortiGate Device Filter (`deviceInclude` / `deviceExclude`) | managed FortiGates' device name or hostname — FMG only |
| DHCP Filter (`dhcpInclude` / `dhcpExclude`) | the **interfaces** whose DHCP server scopes are discovered |
| Interface Filter (`interfaceInclude` / `interfaceExclude`) | the interfaces whose own addresses become interface-IP reservations |
| Device Inventory (`inventoryIncludeInterfaces` / `inventoryExcludeInterfaces`) | the interfaces whose attached devices feed asset discovery |

### Monitoring

Per-class blocks — **FortiGate**, **FortiSwitch**, **FortiAP** — each carrying
`addAsMonitored`, per-stream polling methods and credentials. The switch and AP
blocks also carry the SNMP-direct-polling toggle.

Plus `monitorCredentialId` (SNMP) and `sshCredentialId`, used when a stream's
resolved method needs them.

### Push toggles — all off by default

| Toggle | Does | Requires |
|---|---|---|
| **`pushReservations`** (DHCP Push) | manual reservations on discovered networks are written to the gate at create time, **verified by read-back**; any failure aborts the create entirely | write access to DHCP config |
| **`pushQuarantine`** | quarantining an asset pushes MAC address-group entries to every gate that has sighted it within the sighting window | address-group write access |
| **`autoReserveFortinetInfra`** | each cycle pins the address a managed switch or AP **already holds by lease**. Occupancy does not change | `pushReservations` |
| **`adoptDiscoveredMac`** | replaces a synthetic **placeholder** MAC with the real one and re-pushes. Only ever overwrites a MAC matching the placeholder prefix | `pushReservations` |
| **`syncFortigateDescriptions`** / **`syncSwitchDescriptions`** / **`syncApDescriptions`** (Description Sync) | writes Polaris descriptions back to the devices — one toggle each for FortiGates, FortiSwitches and FortiAPs | proxy mode: device-config write on the FMG admin profile. Direct mode and standalone FortiGate: **System → Read-Write** on the gate's REST API access profile (plus Network → Configuration, and WiFi & Switch Controller when the gate manages switches / APs) |
| **`pullSdwan`** | pulls SD-WAN health-check metrics and rule member selection | — |
| **`arpPresenceSweep`** | fires one datagram at every reserved IP so the gate ARP-resolves it | — |

`pushReservations`, `arpPresenceSweep`, `autoReserveFortinetInfra` and
`adoptDiscoveredMac` are on the **DHCP Push** tab; the others on the tab of
their own name (**Quarantine Push**, **Description Sync**, **SD-WAN**).

Three of these deserve their own note:

**`autoReserveFortinetInfra` is off deliberately** and not out of caution: every
other DHCP write Polaris makes is one operator acting on one address, whereas
this one runs on a schedule across a fleet. It is bounded per cycle, takes the
MAC only from the gate's own lease table, and verifies by read-back.

**Description Sync is Polaris-primary** ([rule 14](Business-Rules#rule-14)).
A non-empty Polaris value **always wins** — pushed on save, re-asserted by every
reconcile, device-side edits overwritten. An **empty** Polaris field adopts the
device value. There is no conflict state. Under FMG central management, pushes
are additionally mirrored into FMG's database.

It is switched on **per device class**: FortiGates (the alias and interface
comments), FortiSwitches (switch and port descriptions) and FortiAPs (the AP
location field) each have their own toggle, so you can sync switches without
touching APs.

**FortiAP descriptions through FortiManager: use with caution.** This path is
not implemented well. AP Manager keeps its own copy of each AP's location, and
Polaris only mirrors into it when central AP management is detected — a
FortiManager install can still revert or overwrite what Polaris pushed. Try it
on a few APs before turning it on for a whole ADOM. The FortiManager
integration's Description Sync tab carries the same warning.

When the writes go **direct to the gate** (FMG bypassing the proxy, or a
standalone FortiGate), the access profile must grant **System → Read-Write**.
The FortiGate alias lives in `system/global`, which FortiOS puts in the System
group rather than Network. Without it the alias write is refused, but interface
descriptions still sync, so the feature can look like it partly works. System
Read-Write also covers administrators and global settings, so treat that token
as an admin-grade credential.

**The same token can upgrade FortiGate firmware.** In
[Server Settings → Repository](Server-Settings#repository), a Firewall node
can be bound to **Integration API token**: each gate is then upgraded with the
FortiOS API token of the integration that discovered it (a standalone
FortiGate's API token, or the FortiManager's *FortiGate API token*), sent
straight to the gate, never through FortiManager. Firmware upgrade is a
System write, so this too needs **System → Read-Write** on the token's access
profile ([rule 87](Business-Rules#rule-87)).

**`arpPresenceSweep` is IDS-visible.** It also requires Polaris→subnet routing
and a permitting policy to have any effect; where the packet cannot reach, the
sweep silently does nothing — and **absence of an ARP entry is never treated as
evidence of absence** ([rule 17](Business-Rules#rule-17)).

**`pullSdwan` is read-only and FortiOS-only** ([rule 13](Business-Rules#rule-13)).
It **never writes to the device**. Where FortiOS will not expose the runtime
selected route over REST, the value is *inferred* and labelled as such in the
UI.

SD-WAN has its own polling pass, separate from the interface scrape. The SD-WAN
tab's **Polling Interval (seconds)** field — `sdwanIntervalSeconds`, 60 to
86400, default **60** — sets how often each REST-polled FortiGate is asked for
its health-check readings and rule selection. It is the same field on the
FortiManager and standalone FortiGate integrations. SLA charts and SD-WAN
alerts therefore move once a minute by default, and an SD-WAN automation
"sustained for N polls" means N reads at this interval. Only gates whose
interfaces are polled over FortiOS REST are asked. A gate moved to SNMP gets no
SD-WAN reads.

Also on the Monitoring tab, under the FortiGate subtab's LLDP stream:
**`excludeFortilinkLldp`**, which stops internal FortiGate↔FortiSwitch links
appearing in the LLDP Neighbor column. **`switchManagementInterface`** — the
interface name read for a managed switch's management access — has no field in
the modal; it is set through the [API](API) on the integration's config.

---

## Configuring a standalone FortiGate

The same shape, minus FMG: **host · port · API user · API token · VDOM
(`root`) · management interface · verify SSL** on General — the token comes from
a **REST API Admin** created on the gate (System → Administrators) — the DHCP,
interface and device-inventory filters (no device filter), the same push
toggles, and the same per-class monitoring blocks.

Feature parity with FMG is a standing rule for this project — if a feature
exists on one and could sensibly exist on the other, it does.

---

## What discovery produces

### Networks

Discovered from the gate's interfaces, subject to the interface filters. Each
records the **serial of the gate serving it** alongside the device name.

**A subnet dies with its FortiGate, and the chassis — not the name — says which
gate that is** ([rule 41](Business-Rules#rule-41)). A name cannot tell a rename
from a replacement, and those need opposite handling.

How it works:

- **Tri-state in both directions.** A null stored serial is *unknown* and
  **learns** on first sight, so nothing is backfilled and every row converges on
  its own. An **unreadable** serial this run is *unknown* and applies no
  constraint — never "different", or one failed read would declare the fleet
  replaced.
- **The comparison is against a set, per device** — the reporting gate's serial
  plus every HA member — because FMG flips a cluster's top-level serial to
  whichever member is active, and comparing against one value would report a
  replacement on every failover.
- Anything outside that set raises a **`chassis-replaced` conflict**, which is
  **additive**: the old chassis's network and reservations are **copied** to the
  archive, nothing is released, re-pushed or deleted, and the stored serial is
  deliberately not re-pointed while the conflict is pending.

Without this check a same-name RMA swap would be **silent**: it matches by
CIDR, matches the roster, and lets the new chassis inherit every reservation row
of the old one — `pushStatus: "synced"` and dead device-side pointers included.

A swap that keeps the device name (FortiManager's serial swap) also retires the
**old gate's asset** on the next run: the name is still on the roster, but the
gate answering under it is a different chassis. Its switches and APs stay — they
belong to the new gate. The per-network conflicts appear as **one card** on the
[Conflicts](Conflict-Resolution#one-swap-one-card) page.

Discovery also **retires a dead row itself**: when a live gate re-reports the
range of a previously archived network, it is archived forward — but **only when
a different gate is serving it**, since an operator who archived a network its
own gate still serves would otherwise have that decision silently undone.

### Reservations

| Kind | Source |
|---|---|
| **DHCP reservations** | the CMDB tree **merged with** the live monitor |
| **DHCP leases** | the live monitor |
| **Interface IPs** | the gate's own interface addresses |
| **VIPs and load-balance virtual servers** | the firewall VIP table |
| **FortiSwitch / FortiAP addresses** | the managed-device inventory |

The CMDB/monitor **merge is intentional**: the monitor endpoint only returns
reservations whose target is currently leasing, so trusting it alone would
silently drop static reservations whose target happens to be offline at
discovery time. CMDB is the base set; the monitor adds what it does not cover;
CMDB wins on overlap by IP.

**The FortiGate is authoritative for its own CMDB DHCP reservations.** At the
end of every per-device sync, any active `dhcp_reservation` row whose gate
answered this cycle but whose address is not in the answer is **released** —
covering both fresh CMDB rows and Polaris-pushed manual reservations that
flipped on first sight, because operator-deleted-on-gate is the same observable
state in both cases.

Leases, and the `fortiswitch` / `fortinap` rows, are **deliberately not swept**:
leases age out on their own, and the infra rows' lifecycle belongs to the
decommission pass.

**The FortiGate is authoritative for its own VIPs** in the same way, with a
succession rule: when a lease lands at an address whose VIP has just
disappeared, the row converts **in place** — source type flips, VIP metadata
clears, MAC fills if empty, and **operator-edited hostname, owner and notes
survive**. Only Polaris's own canonical placeholders are replaced.

Load-balance **virtual servers** ride the same query. The VS's external address
reserves with role `external`, and **each realserver pool member gets its own
reservation** with role `realserver`.

### Assets

FortiGates, managed FortiSwitches, managed FortiAPs, and — from device
inventory, MAC tables and ARP tables — **endpoints**.

**Resolving a managed switch's or AP's parent never matches against a
hostname.** `controllerFortigate` holds FortiManager's *device name*, which
diverges from the gate's configured hostname on real fleets. Because "no parent"
is a legitimate state, that mismatch **fails silently** — across dependency
suppression, Device Map membership, region tags and FortiLink auto-monitor
alike.

### Geographic coordinates

The toggles below live on the **Geographic Location** tab (FortiManager also
names its latitude, longitude and optional address metavariables there).
Coordinates are resolved through three tiers, highest first:

1. **SNMP-geocoded `sysLocation`** — pulled when `pullSnmpLocation` is on, and
   geocoded only when the companion `useSnmpLocationCoords` toggle is **also**
   on. With the second toggle off, `sysLocation` is still pulled and stored for
   display (and pre-fills the asset form's Location field) but never drives
   coordinates. The coords override is a separate opt-in precisely because this
   tier outranks the device-learned ones below.
2. **FortiManager metavars** — per-device `Latitude` / `Longitude`. FMG only.
3. **CMDB GUI coordinates** — `gui-device-latitude` / `-longitude`.

Each tier validates the pair **as a whole** (rejecting null, NaN, (0,0) and
out-of-range); a half-valid tier falls through rather than mixing values.

**When the lookup fails.** Polaris asks OpenStreetMap first and the US Census
geocoder second. Rural roads are often in neither, and then the pin keeps
tier 2 or 3 — which may be an old pair from before the gate moved. Two things
say so: the asset's **Coordinates** row reads *⚠ lookup failed — address not
recognised* (or *geocoder unreachable*), with the address in its tooltip, and
an `asset.location.geocode_failed` warning lands on the asset's **Events** tab.
A no-match is remembered for 90 days, so the same text is not retried; change
the text (a city, state and ZIP usually resolves), or set the coordinates
directly — a manual pin on the asset, the FortiManager `Latitude` / `Longitude`
metavariables, or the gate's own GUI coordinates.

**Coordinate write-back** (`pushGeocodedCoords`, off by default) writes the
geocoded pair back to the gate when it differs by more than about a metre. In
FMG mode the CMDB write lands in FMG's database and **requires an operator
Install Device Configuration** to reach the live gate — Polaris does not trigger
installs.

### HA clusters

FortiManager already exposes the HA mode and member list on every device
record, so Polaris reads them at **zero extra call cost**. The standalone path
calls the HA-peer monitor endpoint, which reports the cluster only to a token
whose profile can read it — a gate answering everything else while showing no
cluster is worth checking there first.

Key behaviours:

- **Per-member assets are keyed by the member's own serial**, never by the
  cluster's hostname or top-level serial — both flip on failover.
- The **standby** gets `ipAddress = null` (the cluster IP routes only to the
  active member), inherits the cluster's model, firmware and coordinates, is
  tagged `ha-standby`, and defaults to **not monitored** — a failover's
  ex-primary must stop burning probe slots on a null-IP row.
- The shared **cluster IP is display-only**, never `Asset.ipAddress`.
- A standby reported down writes a warning Event; recovery writes the
  counterpart. Both are **suppressed when the roster came from FMG's cached
  configuration** — a stale roster is not evidence.
- The decommission sweep is HA-aware: an asset whose serial appears in any
  discovered device's member list is "still configured" even when absent from
  the top-level roster.
- The **topology graph drops the standby**, which would otherwise hang off the
  same switches as the primary and duplicate the cluster.
- For suppression, an **unmonitored standby parent is ignored** — not
  transparent-ok — so switches cabled to both members still suppress on the
  primary's confirmed-down alone.

### The controller-link sweep

Separately from discovery, a 60-second sweep asks each parent FortiGate what it
thinks of its **FortiLink session** to each managed FortiSwitch, and its
**CAPWAP tunnel** to each managed FortiAP. See
[`fortilinkStatus`](Automation-Triggers#fortilinkstatus--the-second-opinion).

It sweeps **every** managed switch and AP regardless of polling method, which is
the point: the devices it tells you something new about are the ICMP- and
SNMP-polled ones, **where a dead FortiLink session still answers every ping**.

Cost is bounded by **controller count**, not device count.

---

## The FortiLink / CAPWAP membership rule

Discovery asks each gate for the switches and APs it manages and stamps the
answer **on the gate**. That roster then **bounds the dependency graph** — any
adjacency it contradicts is dropped.

It is **tri-state**: absent means unknown and constrains nothing; empty means
"manages none"; populated constrains. The stamp is written **only when the
roster read answered** — which is what keeps a failed read from reading as
"manages nothing" and silently costing a gate its subtree.

Membership can only **reject** an edge, never assert one. It is matched on
**serial**, never on the switch-id (which is renamed to the hostname on
FortiLink fleets).

It is also kept strictly separate from the serials that vouch for assets against
the decommission sweep: FMG's device database is *intended* configuration, so
letting membership reach a sweep would turn a config-retrieval lag into deleted
inventory.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| A gate shows pre-upgrade firmware while FMG shows the right version | the run's **unread** count and the `devices_unread` Event. The gate is being *monitored* fine and *read* by nothing |
| Every FortiOS stream reports "API token not configured" | proxy mode with no FortiGate API token — see above |
| RPC `-11` "no valid session" churn | something is calling `/sys/logout`, or two processes share one api-key session |
| A `chassis-replaced` card about a box nobody swapped | shared address space across sites — add a [network exclusion](IPAM#exclusions) |
| A managed switch has no parent, and suppression never fires for its subtree | the parent-key resolution trap: something is matching `controllerFortigate` against a hostname |
| Coordinates are wrong after enabling `pullSnmpLocation` | `useSnmpLocationCoords` is the separate toggle that lets it drive coordinates |
