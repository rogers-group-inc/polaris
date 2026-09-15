# Concepts and vocabulary

Polaris uses a small number of words precisely. Getting them straight first
makes every other page shorter.

---

## The address-space side

**IP block** — the outermost container. A block is a CIDR you own or have been
allocated (`10.0.0.0/8`, `192.168.0.0/16`). Blocks hold networks.

**Network** (`Subnet` in the API and database) — a CIDR inside a block. This is
the row that means "a broadcast domain exists here". Three rules bind it:

- A network **must be contained** within its parent block.
- Two networks **may not overlap** inside the same block.
- CIDRs are **normalised on write** — typing `10.1.1.5/24` stores `10.1.1.0/24`.

A network carries a status: `available`, `reserved` or `deprecated`.

**Reservation** — one address inside one network, claimed by something. This is
the row that answers "who has `10.1.1.50`?". Only one *active* reservation may
exist per address per network.

**Source type** — *why* a reservation exists. This is the single most important
field on the IPAM side, because it decides whether Polaris may overwrite the
row:

| `sourceType` | Means | Authoritative? |
|---|---|---|
| `manual` | a person typed it | yes |
| `dhcp_reservation` | the gate has a MAC→IP reservation | yes |
| `dhcp_lease` | the gate handed the address out dynamically | **no** — observed presence, supersedable |
| `interface_ip` | the address is on a device interface | yes |
| `vip` | a virtual IP / NAT mapping | yes |
| `fortiswitch` / `fortinap` | a managed Fortinet device holds it | depends on its DHCP binding |
| `fortimanager` / `fortigate` | discovered through that integration | yes |
| `dns_resolved` | auto-created because an asset's IP fell in a known network | **no** — defers to everything |

**DHCP binding** — *how* the gate hands the address out: `null`, `"lease"` or
`"reservation"`. This is deliberately a **separate fact from source type**
([rule 23](Business-Rules#rule-23)). "Who owns this address" and "how does the
gate serve it" are two different questions, and folding them into one field is
how IPAM tools start lying.

**Exclusion** — a CIDR declared out of scope for the networks list entirely.
Exists because some address space is genuinely the *same* at every site — an
out-of-band management VLAN, an appliance's fixed subnet — so one shared row
would collide with every site that serves it. See
[rule 42](Business-Rules#rule-42).

---

## The device side

**Asset** — a device. Anything with a presence on the network: firewalls,
switches, access points, servers, workstations, printers, VMs, hypervisors,
Kubernetes clusters. Asset types are a **registry**, not a fixed list — you can
add your own.

**Asset source** (`AssetSource`) — **one report about a device from one
system**, keyed on `(sourceKind, externalId)`. An asset that Active Directory,
Intune and a FortiGate all know about carries three source rows.

**Projection** — the derived Asset row. Polaris does not let a discovery run
write straight over the asset; instead every source reports what *it* saw, and
`projectAssetFromSources()` picks a winner per field by a fixed priority:

```
polaris-agent  (the host's own truth)
  > vcenter-vm / vcenter-host
  > arc-FQDN > AD-FQDN > Intune > Entra > arc-short
  > FortiGate sources
```

For OS, serial, manufacturer and model, **Azure Arc ranks second** — the
Connected Machine agent reads the running OS and live SMBIOS in-guest on every
check-in, while AD's `operatingSystem` lags and VMware Tools reports the
*configured* guest OS.

This is why a field can look "wrong" and be correct: it is showing you the
highest-priority source's answer. The asset's **Sources tab** shows every
source's answer side by side, and the **Sources** section of the Assets
Settings modal lets you reorder the priority for learned location.

**Pins** — operator overrides that freeze a projected field against discovery.
Three exist: `hostnameOverride`, `ipOverride` and a manual coordinate source.
Set them by editing the field in the asset form; clear them by blanking it.

**Monitor status** — six values, and they are not what you may expect:

| Value | Means |
|---|---|
| `up` | answering |
| `warning` | has missed polls, but fewer than the threshold |
| `down` | missed the covering automation's `missedPolls` count |
| `recovering` | answered again, but has not yet answered enough times to be called up |
| `passive` | **no automation covers this device, so Polaris renders no verdict** |
| `unknown` | never probed, or the probe could not run |

`passive` is the one that surprises people. Polaris deliberately does not
define "down" on its own — **the automation defines it**
([rule 36](Business-Rules#rule-36)). A device no down-automation covers is
still polled, still sampled and still charted; Polaris just declines to judge
it. Anything testing `status !== "up"` as a proxy for "unreachable" is wrong.

**Stream** — one kind of telemetry collected on its own cadence. There are
eight: `responseTime`, `cpuMemory`, `temperature`, `interfaces`, `lldp`,
`storage`, `processes`, `eventLog`.

**Polling method** — *how* a stream is collected for a given asset: `icmp`,
`snmp`, `ssh`, `winrm`, `rest_api`, `agent`, `vcenter`, `fortimanager`, or
`disabled`. Resolved per stream from a four-tier hierarchy. See
[Polling methods](Polling-Methods).

---

## The alerting side

**Automation** (`NotificationRule`) — the whole unit: which devices, what to
watch, at what severity, what to do about it, when it resets. Built in a
six-step wizard.

**Alert** (`Notification`) — one live instance of an automation firing about
one device (and, where the metric has dimensions, one interface or sensor or
mount). It has a lifecycle: raised → optionally acknowledged → cleared.

**Trigger** — what the automation watches. Five kinds: a metric threshold, a
device-state field, an event arriving, a field changing, or a composite tree
combining several.

**Severity band** — an extra tier stacked on the base trigger, so one alert
climbs and eases in place rather than firing several. Severities must strictly
increase. See [rule 19](Business-Rules#rule-19).

**Action** — what happens when it fires: `notify`, `api_call`, `script` or
`event`. The in-app alert card is **not** an action — it always happens,
because everything else keys on its id.

**Escalation** — a chain of further actions taken when nobody handles the
alert. Per severity, not per action.

**Reminder** (`repeat`) — re-sending the notify actions on a clock while the
alert stays live. Per action, so "page the on-call every five minutes and leave
the nightly digest alone" is one automation.

**Reset** — what has to become true again for the alert to end. Defaults to the
trigger inverted.

**Dimension** — the part of a device an alert is about: an interface name, a
sensor name, a storage mount, an IPsec tunnel, an SD-WAN rule. A per-dimension
automation raises one alert per matching part.

**Pin** — the operator's statement that a sub-asset may alert. Interfaces,
IPsec tunnels and storage mounts each have a pin array on the asset, and **an
unpinned member never alerts** ([rule 57](Business-Rules#rule-57)), however
much sample data exists for it.

---

## Cross-cutting

**Integration** — a configured connection to an external system. Seven types.
Every one is optional and absent by default.

**Discovery run** — one execution of an integration's discovery, in numbered
phases. Manual or on the integration's `pollInterval`.

**Conflict** — something discovery found that it refuses to resolve on its own:
a discovered value differing from a manual reservation, two assets on one
address, a firewall chassis that appears to have been replaced, an IP override
discovery disagrees with. Conflicts queue for a human.

**Event** — the audit log. Every create, update, delete and discovery result
writes one. Events older than 7 days are pruned; syslog (CEF) and SFTP/SCP
archival are configurable.

**Tag** — a label on an asset, block or network, from a registry. Tags can be
auto-assigned by a device filter.

**Region** — a polygon drawn on the Device Map. Regions **nest**, and the
nesting is load-bearing: alert routing can address "the device's own innermost
region" (L1) or "the division containing it" (L2). A region is also a tag,
stored as `region:<name>` in a locked registry category.

**Credential** — a stored secret (SNMP, SSH, WinRM, REST API, HTTP). Sealed at
rest. Credentials carry an ownership dimension: at `write` you reach only the
ones you created.

**Function key** — one of 33 permission keys. Each route declares the key it
gates plus a level: `none` / `read` / `write` / `fullwrite`. See
[Users, roles and permissions](Users-Roles-and-Permissions).

---

## Three ideas that explain most of Polaris's behaviour

**1. Absence of evidence is not evidence of absence.** A device a discovery run
could not read keeps its old data and is *named* as unread, never folded in
with one that was deliberately skipped ([rule 53](Business-Rules#rule-53)). An
address missing from an ARP table is not proof it is gone
([rule 17](Business-Rules#rule-17)). A controller Polaris cannot reach has *no*
opinion about its own links, rather than a negative one
([rule 59](Business-Rules#rule-59)).

**2. Provenance decides who may overwrite what.** Every discovered fact carries
the source that reported it, and the write rules are expressed in terms of
those sources rather than "last writer wins". This is what lets Polaris merge
five systems' views of one laptop without any of them clobbering the others.

**3. The operator's statement outranks the inference.** A pin, an override, a
manual reservation, an exclusion, a rejected conflict — each is a recorded
human decision, and discovery is written to defer to it rather than to
re-litigate it every cycle.
