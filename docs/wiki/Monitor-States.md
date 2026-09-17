# Monitor states and down detection

The monitor pill has six values, and how it moves between them is one of the
most consequential pieces of behaviour in Polaris.

| State | Means |
|---|---|
| `up` | answering, and the failure bucket is empty |
| `warning` | has missed polls, but the bucket is below the threshold |
| `down` | the bucket has reached the covering automation's `missedPolls` |
| `recovering` | answered again, but has not yet answered enough times to read `up` |
| `passive` | **no automation covers this device, so Polaris renders no verdict** |
| `unknown` | never probed, or the probe could not run |

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

Both the cap and the always-`recovering`-on-an-answer branch landed in
2026-09-01, and **both were bugs before that**:

- **Unbounded**, a device dark overnight at a 60-second cadence reached ~480
  and then owed 480 answered polls — eight hours — before it could read `up`,
  with its down alert repeating and escalating throughout.
- **With the answered branch below the threshold test**, a probe that answered
  while the bucket was still at or above N read `down`. The response-time chart
  has no way to paint that on an OK point, so it fell through to plain green and
  an outage drew red → **green** → blue → green: two recoveries where there was
  one.

One lucky packet still cannot clear the alert, because `recovering` is a
**holding state** — the down alert is held until the device reads `up`.

Pre-ceiling rows self-heal on their next probe of either outcome, and are swept
once at boot.

---

## Recovery

The same automation that defines down owns the way back up. Its **reset hold**,
collected in the wizard in **polls**, holds the device in `recovering` until
that many probes have **answered**.

So *"down after 3 missed, reset after 5 received"* describes the pill, not just
the alert.

Since the ceiling landed, the drain itself serves that count: the bucket locks
at `max(missedPolls, recoveryPolls)` on the verdict miss, so an outage owes
exactly your number of answers and no more. It was a **floor** before — which
meant a deep outage out-drained the reset, and the number you wrote down stopped
applying at exactly the outages it mattered most for.

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

Exactly **one** clamp applies to the interval: dependency suppression doubles it
for a device whose parent is dark.

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
| line/dot fading through warning → serious → critical | the reading has entered a tier of an automation watching this metric on this asset |

Severity shading is computed **server-side from the engine's own resolver**, so
what the chart paints cannot disagree with what actually fires. Thresholds
outside the visible range clamp rather than widening the axis.

---

## Troubleshooting a wrong pill

| Symptom | Look at |
|---|---|
| Device reads `passive` | no down automation covers it — check the Devices step of your down rule, and [precedence](Automations#precedence--the-single-most-important-behaviour) |
| Device went `down` when you disabled its polling | you are on a build before 2026-08-28; `responseTimePolling = disabled` used to record a miss |
| Two readings per cycle, misses counted twice | you are on a build before 2026-09-10; the probe queue re-ran batched ICMP chunks |
| Device reads `down` but is reachable from your desk | check which transport it is actually polled over, and whether that credential still works — the pill is about the *configured* transport, not about ICMP |
| Switch reads `up` but is not passing traffic | check **`fortilinkStatus`** — the gate's view of its own FortiLink session. A dead session still answers every ping |
| A whole site went `down` at once | check whether its parent gate is dark ([dependency suppression](Dependency-Suppression) should have prevented the storm) |
| The entire virtual fleet went `down` | vCenter unreachable should produce **skips**, not misses — check the integration |
