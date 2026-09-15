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
that window *is* the reading. A separate optional **Sustained for** field
carries a hold on top of it.

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

The step has a **single** "Sustained for (minutes)" field, and it means one of
two things depending on the aggregation you picked:

| Aggregation | The field means |
|---|---|
| `avg` / `median` / `min` / `max` | the **measurement window** — the period the value is computed over |
| `latest` | the **sustain clock** — how long the condition must stay true |

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
