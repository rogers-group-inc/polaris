# Monitor states and down detection

The monitor pill has six values, and how it moves between them is one of the
most consequential pieces of behaviour in Polaris.

| State | Pill reads | Means |
|---|---|---|
| `up` | **Up** | answering, and the failure bucket is empty |
| `warning` | **Missed** | has missed polls, but the bucket is below the threshold |
| `down` | **Down** | the bucket has reached the covering automation's `missedPolls` |
| `recovering` | **Recovering** | answered again, but has not yet answered enough times to read `up` |
| `passive` | **Passive** | **no automation covers this device, so Polaris renders no verdict** |
| `unknown` | **Pending** | never probed, or the probe could not run |

`warning` is labelled **Missed** everywhere an operator reads it — the pill, the
Status filter, the dependency tree's pips, the automation wizard's condition
sentence — because the alert severities are also called warning / serious /
critical, and a pill reading "Warning" would look like an alert had fired. The
stored value and the API still say `warning`.

---

## What the pill says

A few conditions **replace** the six-state label on the pill, in this order of
precedence:

| Pill | When |
|---|---|
| **Unmonitored** | monitoring is off. With `assets:write`, clicking it opens the edit modal on the Monitoring tab |
| **Standby** / **Standby Down** | an unmonitored HA standby FortiGate — its health comes from the cluster's HA roster on each discovery cycle, since the cluster IP only reaches the active member |
| **Maintenance** | the device is in a [maintenance window](Maintenance-Windows); polling and alerts are paused, and the tooltip names the state it returns to |
| **Dependency Test** | an operator is [simulating this device down](Dependency-Suppression#testing-it); real probes keep running underneath |
| **Dep. Down** | an upstream parent is down — [dependency suppression](Dependency-Suppression). The device's own state moves to the tooltip |

Otherwise the pill shows the state from the table above. Its tooltip carries the
response-time method, the last round-trip time and the last poll; a **Passive**
pill's tooltip also says whether its last poll succeeded, or how many in a row
failed, since polling carries on.

---

## The automation decides what "down" means

Polaris does **not** define down on its own ([rule 36](Business-Rules#rule-36)).

A `monitorStatus == down` automation carries a **`missedPolls`** count, and
that count *is* the definition of down for every device that automation covers.
You state it in the automation wizard's trigger step, in the
**Sustained for (polls)** field below the condition — on an automation whose only
condition is `monitor status is down`, that field is the count itself, and there
is no second hold on top of it. Precedence resolves which one governs a given
device — same-rank ties go to the **smaller count**, then older, then lower id.

> **A device covered by no down automation reads `passive`.** It is still
> polled, still sampled, still charted — Polaris just declines to render a
> verdict. Anything testing `status !== "up"` as a proxy for "unreachable" must
> exempt it.

Entering or leaving `passive` is a **configuration edge**, not a state change:
no status-changed Event, no dependency propagation. A fleet with zero down
automations stamps a one-shot warning Event.

The delete/disable confirmation on a down automation reports **how many devices
it would leave passive** — the only thing that *can* warn you, since the
automation being removed is what would otherwise alert about it.

---

## The failure bucket

The whole state machine is a **leaky bucket with a ceiling** — not a run length,
and not an unbounded debt ([rule 30](Business-Rules#rule-30)):

```
a miss        → bucket += 1
an answer     → bucket -= 1   (floored at 0)
reaching N    → bucket LOCKS at max(missedPolls, recoveryPolls)
```

And the verdict:

| | |
|---|---|
| bucket == 0 | `up` |
| an **answered** probe | `recovering`, whatever the level |
| a **miss** at or above N | `down` |
| a **miss** below N | `warning` |

**The level decides what a miss means; the outcome decides everything else.**

Three consequences:

- Time-to-down is `N × intervalSeconds` for a device that stops answering, and
  longer for one that flaps.
- **Recovery costs exactly the cap, however long the outage ran.** A
  four-minute outage and a four-day one cost the same climb.
- A miss anywhere in the climb **re-locks** the bucket, so a flapping device
  cannot walk itself out of an outage.

### Why the ceiling exists

Both the cap and the always-`recovering`-on-an-answer branch are there to
prevent a specific failure:

- **Unbounded**, a device dark overnight at a 60-second cadence would reach ~480
  and then owe 480 answered polls — eight hours — before it could read `up`,
  with its down alert repeating and escalating throughout.
- **With the answered branch below the threshold test**, a probe that answered
  while the bucket was still at or above N would read `down`. The response-time
  chart has no way to paint that on an OK point, so it would fall through to
  plain green and an outage would draw red → **green** → blue → green: two
  recoveries where there was one.

One lucky packet still cannot clear the alert, because `recovering` is a
**holding state** — the down alert is held until the device reads `up`.

---

## Recovery

The same automation that defines down owns the way back up. Its **reset hold**,
collected in the wizard in **polls**, holds the device in `recovering` until
that many probes have **answered**.

So *"down after 3 missed, reset after 5 received"* describes the pill, not just
the alert.

The drain itself serves that count: the bucket locks at
`max(missedPolls, recoveryPolls)` on the verdict miss, so an outage owes exactly
your number of answers and no more. It is a ceiling rather than a floor, so a
deep outage cannot out-drain the reset — the number you write down applies to
exactly the outages it matters most for.

Only an `auto` reset counts. A **custom condition** reset is its own recovery
authority ([rule 32a](Business-Rules#rule-32)), and layering a poll count under
it would be two clocks.

---

## Confirmation is the configured cadence's job

Down is decided by **N missed polls outstanding against the operator's
configured transport, at their configured interval**.

The ICMP loss sweep **never records a probe result** — ICMP does not
authenticate the device it reaches — so it informs the loss ratio and can never
move `monitorStatus`.

**Nothing** changes the interval, dependency suppression included. A device
whose parent is dark is still probed on its normal interval, so its own count
has caught up when the parent comes back
([rule 38(c)](Business-Rules#rule-38)).

### An agent host's silence is a miss

Nothing polls a host whose response time comes from the
[Polaris Agent](Polaris-Agent) — the agent sends its own readings. So once an
agent that **finished deploying** has gone quiet for **two polling intervals**
(never less than one interval plus a minute), each interval it misses is counted
exactly like a failed ping: **Missed**, then **Down** at the automation's count
([rule 86](Business-Rules#rule-86)). At a 60-second interval and three missed
polls that is about four minutes from the last reading; the next real reading
starts the climb back.

It does not count while the agent is still installing, failed, uninstalling or
revoked; while an agent upgrade, reinstall or uninstall holds the asset in
maintenance ([rule 80](Business-Rules#rule-80)); or while Polaris itself is
the one not listening — after a restart every agent gets a full window to
reconnect, and when **no** agent anywhere is reporting (with at least two
deployed), Polaris records nothing. See
[When the host stops reporting](Polaris-Agent#when-the-host-stops-reporting).

---

## The colour of Down is not red

`down` is painted in **the covering automation's own severity** on every
surface — the last-30-minutes strip, the desktop and phone response-time charts,
and the chart rasterised into the alert email.

Red is what `critical` looks like, and `critical` is merely the default severity
of a seeded down automation. An operator who rates an outage on a device class
`warning` has said something about how it should read.

An absent or unrecognised severity — a passive device, an unresolved
automation — falls back to critical's red rather than understating a verdict
Polaris is still asserting.

> **The Status pill deliberately does not move.** Its text already names the
> state, and recolouring it would make the Down and Missed badges the same
> colour in a list column where they are read as a set.

### The chart palette

A chart already spends amber on a below-threshold miss, blue on a recovering
probe, and **grey on a dependency-explained one**. Each Down severity is pulled
deeper than the neighbour it sits beside.

`warning` versus the miss amber is the closest pair, and that is a real limit
rather than a bug: a warning-severity outage and the misses that built it are
two shades of one yellow, separated by the tooltip and by the pill, which names
the state outright.

---

## Reading a response-time chart

| Mark | Means |
|---|---|
| green line | answering |
| amber dot | a miss below the threshold |
| the automation's severity colour | `down` |
| blue | `recovering` |
| **grey** | a failure the upstream explains — [dependency suppression](Dependency-Suppression) |
| translucent labelled band | a [maintenance window](Maintenance-Windows) |
| dashed purple line, right-hand axis | packet loss, from every probe Polaris sends the device; the axis tops out at the worst loss in the window ([Assets → System](Assets#system)) |
| line/dot fading through warning → serious → critical | the reading has entered a tier of an automation watching this metric on this asset |

Severity shading is computed **server-side from the engine's own resolver**, so
what the chart paints cannot disagree with what actually fires. Thresholds
outside the visible range clamp rather than widening the axis.

---

## Troubleshooting a wrong pill

| Symptom | Look at |
|---|---|
| Device reads `passive` | no down automation covers it — check the Devices step of your down rule, and [precedence](Automations#precedence--the-single-most-important-behaviour) |
| Device reads `down` but is reachable from your desk | check which transport it is actually polled over, and whether that credential still works — the pill is about the *configured* transport, not about ICMP |
| Switch reads `up` but is not passing traffic | check **`fortilinkStatus`** — the gate's view of its own FortiLink session. A dead session still answers every ping |
| A whole site went `down` at once | check whether its parent gate is dark ([dependency suppression](Dependency-Suppression) should have prevented the storm) |
| The entire virtual fleet went `down` | vCenter unreachable should produce **skips**, not misses — check the integration |
| An agent host went `down` with nothing wrong on the box | the agent stopped reporting ([rule 86](Business-Rules#rule-86)) — check the agent service and its path to Polaris; the **Agent disconnected** alert usually fires alongside |
