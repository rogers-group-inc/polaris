# Assets

The device inventory, and the page most operators live on. Everything Polaris
knows about a device is reachable from here.

![The Assets table: hostname, IP, serial, type, state, monitor status and monitoring transport, with a per-column filter row and a bulk-action bar above it.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/desktop-noon-assets.png)

| Gate | Grants |
|---|---|
| `assets:read` | see the page |
| `assets:write` | edit rows, bulk-monitor, bulk tags, mass-pin |
| `assets:fullwrite` | **deploy the Polaris Agent** (install / retry / reinstall / upgrade / uninstall), delete others' saved filters |

Agent deployment sits at `fullwrite` on purpose ([rule 43](Business-Rules#rule-43)):
it runs an installer on someone else's host over a stored credential and leaves
a service behind. That is not the act `assets:write` — fix a hostname, retype a
serial — describes.

---

## The list

**Columns:** Hostname · IP Address · Serial Number · Type · State · **Status** ·
**Sources** · Description · Tags · Asset Tag · Manufacturer · Model · OS / Firmware ·
MAC Address · Assigned To · Purchase Order · DNS Name · Latitude · Longitude ·
Last Seen.

Columns are sortable, inline-filterable, resizable and hideable. **Column order
is per view tab; widths and visibility are per screen.**

**Tags** lists the asset's tags. Its filter matches any single tag containing
the text (case doesn't matter), so `prod` finds `Production`; **Is empty** finds
untagged assets. Sorting orders by each asset's alphabetically-first tag, and
untagged assets sit at the bottom whichever way you sort.

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
| **Compare** | `assets:read` | overlays telemetry charts for two to ten devices, after a metric picker; with more than ten selected the button greys out in yellow |
| **Merge** | Assets **full read-write**, exactly **two** selected | opens the merge modal with the target pre-selected |
| **Deploy Agent** | `assets:fullwrite` | one modal collects SSH + WinRM credentials and arch; OS and transport are resolved server-side, an asset whose last install **failed** is retried, and other ineligible assets come back as skips **with reasons** |
| **Maintenance** | `maintenanceManagement` | opens the schedules modal with the selection pinned as explicit asset ids |
| **Tags** | `assets:write` | pick tags, then **Add** them (each asset keeps its own tags), **Remove** them (from the assets that have them), or **Replace all tags** (each asset ends up with exactly the picked set) |

**Replace keeps two kinds of tag** on every asset: Device Map `region:` tags
and the discovery breadcrumbs `prev-entra:` / `prev-ad:`. Wiping region tags
across a large selection would silently drop those devices out of every
region-scoped user's and alert rule's view. To take a region tag off, pick it
and use **Remove**. Replace with nothing picked clears every other tag, and asks
first.

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

### Copy and Screenshot

The slide-over header carries **Copy** and **Screenshot**, and both act on the
tab you are reading — not on the whole asset.

**Copy** writes the tab out as plain text: labelled values, tables as rows,
headings kept. It is the form to paste into a ticket, a change record or a
chat.

**Screenshot** opens a picker first. Every section of the tab gets an include
checkbox (your choices are remembered per tab), chart sections get a time-range
choice that starts on whatever range the chart is currently showing, and the
Interfaces section can be told to include the interfaces it is hiding. On
**Capture**, Polaris renders the tab at a fixed width — so the image looks the
same whether your window is wide or narrow, or the panel has been dragged to a
new size — and copies it to the clipboard as a PNG. Charts, badges, colours and
your theme all come across as they appear on screen. On the **Events** tab the
button gives way to an **Export** dropdown instead (CSV or PDF, this page or
every event for the asset).

Individual tables and charts have their own camera buttons: for a table, beside
its column-chooser gear, and for a chart, in its corner. A table's camera
captures just that table exactly as it is drawn for you — the columns you have
visible, in the order and widths you have set, with the status dots, health-check
chips and green/red per-scrape strips intact — titled with the table name and
the device. Rows hidden underneath a collapsed parent are left out, and the
image says how many, so it cannot be mistaken for the full list: expand them
first if you want them in.

Copying to the clipboard needs a browser clipboard permission, and on most
browsers an **HTTPS** page (or `localhost`). On a plain-HTTP install the
capture still runs but the copy is refused, and the toast says so.

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

The [SD-WAN](#sd-wan-fortigate-firewalls) tab's sections carry the same source
and age pair, without a Refresh button.

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

#### Correcting a wrong MAC association

**MAC Address** is the asset's primary MAC; **All MACs** below it is every
address Polaris has ever seen this device advertise, newest first, each labelled
with the source that reported it and when. Docks, dongles, randomised Wi-Fi
addresses and ZTNA-relayed identities all show up here, which is why the list
occasionally names a MAC that belongs to some *other* device — a shared dock
moves between laptops, and a merge can bring a neighbour's history with it.

With **Assets** set to *Write* or higher (the built-in **assetsadmin** role, and
admin) each entry carries a **×**. It removes that MAC from this asset and
promotes the best surviving address to primary — preferring the device's real
NICs, as reported by the Polaris Agent, Intune or vCenter, over anything a gate
merely *saw*. The same **×** is on the MAC column's hover tooltip on the list,
but the slide-over is the only place it appears for an asset carrying a single
MAC. Every removal is audited as `asset.mac_removed`.

Removal is a **correction, not a block** ([rule 79](Business-Rules#rule-79)).
Nothing is suppressed: if the network reports that address against this asset
again, the next discovery run adds it back. When a MAC keeps returning, the
association is live rather than historical — find what is actually transmitting
it (usually a shared dock) instead of deleting the row repeatedly.

One entry can cover many addresses. An interface scrape folds a device's
sequentially-allocated port MACs into a single `AA:…:00 – AA:…:2F` range row, so
removing it removes the whole block — the confirmation says how many. A range is
a port block rather than an identity, so it is never promoted to primary; an
asset whose only remaining entries are ranges correctly shows no primary MAC.

### System

Live telemetry and history: response time, CPU, memory, temperature,
interfaces, storage, IPsec tunnels, SD-WAN.

**CPU & Memory is one chart, or two, depending on what is collecting it.**
Two sources report CPU per core and memory as a composition, and on those the
section splits into a CPU chart and a Memory chart:

| Source | CPU chart | Memory chart |
|---|---|---|
| [Polaris Agent](Polaris-Agent#per-core-cpu-and-the-memory-breakdown) | one line per logical core | processes / buffers / cache against installed RAM |
| [vCenter](Integration-vCenter#per-core-cpu-and-the-memory-breakdown) — VM | one line per vCPU | private / shared / ballooned / host-swapped / compressed against configured RAM |
| [vCenter](Integration-vCenter#per-core-cpu-and-the-memory-breakdown) — ESXi host | one line per physical core | consumed / ballooned / host-swapped against installed RAM |

A percentage and a byte scale cannot share an axis, but they are two readings
of the same sample, so the two charts keep one range selector — picking a
range, or dragging a window on either, moves both.

Every other transport — FortiGate REST, SNMP, WinRM, SSH — reports one CPU
figure and one memory figure per sample, and keeps the single combined chart:
both series on one 0–100% axis, with a memory reading in bytes shown as a
percentage of the total. There is nothing a second chart could add.

The two memory vocabularies are **not** translations of each other and never
appear in one stack. The agent reports how the guest's own OS is spending its
RAM; vCenter reports how the hypervisor is backing it. Ballooning and host
swap are invisible from inside a guest, which is why an agent on the same VM
cannot show them — and why, on a VM that is being squeezed, the vCenter chart
is the one that says so.

**Click a legend chip to switch that series off**, on either chart — a memory
band, the swap line, a CPU core, or the cross-core average. A switched-off
chip stays in the legend with a line through it; click it again to bring the
series back. On the CPU chart, **double-click a core to show only that one**,
and a **Show all** link appears whenever anything is hidden.

The two charts remember your choice differently, on purpose. Memory bands are
**saved to your account** and follow you between hosts and browsers — the
bands mean the same thing everywhere, so which of them you want to see is a
setting. Hidden CPU cores last only as long as the panel is open: core 5 of
one server has nothing to do with core 5 of another, so carrying the choice
across would hide a different core each time.

### Cache starts switched off

On an agent host the **Cache** band is hidden until you turn it on, and the
legend says so.

Page cache is memory the OS has filled with recently-read files because the
RAM was otherwise idle — it is handed straight back the moment a program
wants it. Counted in the stack it makes a perfectly healthy machine look
nearly full, which is the most common way this chart gets misread. With it
off, the stack answers *how much memory is actually spoken for*, and the gap
above it is headroom you can rely on.

Turn it on when you want the whole picture. While any band is hidden the
legend reminds you that the gap above the stack includes it, and the tooltip
keeps reporting every figure the host actually measured, hidden ones marked —
so nothing is lost, only undrawn.

Below the response-time section sits the **Polaris Agent** card: the installed
agent's version, platform, last heartbeat, WebSocket state and privilege tier,
with Upgrade / Uninstall. On a **server** or **workstation** with no agent yet
the card is the deploy surface — an **Install Agent** button that pushes the
agent over a stored SSH or WinRM credential
([Polaris Agent](Polaris-Agent#installing)). Deploying needs
`assets:fullwrite`; at `assets:read` the card still shows what is installed,
without the buttons.

#### Firmware

Under the agent card, a **switch or access point** gets a **Firmware** card
([rule 87](Business-Rules#rule-87)) — the answer to whether the
[Repository](Server-Settings#repository) holds something newer for this
device. It is one of:

- **Not supported** — no upgrade engine for this manufacturer (Fortinet only,
  over HTTPS to the device's own web UI). Images can still be stored.
- **No image** — nothing in the repository for this device's platform, with a
  link to the Repository.
- **Current** — nothing newer than what it runs.
- **No login bound** — an image is available but no device login is bound at
  the model, device-type or manufacturer level.
- **Blocked** — an image is available but the device is down, warning,
  recovering, behind a parent that is down, or has no address.
- **Upgrade available** — the running version, the image on offer (its
  version, platform and which model node it came from), the login that will be
  used and where it is inherited from.

**Upgrade firmware to …** needs `firmware:fullwrite`; at read the facts stay
and the button is withheld. It opens an **approval dialog** naming the device
(host, serial, running version, login) and the exact image — version, build,
platform, file name, SHA-256, where it is filed, who uploaded it — and, when
the model's backup image is also newer than the device, lets you choose that
instead. Nothing is pushed until you tick that you checked the version and
platform and click **Approve and upgrade**.

While it runs the card shows the stage and, on a switch, the erase / write /
verify percentages, then *Rebooting* and *Verifying new version*. The device
is in a maintenance window for the duration
([Maintenance Windows](Maintenance-Windows#windows-polaris-opens-for-itself)),
so everything behind a switch is suppressed with it. Polaris does not offer a
cancel — a flash mid-write must finish — and **you must not power-cycle the
device while it is writing.**

A run ends *succeeded* (the device came back reporting the image's version),
*unverified* (it came back but Polaris could not confirm the version — check
it on the device) or *failed* (the transcript says at which stage). The
asset's OS/firmware field is not rewritten by the run: the next discovery
reads the new version, and until it does the card says *Flashed*. **Run
history** lists every attempt with a **View log**. No bulk upgrade exists; it
is this device, from this card. The phone shows no Firmware card.

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
- **Outages on CPU / memory / storage / interface charts** — those streams
  record nothing for a missed poll, so the chart borrows the response-time
  probe's record: wherever every probe failed, the line dives to the baseline
  and climbs back out, at every range from 1h to 30d. A hole in the line with
  no probe failure behind it — the device answered pings but a CPU poll failed
  — is bridged, not dived: Polaris has no evidence of an outage there. A
  window the series kept reporting through (a Polaris Agent host that pushed
  readings while the probe could not reach it) is not dived either.

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
automation in the wizard in place, for `automationManagement:write`.

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

### SD-WAN (FortiGate firewalls)

Shown on a monitored FortiGate that reported SD-WAN data, with the **SD-WAN**
toggle on its integration. Three sections: **SD-WAN Members** (the WAN members
and overlays, grouped by zone, with per-health-check state), **SD-WAN Rules**
(the service rules in the gate's own priority order, selected member
highlighted) and **Performance SLA** (latency, jitter and packet-loss charts per
health check). One member legend above the Performance SLA charts drives all
three: click a member to hide or show it, double-click to show only that
member, and **Show all** brings everything back.

Each member's **Health Check Status** strip covers the **last 30 minutes**, one
segment per SD-WAN poll. A segment is **green** when the FortiGate reported the
member alive in every health check it belongs to at that poll, and **red** when
any of those health checks reported it dead. There is no amber state: missing
the SLA targets for latency, jitter or loss does not turn a segment red — the
Performance SLA charts show that. A poll that never ran leaves no segment.

Each section states **where its data came from and how old it is** — the polling
method, transport and cadence, then `updated 8m ago`, amber with a ⚠ once the
reading is older than one cadence, exactly as on the snapshot tabs above. Each
states its **own** age rather than the device's last poll: the rules table and
the health-check metrics are separate reads on the same pass, and one can land
while the other fails. A failed rules read keeps the rules table as it was
rather than emptying it. A section that has never been collected says so
instead of showing nothing.

SD-WAN has its own polling pass, separate from interfaces: every 60 seconds by
default, set per integration by the SD-WAN tab's **Polling Interval** (see
[Integration-Fortinet](Integration-Fortinet)). There is no Refresh button on
this tab. An on-demand poll (the mobile asset sheet's refresh, or
`POST /assets/:id/probe-now` over the [API](API)) re-reads SD-WAN along with the
probe; the snapshot tabs' **Refresh** (which re-reads system info) does not.

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

### If the address is already in use

Saving an asset with an IP — on create, or when you change the IP in the edit
form — first checks whether another network-present asset already records that
address. If one does, a dialog names it (type, status, when its address was last
confirmed, whether it is pinned) and asks how to proceed:

- **Save & submit for conflict review** saves your record and raises a
  [Duplicate IP conflict](Conflict-Resolution#checked-when-you-save-not-just-every-ten-minutes)
  immediately, so it is in the queue — and alerting — without waiting for the
  ten-minute sweep.
- **Save & review merge with …** appears only if you hold Assets **full
  read-write** and exactly one other asset currently holds the address. It saves,
  then opens the merge review between the two records — for when the "other
  asset" is the same device recorded twice.
- **Cancel** writes nothing.

A record whose address claim has gone stale is listed for information but does
not count as a collision. Re-saving an asset without changing its IP asks nothing.

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
