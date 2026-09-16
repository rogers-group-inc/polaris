# Automation triggers and conditions

Step 3 of the wizard. What the automation watches, at what severity.

---

## The five trigger kinds

| Kind | Watches | Scoped to devices? |
|---|---|---|
| **Asset metric** | a number a device reports | yes |
| **Asset state** | a field on the Asset row, or a per-dimension state | yes |
| **Host metric** | the Polaris server's own health | **no** |
| **Event** | an audit Event arriving | yes (since 2026-09) |
| **Change** | a tracked field changing | yes |
| **Composite** | a tree of the above | yes (device-kind) |

---

## Asset metric

A number, compared against a threshold.

| Metric | Unit | Dimension |
|---|---|---|
| `cpuPct` — CPU utilization | % | — |
| `memPct` — Memory utilization | % | — |
| `memUsedBytes` — Memory used | bytes | — |
| `sessionCount` — Active sessions | — | — |
| `responseTimeMs` — Response time | ms | — |
| `uptimeSec` — Uptime | sec | — |
| `probeLossPct` — Packet loss (probe) | % | — (windowed ratio — see below) |
| `hwSensorValue` — Hardware sensor value | sensor's own | sensor class, sensor name |
| `hwSensorAlarm` — **Hardware sensor alarm** | 0/1 | sensor class, sensor name |
| `storageUsedPct` / `storageUsedBytes` | % / bytes | mount path |
| `storageDaysUntilFull` | days | mount path |
| `ifInErrorRate` / `ifOutErrorRate` | errors/s | interface name |
| `ifInBps` / `ifOutBps` | bps | interface name |
| `sdwanLatencyMs` / `sdwanJitterMs` / `sdwanPacketLoss` | ms / ms / % | health check, member |
| `ipsecThroughputBps` | bps | tunnel name |
| `customWidgetValue` | — | widget |
| `customStateValue` — Device state flag | 0/1 | state probe, row |

### Prefer the device's own alarm bit

`hwSensorAlarm` reads the per-sensor alarm bit the collectors already gather,
rather than a threshold you invent. **Prefer it** — the device knows its own
per-model limits, and for a fan tray or a PSU the health *is* in that bit rather
than in any comparable number. See [rule 24](Business-Rules#rule-24).

A source that publishes no alarm bit is **excluded**, never read as 0. An
unrecognised non-empty status maps to alarm; ENTITY-SENSOR-MIB's `unavailable(2)`
maps to null — an empty SFP cage is not a fault.

### Packet loss is special

`probeLossPct` is a **windowed ratio**, not an aggregation. Its field is
relabelled **History (minutes)** — mandatory, default 15, range 5–1440 — and
that window *is* the reading. A separate optional **Sustained for (polls)** field
carries a hold on top of it — the window in minutes, the hold in readings, each
stating the unit it is actually stored in.

Three things it does that no other metric does
([rule 29](Business-Rules#rule-29)):

- **It counts packets, not rows, wherever it can.** An ICMP sweep row describes
  a whole burst and carries packets sent / received, so an asset with burst rows
  in the window is measured from those sums. Otherwise it falls back to the row
  ratio.
- **Only an answering device reports loss.** The resolver admits `up` and
  `warning` only. A dark passive device would otherwise sit at 100 % with no
  asset-down alert to supersede it.
- **A reading at or above the rule's `ignoreAtOrAbove` ceiling is not a
  reading** — default 100, so an untouched rule is unchanged and only a total
  outage is suppressed. Polaris opts its own baseline rule out at **90**.
  Lower it if you do not want an alert trailing every outage.

And the failures of an outage are **excluded from the metric**: every maximal
run of consecutive failures that reached `down` is dropped whole, onset
included. Without that, a switch dark for twelve minutes comes back, starts
answering, and its 30-minute window still reads 40 % — so a "High packet loss"
warning lands minutes *after* the recovery about the outage that already paged
someone.

> **The chart can legitimately disagree with the alert.** The loss chart counts
> every probe in its window, outage failures included, because a picture of the
> window has to be continuous — a gap renders as a flat 0 % line, which reads as
> "no loss" when the truth was "totally dark". So a caption can read *avg 40 %*
> under an alert that fired at 8 %. They answer different questions, and only
> the caption's is reconstructible from the picture.

### 0/1 metrics render differently

For `customStateValue` and `hwSensorAlarm` the builder swaps the numeric
controls out: the threshold box becomes a select of the probe's own two labels
("Alarm" / "OK"), the comparator narrows to *is* / *is not*, and the aggregation
narrows to *current state* / *at any point in* / *throughout*. Severity bands
and hysteresis are hidden and server-rejected — a ladder over two values means
nothing.

---

## Asset state

A field rather than a number.

**Device-wide fields:** `monitorStatus` · `status` · `consecutiveFailures` ·
`dependencySuppressed` · `quarantined` · `fortilinkStatus`.

**Per-dimension fields:** `ifOperStatus` · `ifAdminStatus` · `ifIpAddress` ·
`poeStatus` · `ipsecStatus` · `sdwanRuleStatus` · `sdwanSelectedMember`.

### `monitorStatus == down` is the down-detection automation

This is the trigger that **defines what down means**. It carries a
`missedPolls` count, and that count *is* the definition of down for every device
it covers ([rule 36](Business-Rules#rule-36)).

- Precedence resolves it — same-rank ties go to the **smaller count**, then
  older, then lower id.
- **A device no such automation covers reads `passive`** and is never judged.
- The same automation owns the way back **up**: its reset hold, collected in
  **polls**, holds the device in `recovering` until that many probes have
  answered.
- It also decides **what colour Down is** on every chart and in every alert
  email — the automation's own severity.

See [Monitor states](Monitor-States) for the whole machine.

### `fortilinkStatus` — the second opinion

What the parent FortiGate says about its FortiLink session to a managed
FortiSwitch, or its CAPWAP tunnel to a managed FortiAP: `up` / `down` /
`unknown`, and null on anything not FortiGate-managed.

It is deliberately a **separate field from `monitorStatus`, and the
disagreement is the point**: a switch reading `monitorStatus = up` with
`fortilinkStatus = down` is answering ICMP while its FortiLink session to the
gate is dead — a fault the monitor loop cannot see, because it is asking the
switch.

Three refusals ([rule 59](Business-Rules#rule-59)):

- An unreadable controller writes **nothing** — not `down`, not even a refreshed
  timestamp. An expired token must not report a fleet-wide link outage.
- Answered-but-absent is **`unknown`, never `down`** — a post-config-push window
  looks identical.
- It never touches `monitorStatus` or the failure counter.

`unknown` is offered in the picker deliberately: it is the reading for a device
the controller answered about but did not list, which on a FortiSwitch usually
means it has been unplugged long enough to age out of the managed-switch table.
An operator who wants *"tell me when the gate stops seeing this switch at all"*
writes `!= up`, not `== down`.

A null produces **no reading at all** — not a reading of null, which would make
`!= up` true of every workstation in a fleet-wide scope.

### `ifIpAddress` — a gate, not an alarm

The port's current L3 address, compared as a string. Its reason for existing is
the **negative** form: `!= 0.0.0.0` is how you say "this interface actually has
an address".

That is the gate a rule about something *riding* that interface needs. An SD-WAN
overlay's health check reports total packet loss whenever its underlay WAN port
is unaddressed — and that is the underlay's outage to alert about, not the
overlay's.

The interface is **integral** here: the comparison is about one port, so the
interface picker renders on the condition row itself rather than as a group
filter.

### `ipsecStatus` — name the tunnel on the condition

The status of an IPsec tunnel, as the FortiGate reports it. Only tunnels you
have **pinned** — on the device's [System tab](Assets#system) or in bulk from
[Mass Pinning](Assets#mass-pinning) — are ever read, so an unpinned tunnel can
never raise an alert however the rule is written ([rule 57](Business-Rules#rule-57)).

The **IPsec tunnel** picker sits on the condition row and offers the tunnel
names the devices you selected on the Devices step actually report — a phase-1
name is not something to type from memory, and one that matches nothing saves
cleanly and then never fires. Leave it **blank** and the condition covers every
pinned tunnel on those devices, raising one alert per tunnel; fill it in and the
condition is about that tunnel alone.

If the picker says the selected devices report no monitored IPsec tunnels, the
tunnels have not been pinned yet — pin them, then re-open the step.

---

## Host metric

The Polaris server's own health: `cpuPct`, `memUsedPct`, `memUsedBytes`,
`loadAvg1/5/15`, `procRssBytes`.

**Unscoped** — the Devices step is discarded, because this is not about your
devices.

---

## Event

Fires when a matching audit Event is written. Flat fields: an action pattern, a
minimum level (`info` / `warning` / `error`), a resource type.

Since 2026-09 an event automation **is** device-scoped, and the filter filters
the event's **subject** ([rule 46](Business-Rules#rule-46)). Two refusals follow
from "the subject is a device":

- An event naming **no asset** — an integration, a user, a login, the host
  itself — cannot satisfy a device filter, so a *filtered* automation never
  fires on one. An unconstrained one still does, which is how the twelve seeded
  event automations keep working.
- Neither does an event whose asset row is **already gone** (`asset.deleted`).

"Unconstrained" is asked first and separately: `{allAssets: true}`, a bare `{}`,
or a condition tree with no rules. That distinction is load-bearing — every event
automation saved before 2026-09 carries `{}` meaning "any device", while a
builder-authored empty scope selects *nothing*.

---

## Change

Sugar over the change Events Polaris emits:

| Change type | Means |
|---|---|
| `lldp_neighbor_added` / `_removed` | LLDP neighbour appeared / disappeared |
| `process_started` / `process_stopped` | |
| `sdwan_failover` | SD-WAN member changed |
| `mclag_peer_lost` | |
| `wireless_station_connected` | |
| `firmware_changed` | firmware / OS version changed |
| `switch_port_changed` | |
| `wireless_ap_changed` | a roam |
| `gateway_firewall_changed` | the gate in front of the device changed |
| `fortilink_changed` | controller link changed |

---

## Composite

An AND/OR tree over several conditions, up to 3 deep and 10 leaves. One leaf
saves as a plain single trigger; two or more save as a per-asset composite.

This is what lets one automation mix device-specific branches —
*"interface wan1 down on CORE-SW **OR** storage /backup full on BACKUP-01"* —
using **device filter rows** (below).

---

## Windows, holds and the one field that means two things

The step has a **single** duration field, and it means one of two things
depending on the aggregation you picked. It renames itself — and changes its
**unit** — to say which:

| Aggregation | The field | It means |
|---|---|---|
| `avg` / `median` / `min` / `max` | **Measured over**, with a `minutes \| polls` picker | the **measurement window** — see the next section, which is the choice that picker offers |
| `probeLossPct` | **History (minutes)** | the window the ratio is measured across (see above) |
| `latest` | **Sustained for (polls)** | the **sustain clock** — how many consecutive readings the condition must stay true for |

The two units are not a cosmetic difference, and which one you get is not a
preference — it is what the rule actually stores. A window is saved as
`windowSec` and the engine reads it as wall-clock time, so stating it in polls
meant multiplying by whatever cadence the wizard had observed and presenting the
result as though you had said it; a hold is saved as `forPolls` and the engine
genuinely counts readings. Each field now states the half that is true, and its
caption names the other half — the poll estimate under a window, the wall clock
under a hold. Switching a condition's aggregation **re-denominates** the number
in the box rather than reinterpreting it: 10 minutes on a fleet polled every two
minutes becomes 5 polls, never a bare 10 that would quietly double the hold.

That ambiguity is real, so the step renders the trigger **twice**: once as an
English sentence, and once as a **formula** directly underneath. The formula puts
a measurement window *inside* the term and a hold clock *outside* it:

```
median(Hardware sensor[class="temperature"], 15m) >= 65 °C
latest(CPU usage) > 90 %  held 10m  ⇒ warning
```

The field is **mandatory exactly when an aggregation is chosen**, marked with a
red asterisk, and refused at save rather than silently measured over the
engine's default lookback.

> One honest caveat the formula states rather than hides: the engine fetches
> `max(window, 15 min)` of samples and reduces every row it fetched, so a window
> under 15 minutes is really measured over 15. The formula prints the
> **configured** window and says so.

### Holds are counted in readings, not seconds

Since 2026-08-29 a trigger states `forPolls` and a reset states
`reset.sustainPolls`, and the engine counts **consecutive qualifying readings**
([rule 19](Business-Rules#rule-19)). The seconds value survives as the
wall-clock mirror — what the prose reads, and what sizes the sample window.

This matters because the engine ticks every 60 seconds while a device may be
polled every five minutes. Counting ticks would charge five polls against one.
The wizard asks the server for **the actual cadence of the draft's own devices**
so it can convert, and says which cadence it converted at.

### Windows are measured in minutes, not readings

The same is not true of a measurement window, and since 2026-09-16 the two are
no longer stated in the same unit. A window is `windowSec` — the engine takes
every sample whose timestamp falls inside it and reduces them. It does not count
to N. So "60 polls" was never what the rule said: it was 60 × the cadence the
wizard happened to observe when you typed it, and it stopped describing the rule
the moment that cadence changed — a window authored against a 60s poll stayed an
hour after the fleet moved to 300s, while the label still claimed 60 readings.

The number of readings a window holds is a **consequence** of the window and the
fleet's cadence, so it belongs in the caption, where it updates as the cadence
does. Two consequences worth knowing when you read a window back:

- **A time window's denominator floats with availability.** Missed polls write no
  value, so an hour of `avg` over a device dropping three quarters of its packets
  is the average of the quarter that answered — not of 60 slots with holes in
  them. A **count window** (below) is the fix for that; if you want the misses
  themselves to alarm, that is what `probeLossPct` and down detection are for.
- **A stored window that isn't a whole number of minutes is left alone** until
  you edit the field. A 90-second window shows `2` and stays 90 across a save
  that never touched it; type `2` and it becomes 120, because typing it is
  stating it.

### Count windows: the last N readings, and a breach counter

Switch the picker from **minutes** to **polls** and the window stops being a
span of time and becomes **the last N readings that returned a number** — "the
average of the last 10 responses" — recomputed every time a new one arrives.

This is the answer to the floating denominator above. A miss is not counted, not
filled and not given an invented value; it simply is not a member of the window.
What stretches on a lossy device is the *wall-clock time* the window covers, not
the number of measurements in it, so the reading means the same thing at 0 % loss
and at 40 %: **when this device answers, this is how long it takes.**

Choosing readings reveals a second field, **Alert after (recalculations)**, which
a time window does not get. It is the **breach counter**: how many consecutive
recalculations must be over the threshold before the alert fires. The two compose
into "the last 10 responses have averaged over 500 ms, 15 times running."

| | Time window | Count window |
|---|---|---|
| Window | last 60 **minutes** | last 10 **readings** |
| Sample size | whatever landed — floats with availability | fixed at N |
| A miss | shrinks the denominator | not a member; the window reaches further back |
| Hold on top | none — the window *is* the period | the breach counter |
| Below a full window | averages what it has | **no reading at all** — it abstains |

Two behaviours worth knowing before you rely on it:

- **Only successful polls advance the counter.** On a healthy device at a 60 s
  cadence, 60 recalculations is about an hour; on a device losing half its
  probes the same rule takes about twice as long, because it is waiting for
  measurements rather than for the clock. That is deliberate — fewer
  measurements means less certainty, so more evidence is required before paging.
  During a total outage the counter stops entirely, and down detection owns that
  case.
- **Past about 50 % loss the metric abstains.** Polaris will not average a
  partial window — an aggregate over fewer than N samples is a different
  statistic wearing the same threshold. A device that lossy has a packet-loss
  problem, not a latency problem, and `probeLossPct` is the metric that says so.

The practical reason to reach for it: a count window plus a breach counter will
not page you for a single spike. One 1500 ms response inside an otherwise healthy
5-reading window never pulls the average over 500, so the counter never starts —
while a device that has genuinely slowed clears the line at every recalculation
and fires on schedule.

### Response time measures misses too, and forgets an outage

**Response time defaults to a count window of 10**, and it behaves differently
from every other metric inside that window — because it is the only metric whose
*failure* has a duration attached. A missed CPU reading is an absence; there is no
number to put there. A missed response-time poll waited the device's full probe
timeout and heard nothing, which is a fact about the device measured in the same
unit as the metric.

So, inside a response-time count window:

- **A missed poll counts as the probe timeout configured for that device.** Not
  skipped, not zero. Skipping it would let a device answering one poll in ten read
  exactly as fast as one answering every poll; zero would make the worst device on
  the network look like the best.
- **Going Down resets the window.** Everything up to and including the poll that
  declared the outage is discarded. Without this, an outage's timeouts would sit
  in the window for ten polls after the device came back, and a recovered device
  would keep alerting about the outage your down automation already paged you for.
- **Only Down resets it.** A missed poll that has *not* yet crossed your
  "Declare Down after" count is still a degraded device, not an outage — it counts,
  filled with its timeout. The line between the two is your own missed-poll
  setting, not a second threshold hidden in here.
- **A recovered device is quiet until the window refills.** Ten polls, so about
  ten minutes at a 60-second cadence. That is a settling period rather than a blind
  spot — `down` was your down automation's business for the whole outage.

You can still change the number, or switch back to minutes, on any individual
automation. The default only applies to a new automation that hasn't stated a
window yet, and it never overrides a choice you have made.

> **On upgrade, existing response-time automations were converted** to the
> 10-reading window, including ones you had edited. Each one is named in an Event
> along with the window it used to have, so you can see exactly what changed and
> set any of them back by hand. They were not left alone because the problem being
> fixed is what a minutes window *measures* — an edited rule measured it just as
> wrongly as an unedited one.

---

## Severity bands

Tick **"Use multiple severity levels"**. A base severity moves into the
condition group header, a **+ Severity** button appears, and each added tier is
its own accent-coloured block.

| Property | Behaviour |
|---|---|
| Severities | must **strictly increase**; thresholds need not be monotonic — the most-severe *met* tier wins |
| Shared | metric, aggregation, window, dimension filter — greyed on a tier |
| Editable per tier | operator and value, plus its own "Sustained for" |
| Max | 4 tiers |
| Actions | tiers can share the base actions, or have their own — see [Actions](Automation-Actions) |

One alert **climbs and eases in place** rather than firing several.
De-escalation is immediate, and the hysteresis dead band eases to the base
severity.

A new tier defaults one rank above the previous and inherits the base's current
hold, so adding one changes nothing until you edit it.

---

## Narrowing to part of a device

### Dimension filters

A metric with dimensions gets **pickers, not free-text boxes**, populated from
what the draft's *own* scoped devices currently report, with per-value device
counts.

For substring-matched dimensions (a sensor name, an interface, a mount) a
**match cue** sits beside the field: *"✓ matches 2 of 14 reported hardware
sensors"*, *"✓ exact match"*, or a warning that it *"matches none … would never
fire"*. The dimension is a free-text pattern the server cannot reject, so before
this a typo saved cleanly and then silently never matched.

A stored value the devices no longer report is **kept and flagged**, never
silently widened to "any".

### Filter rows

The **+ Condition** menu also offers:

- **Device identifier** — Hostname / IP address / MAC address / Manufacturer /
  Model. Valid on every asset metric or state leaf.
- **Component name** — Interface name / IPsec tunnel name / Storage mount /
  SD-WAN rule name.

Every **per-component condition** carries its component picker **on the row
itself** and needs no filter row for it: the four interface conditions
(*Interface oper status*, *Interface admin status*, *Interface IP address*,
*Interface PoE status*) name an interface, and *IPsec tunnel status* names a
tunnel. Click the box for the component names the scoped devices actually
monitor. **Leave it blank and the condition covers every monitored component**,
one alert each — which is what these conditions have always meant. A filter row
still works there too — it folds into the condition and re-opens on the row —
but the row is where these say what they are about.

These render as *"`<what>` matches `<value>`"* rows and mean **"narrow every
condition in this group"**. The stored rule never carries a filter row — each
one is folded into its AND-group's leaves at save, and re-derived when you open
the automation again.

Matching semantics, mirrored client-side for the cue:

| Field | Matched as |
|---|---|
| Hostname, manufacturer, model | substring |
| **IP address** | CIDR / octet-boundary prefix / exact — **never bare substring** |
| **MAC address** | separator-insensitive |

Device identifiers ride the trigger signature, so same-metric automations with
different device filters **never carve each other out**.

### Pins gate everything dimensioned

**The builder's pickers list the pin set, not the inventory**
([rule 57](Business-Rules#rule-57)). An empty list reads as *the gate*, not as
"this device has no ports". A filter that could never fire cannot be authored.

Every stream writes samples for unpinned members too, permanently inside the
engine's lookback — so the pin is a **gate**, never a side effect of retention.

---

## Testing the trigger

**"Test against current data"** on the step, and on step 6 a full
*Devices this automation affects* preview:

- Headlined by **distinct devices**, with **readings** spelled out separately —
  a per-dimension metric evaluates one reading per sensor / interface / mount,
  so rows repeat the hostname. Each row names its dimension.
- A **specificity indicator** and the bidirectional **carve-out warning**.
- Carved-out devices are **counted, not listed** — the rows are what the
  automation *will* alert on.

---

## Reset conditions (step 4)

A default-checked **"Reset when the trigger is no longer true"**, whose sentence
says what that *means* rather than restating it: the trigger's own clause
rendered **inverted** — *"CPU usage (avg over 5 minutes) is at or below 90 %"*,
at the hysteresis clear threshold when one is set.

A 0/1 metric flips the **value** rather than the comparator — *"Hardware sensor
alarm is OK"*, not *"is not Alarm"*. A state to look for, not a double negative.

Two caveats are spelled out because you cannot read them off the clause:

- A **monitor-status** alert clears at the **first successful probe**, when the
  status reads `recovering` — which is the difference between "answered once"
  and "healthy again".
- A numeric alert with **no clear threshold** resets at the very value that
  raised it, so a reading on the line can re-alert. The dead-band control is on
  the same step.

### Custom reset conditions

Unticking the box reveals **Custom conditions** first, then timed, then manual.

Custom conditions is the same AND/OR builder, **seeded with the trigger
inverted** (De Morgan applied for a tree), so unticking lands on the editable
spelling of what the box did — not on "manually only". Offered on every trigger
with a continuous condition ([rule 32](Business-Rules#rule-32)).

Four things it does:

- While firing, **the tree is the sole recovery authority**.
- Resolution is **dimension-first with a per-asset fallback**: a per-port alert
  clears independently, while a device-wide leaf clears them together.
- Reset leaves carry **no window control** and inherit the trigger's measurement
  window — a second minutes field beside "must stay true for" is exactly the
  window-vs-hold confusion the formula display exists to remove.
- A stored condition is kept verbatim and never re-seeded.

### Reset on a counterpart event

`event` and `change` triggers have nothing to invert, so they get **"When a
matching event arrives"** instead, prefilled from the server's known
counterparts — `agent.disconnected` → `agent.connected`, scoped to the **same
subject** the alert is about.

A new draft with a known counterpart lands on that mode rather than on the
four-hour timer that used to be the default.
