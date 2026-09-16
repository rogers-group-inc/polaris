# Assets

The device inventory, and the page most operators live on. Everything Polaris
knows about a device is reachable from here.

| Gate | Grants |
|---|---|
| `assets:read` | see the page |
| `assets:write` | edit rows, bulk-monitor, mass-pin |
| `assets:fullwrite` | **deploy the Polaris Agent** (install / retry / reinstall / upgrade / uninstall), delete others' saved filters |

Agent deployment sits at `fullwrite` on purpose ([rule 43](Business-Rules#rule-43)):
it runs an installer on someone else's host over a stored credential and leaves
a service behind. That is not the act `assets:write` — fix a hostname, retype a
serial — describes.

---

## The list

**Columns:** Hostname · IP Address · Serial Number · Type · State · **Status** ·
**Sources** · Description · Asset Tag · Manufacturer · Model · OS / Firmware ·
MAC Address · Assigned To · Purchase Order · DNS Name · Latitude · Longitude ·
Last Seen.

Columns are sortable, inline-filterable, resizable and hideable. **Column order
is per view tab; widths and visibility are per screen.**

### Two columns worth explaining

**State** is the asset's lifecycle: `active`, `maintenance`, `decommissioned`,
`storage`, `disabled`, `quarantined`.

Four of those **cannot be monitored at all** — `decommissioned`, `disabled`,
`storage`, `quarantined` ([rule 10](Business-Rules#rule-10)). Staging one of
them forces `monitored = false` and resets the failure counter, in every write
path. The two operator-facing paths (the edit form and bulk-monitor) **refuse
with a reason** rather than leaning on the silent clamp — a form that saves and
comes back unticked reads as a bug.

`quarantined` parks the flag so releasing a quarantine restores status *and*
monitoring together; otherwise releasing handed the device back to the network
with nobody watching it. Flipping a status back to `active` does **not**
auto-resume monitoring — re-enabling is deliberate.

`maintenance` is deliberately **not** on that list: a window pauses polling
while `monitored` keeps your intent, so it survives the window.

**Status** is the monitor pill, and it has six values — see
[Monitor states](Monitor-States). Click it to toggle monitoring. An *unmonitored*
pill instead opens the edit modal on the Monitoring tab, so you set the polling
method before enabling; the disable direction confirms inline.

### The alert indicator

A device with a live alert carries a **strobing dot** to the right of its
hostname, coloured by the worst active alert. **It stops moving once everything
on it is acknowledged** — motion means unhandled, not "bad".

`prefers-reduced-motion` drops it to a steady rendering, and the title text
carries the whole message: neither colour nor motion reaches every reader.

### View tabs and saved filters

A strip above the bulk bar. Each tab holds its own filter and sort state, saved
to your account so it follows you between browsers. Click switches, double-click
or F2 renames, ✕ closes (never the last one), + adds.

**Filters ▾** saves the current column filters + sort as a named preset, loads
one back into the current tab or a new one, and deletes them. Presets are
server-side. Private is the default; publishing needs `assets:write`, deleting
someone else's needs `assets:fullwrite`.

---

## Bulk actions

Select rows to raise the bulk bar:

| Action | Needs | Does |
|---|---|---|
| **Compare** | `assets:read` | overlays telemetry charts for several devices, after a metric picker |
| **Merge** | admin, exactly **two** selected | opens the merge modal with the target pre-selected |
| **Deploy Agent** | `assets:fullwrite` | one modal collects SSH + WinRM credentials and arch; OS and transport are resolved server-side, and ineligible assets come back as skips **with reasons** |
| **Maintenance** | `maintenanceManagement` | opens the schedules modal with the selection pinned as explicit asset ids |

A selection past the 500-id cap is refused **with the count**, rather than
400-ing after you have filled in the form.

---

## The asset slide-over

Click a row. Tabs, in order: **General · System · Services · Quarantine ·
Events · SNMP Walk · Sources**, plus **Alerts**, plus **Wireless**, **MAC
Table** and **ARP Table** where the device type has them.

Two tabs are conditional:

- **SNMP Walk** — admins only, **and** only when at least one monitoring stream
  actually resolves to SNMP for this asset.
- **Services** — hidden on Fortinet infrastructure (firewall / switch / access
  point) and on the `other` catch-all, none of which report a unit list.

Three are device-type specific: **Wireless** on a monitored access point, **MAC
Table** on a switch, **ARP Table** on a firewall.

### Snapshot tabs: Wireless, MAC Table, ARP Table

These three are not charts. Each is a picture of what the device answered the
last time Polaris asked — connected clients, a forwarding database, a neighbour
cache — and every one of them empties out on its own between reads. So all
three carry the same heading row:

- **How often it is re-read** (`every 10m`), resolved for *this* device, not a
  fleet-wide figure.
- **How old the reading is** (`updated 3m ago`). It turns **amber with a ⚠ once
  the reading is older than one poll cadence** — a poll is overdue. That is a
  lower bar than the amber *Last successful update* banner elsewhere in the
  slide-over, which waits for three; overdue and abandoned are different things.
- **Refresh** — re-reads this device *now*, rather than waiting for the next
  scheduled pass. It needs the **Asset Probes** permission, and it is hidden if
  you do not have it.

Read the pair together. An empty client list beside "updated 30s ago" means
nobody is connected; the same empty list beside an amber "updated 2 days ago"
means nobody has asked.

Refresh dials the device and re-reads its current state. It does **not** run a
response-time probe, so it cannot mark an asset up or down, and it will not
disturb an in-progress outage count. If it reports *nothing to refresh*, this
device does not deliver current-state data on its present polling method —
monitoring is off, the Interfaces stream is set to Disabled, or a Polaris Agent
on the host pushes on its own schedule instead.

Refresh is also refused for a device your integration's **device filter**
excludes. A filter you set to keep Polaris off a host keeps this button off it
too.

### General

Identity, location, coordinates, description, notes, tags, and the **upstream
rows**: *Last Seen Switch*, *Last Seen AP*, *Last Seen Firewall*. Each resolves
the display string discovery stored back to the **Asset row behind it**, so the
row carries verbs — open the device, open its HTTPS UI, SSH to it — instead of
being text you re-find by hand.

Resolution never matches a FortiGate by hostname. `fortinetTopology.controllerFortigate`
holds FortiManager's *device name*, which diverges from the gate's configured
hostname on real fleets; matching on it fails silently across dependency
suppression, Device Map membership, region tags and auto-monitor. An unresolved
name comes back as the name with no asset — a legitimate state, not an error.

**Where the firewall row comes from, in order:** the freshest FortiGate sighting
→ failing that, the gate that owns the containing network. The second is an
**inference**, tagged as such, and it deliberately carries **no timestamp** — a
row headed "Last Seen" must never print one for a device nothing has seen
([rule 55](Business-Rules#rule-55)).

For a device with an IP and **no MAC**, switch and AP placement is derived along
one chain ([rule 45](Business-Rules#rule-45)): IP → the containing network's
owning gate → *that* gate's ARP table → MAC → the learned switch port with the
fewest MACs, and the wireless station carrying that MAC. Four refusals keep it
honest — another gate's ARP row never counts, two MACs at one address is
`ambiguous` rather than a pick, a stale address claim is skipped, and evidence
older than 24 hours is not evidence.

### System

Live telemetry and history: response time, CPU, memory, temperature,
interfaces, storage, IPsec tunnels, SD-WAN.

**Managed by** names the integration that owns this asset's monitoring
configuration — whose class settings and stored credential it inherits, whose
discovery sweep can decommission it — with the parent FortiGate appended for a
managed FortiSwitch or FortiAP (`FortiManager: FMG-CORE → PLANT-FG-01`), since
that is the device that actually answers polls for it. An asset nobody
discovered reads `Manual`.

It is one integration, not a list, and it is **not** the answer to "where did
this asset come from". A device can be reported by several systems at once — a
laptop in Active Directory *and* Entra *and* Intune *and* Azure Arc — and every
one of those is a row under [Sources](#sources). For those, the first system to
claim the asset keeps it, so a later integration finding the same device adds a
source without taking over the monitoring configuration. Fortinet-managed
switches and APs are the exception: they are always claimed by the integration
that manages their controller, because that is where their polling comes from.

Charts carry:

- **Maintenance bands** — labelled translucent overlays over window gaps.
- **Severity shading** — the line and dots fade through warning / serious /
  critical wherever the reading enters a tier of an automation watching that
  metric *on that asset*, with dashed labelled reference lines at each in-range
  threshold. The ladder is computed **server-side from the engine's own
  resolver**, so the shading cannot disagree with what actually fires.
- **Grey, not red, for a suppressed miss** — a failure the upstream explains is
  drawn grey ([rule 38b](Business-Rules#rule-38)). Same dive, no accusation.

The colour of **Down** is not fixed: it is drawn in the covering automation's
own severity ([rule 36](Business-Rules#rule-36)). Red is what `critical` looks
like, and critical is merely the default severity of a seeded down automation.

### Services

A merged unit and process inventory — systemd units / Windows services with
state, and (with *Include processes* ticked) the per-program process inventory
in the same table. Read-only: start/stop/restart control was removed.

Two pin columns:

- **Monitor** — a service's journal tailing, or a process's CPU/RAM history and
  logs.
- **Map** — include it on the [Application Map](Application-Map).

Mapping implies monitoring, one way. There is no Alert column, because
[Automations](Automations) own alerting.

### Alerts

This asset's active alerts, above the automations whose scope matches it.
**The tab itself strobes** in the colour of the worst of them, so the operator
who opened the panel from a strobing row can see which tab it was about.

The active table is **[select] · Time · Severity · Detail · Message · Actions**.

**Detail is the dimension** — the interface, sensor or mount the alert was
raised for — and it is what makes the list readable: a per-interface automation
on a switch that loses its uplink raises one alert per pinned port, same minute,
same message. Without that column you get two dozen rows that differ in nothing.
Equal timestamps order by dimension **numerically**, so `port2` precedes
`port10`.

**Actions** carries **Acknowledge** (`alerts:write`) and **Clear**
(`alerts:fullwrite`), individually or over a multi-select in one request each.
Clearing ends the alert, stops escalation and runs the automation's reset
actions, so it is confirmed.

The note prompt is a Polaris modal, never `window.prompt` — the browser box is
unstyled, dead in an installed PWA, suppressed outright by some browsers, and
cannot mark a field required, which a note-requiring automation needs. The
question is a **placeholder, never a value**, so an untouched box submits as no
note at all.

The second table lists matching automations: **Name · Trigger · Scope**, where
Trigger is the automation's plain-English sentence — every severity tier
included, which is why there is no separate Severity column. The name opens the
automation in the wizard in place, for `automationManagement:fullwrite`.

### Wireless (access points)

Radios → the SSIDs each one broadcasts → the clients connected to each, as one
expandable tree. A radio row carries its channel, width and transmit power;
transmit power is shown **as the source reported it** — a percentage of the
radio's ceiling from the controller, and the AP's own MIB integers with no unit,
because that MIB publishes none.

Clients Polaris could not file under any broadcast SSID are listed at the bottom
under *Not matched to a broadcast SSID* rather than dropped — usually radios and
stations scraped a cycle apart.

An AP whose radio inventory has not arrived yet falls back to a flat client
table, so the tab never reads as empty while discovery fills it in. Radios and
their SSIDs come from the discovery run against the controlling FortiGate;
connected clients come from an SNMP walk, which needs the AP's **Interfaces**
stream set to SNMP.

Carries the cadence · freshness · **Refresh** row described above.

### MAC Table (switches)

The switch's layer-2 forwarding database, grouped **interface-first** — the
question is "what is on port 32", not "where is this MAC". Each port is one
expandable row carrying its MAC count and the reading that count supports: one
learned address is an access port, many are an uplink or trunk. Only `learned`
entries count toward that; the bridge's own address and static entries render
but say nothing about what is reachable through the port.

Entries on ports Polaris could not resolve to an interface are **hidden behind a
count and a Show link**, not dropped. On a FortiSwitch these are the trunk/LAG
pseudo-ports, which publish no port-to-interface mapping, so every address
behind a trunk lands there unattributable and would swamp the real per-port rows.

This is collected over SNMP on the system-info cadence. **A switch polled
through its parent FortiGate reports none** — the empty state says so, and tells
you when the last pass ran, so "scraped and genuinely empty" stays distinct from
"never scraped".

Carries the cadence · freshness · **Refresh** row described above. An unmonitored
switch shows no cadence at all: nothing refreshes a forwarding database except
the system-info pass, and discovery does not fill in for it.

### ARP Table (firewalls)

The gate's layer-3 neighbour cache, grouped interface-first. Headed by the
cadence · freshness · **Refresh** row described above, plus:

- A **range selector** — Current / 1h / 12h / 24h / 7d / 30d. An option past
  your configured retention is **disabled rather than hidden**, so you can see
  it exists and is not being kept.
- A filter over IP / MAC / interface / matched hostname — what brings an
  operator here is a lookup, not a survey.
- A **disclaimer** that each read is a snapshot of a cache the gate ages out in
  roughly 1–5 minutes. Short-lived entries can be missing entirely, and an
  absent address was not necessarily absent from the network.

Unlike the other two, this table has a **second writer**: discovery reads it on
every cycle. So an unmonitored gate still shows a cadence — its integration's
poll interval, typically 12 hours rather than the 10 minutes a monitored one
gets. The stated figure is always the one that actually applies to this device.

A historical range adds a *Last seen* column; Current omits it because every row
shares one instant.

### Sources

Every `AssetSource` row — one per system that reported this device — with what
each one said, side by side. This is where you go when a field looks wrong: the
projection shows the highest-priority source's answer, and this tab shows all of
them.

It also hosts the **merge** flow. Per-field winners are pre-selected from the
Sources priority order, with the winning column badged *higher-ranked source*
and one line naming which two sources decided it. Two rules outrank the order:
**an empty value never overwrites a filled one**, and for Type the `other`
catch-all counts as empty — so a specific type on either side wins, and no merge
path writes `other` over a real type.

### Discover Now

`POST /assets/:id/rediscover` narrows a discovery run to **one device**. For a
FortiSwitch or FortiAP it scopes to the **controller gate**.

A scoped run never stamps the integration's last-discovery time, never feeds the
duration baseline, and **skips all four asset-only post-sync passes** — agent
auto-deploy, interface/storage auto-monitor, presence verification and directory
sync — which read the database fleet-wide. Auto-deploy in particular would start
agent installs across the whole fleet from one click.

---

## Adding an asset by hand

**+ Add Asset**. As you type the IP, a panel underneath cross-references it and
reports, in this order:

1. **Any asset that already carries it as a primary IP**, in the warning colour
   — that is a duplicate you are about to create.
2. The containing network.
3. The gate the address sits behind, **and why that gate is believed** — its ARP
   table resolved it / it serves the network's DHCP / a device was sighted
   behind it.
4. The lease or reservation already on it, phrased from `sourceType` **and**
   `dhcpBinding` together: *"In use by a managed FortiAP … the gate leases it
   dynamically."*
5. The switch port its MAC was learned on, and the AP a wireless station on it
   is associated to.

**Use these details** fills MAC, hostname, location and coordinates — but only
into fields you left blank, and coordinates only as a complete pair. The panel
reports; it never writes.

A section your role cannot read says **"Not shown"**, never "none found".

---

## Deleting an asset

Two ways in, both `assets:write` and both the same act:

- the row menu's **Delete**, on the list; or
- **Delete Asset**, at the bottom-left of the **edit modal** — so a device you
  opened to fix, and then decided should not exist, does not have to be found
  again in the list.

Either one asks you to confirm **by hostname** first, over the top of whatever
you had open; cancelling leaves the edit modal and anything you had typed in it
exactly as it was. Confirming closes the modal, closes the detail panel if it
was showing that device, and removes the record.

**There is no undo.** The asset's history goes with it — samples, alerts,
sightings. If the device is simply gone from the network rather than gone from
the business, set its **State** to `decommissioned` instead: that stops polling
and keeps the record. A device a source still discovers will also come back on
the next discovery run, as a new record with no history.

Two things the delete does for you, and one it refuses:

- a managed switch or AP gives its **infrastructure reservation** back first,
  while the address is still readable off the record;
- the deletion is written to [Events](Events) as `asset.deleted`, named;
- a **quarantined** asset is refused outright — release the quarantine first,
  or the MAC block stays on the firewalls with nothing left in Polaris that
  remembers how to lift it.

---

## The Settings modal

**Settings** on the toolbar, one modal of stacked sections:

### Asset Lifecycle

How long a device sits in each state before Polaris acts on it.

### Sources

The drag-to-reorder **learned-location priority list**
([rule 22](Business-Rules#rule-22)). Contributors come from the server
catalogue, each with a "what this contributes" hint, so a new source kind needs
no client change. Two kinds exist: **field** contributors carry a real location
string; **label** contributors contribute their own name.

The same order decides the merge modal's per-field defaults. An unranked kind
ranks **last** there, never first.

One invariant is worth knowing because its failure mode is silent: **a source
blob may never be built from the projection's own output.** Doing so laundered
an AD OU path into a FortiGate-sourced field and accumulated a prefix per cycle.

### Manual Monitoring

The polling-method tier for **orphan assets** — ones with no integration behind
them. Accepts any method, since it must cover any source.

### Class Overrides

Per-(source kind, asset class) polling and credential overrides, one tier above
the integration's own settings. See [Polling methods](Polling-Methods).

### Mass Pinning

The manual way to **pin and unpin** interfaces, IPsec tunnels and storage mounts
across many devices at once. It is the subtractive counterpart to the
integrations' auto-monitor pass, which is additive only by design.

It mounts the shared condition builder over the automations device vocabulary,
lists the matched assets' inventory aggregated by name with **tri-state**
checkboxes (checked = pinned on every reporting device, partial = some),
expandable to per-device checkboxes, and **stages** edits until one Apply.

The aggregate-row click cycle is explicit, because an indeterminate checkbox
reports `checked === false`: not-all-pinned → pin on all; fully checked → unpin
on all.

A matched set over 1000 answers `overCap` instead of truncating — "pinned on all
matched devices" is only honest over the complete set.

**Why pinning matters:** an unpinned interface, tunnel or mount **never alerts**,
however much sample data exists for it ([rule 57](Business-Rules#rule-57)). The
pin *is* the statement of what may alert. Un-pinning is how alerting stops, and
a firing alert whose pin is gone clears — even on a tick where the device
produced no readings at all.

---

## Import and export

One **Import / Export ▾** dropdown. Exports run to PDF and CSV at page,
filtered, or whole-list scope. Import entries are gated on `assets:write`.
