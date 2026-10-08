# Network Discovery (active scan)

A **Discovery** is a saved sweep of IP ranges you name. It is the only Polaris
feature that touches hosts it has **no prior relationship with**, so the posture
matters more than the mechanism ([rule 34](Business-Rules#rule-34)).

It lives on the **Assets** page: **+ Add Asset(s) → New discovery** starts one,
and **Saved discoveries** lists them (row menu: *Open…*, *Run now*, *Export
config*, *Delete*). It is for equipment that answers SNMP or an API but belongs
to no controller and no directory — PDUs, UPSes, sensors, cameras, older
switches.

| Gate | Grants |
|---|---|
| `networkScan:read` | browse the Discoveries you can see, and watch a run |
| `networkScan:write` | create, run, import, and edit/delete **your own** |
| `networkScan:fullwrite` | edit and delete anyone's |
| **plus `assets:write`** | **required, chained, to adopt** what a scan found |

Seeded `admin:fullwrite`, `readonly:read`, `networkadmin`/`assetsadmin`:`write`,
and **`user:none`** — that role exists for IP-space self-service.

---

## Scanning and adopting are separate grants

This is the whole permission design. **Running a Discovery creates nothing.** So
a role may be allowed to find out what is on a range without being allowed to
put it in inventory.

The wizard **renders** the missing grant rather than discovering it at the POST,
so you find out before you have filled in the form.

---

## What it is not

- **Not a tenth integration type.** It creates no `Integration` row and no
  integration discovery run.
- **No `network-scan` source kind.** An adopted asset is created exactly like a
  hand-typed one — a `manual` source row — with its provenance in the asset's
  notes (*Found by Polaris Discovery "…" at …*) and in an Event.
- **No scheduler.** There is no recurring sweep, and no shipped default range.
  You run it when you mean to.

It is **opt-in and IDS-visible**, and that is stated where you use it.

---

## The wizard

Seven steps:

```
Name → Targets → Methods → Run → Results → Monitor → Summary
```

### Targets

Typed as ranges, CIDRs or single addresses — up to 50 rows and 65,536
addresses. A live preview resolves what you typed as you type, with no packets
sent, and reports how many of those addresses inventory already carries.

A **Subnet (CIDR)** row also lists the IPv4 networks IPAM already knows when
you click into it. Typing filters the list by CIDR, name, VLAN, FortiGate or
block — every word you type has to match, so `ash 20` finds Ashfield's VLAN 20
— and a click or Enter fills in the CIDR. Deprecated networks are left out. The
box still accepts any subnet you type, including one IPAM has never seen. You
need read access to Networks to get the list; without it the row is a plain
text box.

### Methods

Pick from **ICMP (ping)**, **SNMP**, **REST API**, **SSH** and **WinRM**, each
with up to ten credentials from Server Settings → Credentials (ICMP takes none).

**Order is the try order.** ICMP, when enabled, is the cheap liveness filter
that keeps empty space from costing an authentication attempt per address.
Each live address then gets the remaining methods in your order, each method's
credentials in order, and the **first that answers wins**. That is what lets
one sweep cover a mixed estate without you classifying it first.

An address that ignores the first ping gets a **second one straight away**
before it is called silent. Routers usually drop the first packet to a quiet
host while they look its address up, and a single ping would miss every such
device. If ping cannot run from the Polaris server at all, the Run step and the
completion event say so, and those addresses count as untested, not silent.
A firewall between Polaris and the target can still block a sweep, for example
a FortiGate DoS policy with **icmp_sweep** set to block. If a device answers its
ICMP monitor but never shows up in a Discovery, check that policy first.

**SNMP is the only method that identifies a device** — hostname, vendor, model
— and the only one that reports interface and storage names during the scan.
SSH and WinRM prove a login works; their interfaces appear only once an agent
runs.

### Running

The Run step saves the Discovery and starts a run — the sweep takes minutes, and
the wizard watches it. You can close the wizard and come back: reopening the
Discovery reattaches to a run still in flight. **Cancel scan** stops one;
**Scan again** re-runs it.

### Results and Monitor

Results lists the responders, with the method that answered and, per method,
why the others failed — *"answered ICMP, refused every SNMP community"* is the
most common shape, and it names the credential to fix. Tick the ones to add.

The **Monitor** step groups the selection by the method that identified it, and
offers the same interface and storage auto-monitor rules as an integration's
Monitoring tab — filled from the names the scan itself collected. The choice is
saved with the Discovery.

### Adopting

**New addresses only.** A run skips every address an asset already carries
before sending a packet, and adoption re-checks at the moment you add, so a
device created in the meantime is skipped rather than duplicated. A re-run
**enriches nothing** — which is deliberate, so that *"nothing new"* stays
distinguishable from *"nothing there"*.

An adopted device is typed by the asset-type rules for scanned devices (else
`other`), named after its SNMP hostname (else its address), and carries the
interface and storage pins from the Monitor step. It is **not** switched to
monitored — that is a separate decision per asset. Up to 500 addresses per add.

---

## Private or shared

Every Discovery is **private by default**. Visibility decides who may **see and
run** one; ownership decides who may **edit** it.

| | |
|---|---|
| See / run | anyone the visibility admits — running a shared Discovery is what publishing one is *for* |
| Edit / delete | the owner, with `networkScan:fullwrite` reaching anyone's |
| An invisible row | answers **404, not 403** |
| Name | unique per owner |
| Existing rows at migration | made public; new ones default private |
| Export | carries **no visibility at all** |

Note that publishing deliberately costs nothing above `write` — unlike saved
filters and dashboards. Sharing is the feature, and the roles that author
Discoveries hold `write`, not `fullwrite`.

---

## Import and export

A Discovery travels as a `.discovery.json` file. Route schemas are **shape
only**; the semantic rules live in one validator, because an imported file has to
pass exactly the same checks a form does.

---

## Before you run one

Three things worth settling first:

1. **Tell whoever runs your IDS.** An unannounced sweep of a range is exactly
   what they are watching for, and this is the feature most likely to generate a
   ticket about Polaris rather than from it.
2. **Scope it narrowly.** There is no default range on purpose.
3. **Decide who may adopt.** Scanning is reversible; putting two hundred rows in
   inventory is a cleanup job.
