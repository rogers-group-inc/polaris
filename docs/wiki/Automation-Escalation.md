# Escalation, reminders and quiet time

Three different answers to "nobody has dealt with this yet", and they live in
three different places because they are three different questions.

| Control | Question | Lives on |
|---|---|---|
| **Escalation** | if this stays unhandled, who *else* should hear? | the **severity section** |
| **Reminder** (`repeat`) | how often should this delivery chase? | the **notify action** |
| **Quiet time** | when should nobody be told — and told what, afterwards? | its own step (**Quiet time**), or **Automations → Settings** for every automation at once |

---

## Escalation

A chain of further actions taken when the alert is still live after N minutes.

**Escalation is per severity, not per action.** The base actions section hosts
the rule-level chain — which is exactly the chain the engine resolves for an
alert sitting at the base severity — and each per-severity section hosts its
band's own.

It used to sit on every action row, where *"if this stays unhandled, do more"*
read as *"if this email goes unanswered"* while the one chain actually fired for
the whole tier.

A stored per-action chain is **hoisted and merged** into its severity's chain
when you open the automation: tiers concatenate and sort by `afterMin`, and
since each tier carries its own actions the deliveries and their timings are
unchanged. The action-level chains are then stripped so the sweep cannot fire
both. Per-action chains stay in the schema, so a rule this wizard has not
re-saved keeps working.

Each tier carries:

| Field | Means |
|---|---|
| **After N minutes** | wall time from the fire |
| **Actions** | a full action list — usually a wider recipient set |
| **Repeat every** | the tier's own re-send cadence |
| **Stop on** | what ends the chain — typically acknowledgement |

Tier-hosted action rows carry **no escalation footer**: no chains inside chains.

### The pattern this exists for

> The trigger notifies `Asset's L1 Region Users` — the site's own people.
> Tier 1, after 15 minutes, notifies `Asset's L2 Region Users` — the division
> over them.

One automation, two honest audiences, no duplication.

---

## Reminders

**"Repeat this action"** at the foot of a notify row: *re-send every N minutes*
and *give up after N hours*. (Quiet time used to sit here too; it is the
automation's own step now — [below](#quiet-time).)

A reminder re-sends **notify actions and nothing else**, which is why it belongs
to the action ([rule 56](Business-Rules#rule-56)). *"Page the on-call every five
minutes and leave the nightly digest alone"* is one automation with two honest
answers, and no per-automation or per-severity cadence can say it.

It is offered on the **firing** lists only — never on reset actions, never on a
band's resolved actions, and never on an escalation tier (which has its own
`repeatEveryMin`). A recovery has nothing to chase.

**Presence, not truthiness.** An action declaring `repeat: null` is an *answer*
("this one does not chase"); an action carrying no key at all is every
automation authored before this and keeps inheriting the rule-level clock.
Saving the step migrates the automation forward — but only when you have
actually opened the step.

`stopAfterHours` is wall time from the fire, **quiet time included**. The wizard
warns about that pairing rather than extending the deadline.

> The re-notify **cooldown** — how often a *new* alert may fire — was retired
> from the builder ([rule 32](Business-Rules#rule-32)). "Repeat this
> notification" answers the question operators were actually reaching for it to
> answer. The column and the engine's checks survive dormant, and a one-shot
> cleared every stored value fleet-wide after auditing it, because removing the
> control without clearing the data would have left automations silenced by a
> number no Polaris surface could show or edit.

---

## Quiet time

Hours during which an automation stays quiet ([rule 92](Business-Rules#rule-92)).
**A quiet period never drops an alert.** The alert is still raised, shows on the
Active Alerts page with a **QUIET** pill, and writes its audit event; scripts and
API calls still run. What changes is who hears about it, and when.

There are two places to set one:

| Where | Applies to | Set from |
|---|---|---|
| **An automation's own quiet time** | that automation only | the wizard's **Quiet time** step (step 6) |
| **A global quiet time** | every automation that has **no** quiet time of its own | **Automations → Settings → Global Quiet Times** |

The automation's **Quiet time** step is a three-way choice:

| Setting | Means |
|---|---|
| **Off** | No quiet time of its own. The global quiet times apply to it. |
| **Ignore Global Quiet Time** | No quiet time at all. It sends whatever the hour, even inside a global quiet time — what a critical automation usually wants. |
| **Override Global Quiet Time** | Its own quiet time, set below the choice. The global ones do not apply to it. |

Either of the last two leaves the automation alone when a global quiet time
opens — that is how a critical automation keeps paging while everything else
waits.

### What goes quiet

Each quiet time says, **per severity**, which sends it holds. Under every
severity you tick are four boxes:

| | Means |
|---|---|
| **Alerts** | the first alert (and a grouped alert's growth update) — the one send that owes a **summary email** afterwards |
| ↳ **Reminders** | the alert's own reminders ("Repeat this action") |
| **Escalation alerts** | each escalation tier's first run |
| ↳ **Reminders** | a tier's own repeats |

Ticking a severity ticks all four; a ticked box is **held** during the quiet
period, an unticked one goes out live whatever the hour. Untick a severity to
let it through entirely — the usual shape is everything but critical, and a new
global quiet time starts that way. Untick **Alerts** but leave the rest to get
the old reminder-only quiet time: the first alert and the all-clear still send,
the chasing waits for the period to end. With no severity holding its first
alert there is nothing to report, and the summary section disappears.

Held means held, never skipped: nothing in the alert's escalation clock moves
while a send is quiet. The reminder that ends a hold still says *"Reminders
resumed after a quiet period — this alert has been active for 9h 12m"* and
carries `· ACTIVE 9h 12m` in its subject ([rule 44](Business-Rules#rule-44)).

### Which alerts

- **Severities.** The tree above. Untick a severity to let it through whatever
  the hour.
- **Kinds of alert** (global quiet times only). Any alert, or only the metrics
  and device states you pick — CPU, interface status, PoE, and so on. Audit-event
  and change automations carry no kind and match only "Any alert".
- **Devices** (global quiet times only). The same device filter the automation
  wizard uses.

### When

The schedule editor is the Maintenance modal's. For specific days of the week
you write **periods** — "Mon–Fri 22:00–06:00", "Sat, Sun all day" — each a
row of day chips with either *all day* or one or more hour ranges; add as many
periods as the week needs, or start from a preset (*Nights*, *Every night*,
*Weekends*, *Outside business hours*). **Quiet outside these hours** turns the
periods inside out, so working hours are what you type and the quiet time is
everything else. A week strip and a per-day breakdown under the periods show
exactly what will be quiet. Monthly and yearly schedules take a day of the
period and an hour list, and every schedule can carry a first and last date.
Times are **server-local wall clock** —
the zone is printed beside the hours, and a browser prefilling 22:00 from its
own clock is the whole trap. A 22:00–06:00 window survives DST and midnight.
A window set through the API that the editor cannot express (a one-shot) is
listed read-only and kept as it is.

### The summary email

When a quiet period that held everything ends, Polaris emails **everyone the
held alerts would have reached** — the people on the notify actions, address-book
contacts, typed addresses, and anyone who would have been pushed (reached by
their account's email; a push preference is ignored, since there is no summary
push). **One email per person, in that person's own time zone.** It lists:

- **Still outstanding** — the held alerts that have not recovered or been
  cleared by the time it is sent: severity, device, what, since when, how long.
  An alert that came and went inside the period is **not** listed.
- **Recurring** — an alert that fired **more than X times** during the period
  for the same automation, device and component (the *recurrence threshold* on
  the quiet time), listed with the count and every time it fired, whether or not
  it has recovered. It is not repeated under Still outstanding.

No graphs and no Acknowledge button; each device name opens the device in
Polaris.

**The all-quiet email.** When the quiet period ends with nothing to list —
every held alert recovered, or nothing was held at all — the summary still
goes out, saying so: nothing is outstanding, how many alerts fired and
recovered (or that none were held), and that its arriving confirms the quiet
time and your email delivery are working. It goes to everyone the covered
automations notify: the people, addresses, roles, tags and regions their
notify actions name (recipients that depend on the triggering device cannot be
worked out without an alert and are left out). It is on by default; untick
**Send the summary even when nothing was held** on the quiet time to get a
summary only when something was held.

**When it is sent.** When the quiet period ends, or at a **send time** you
choose — a time of day. On a day it falls inside the quiet period the summary
waits: *nights and weekends* with a 07:30 send time summarises each weekday
night at 07:30 and rolls the weekend into Monday's. A send time that is inside
the quiet period on **every** day it occurs could never go out on time, so the
editor and the server refuse it. Alerts held until the send time roll into
that summary; if another quiet period opens first, they roll into *its* summary.
**Through which channel:** the one you pick on the quiet time, else the alert's
own email channel, else the first enabled email channel. With no email channel
at all the summary cannot be sent, an Event says so, and the alerts are still
on the Active Alerts page.

Once an alert has been named in a summary it behaves like any other: its
reminders and escalation count from the summary, and its all-clear is sent.
The all-clear of a held alert that was **never** summarised sends nothing —
there is no inbox to resolve it in.

The Settings modal lists recent summaries: when, which quiet time, how many
alerts it covered, how many it listed, and who it reached. A send that fails is
retried for about ten minutes; a summary that still did not reach everyone
shows **Resend**, which sends it again to the recipients it missed (and nobody
else) once the channel is fixed.

### What quiet time is not

A **maintenance window** is not a quiet time. It stops polling the device, so no
new alerts are raised about it at all, and it freezes an open alert for the
whole window ([rule 16](Business-Rules#rule-16)). Quiet time keeps watching and
keeps raising; it only decides who is told, and when.

A wizard **test delivery** is never held — it exists to show you the email.

### Validation

A half-typed day contributes no window, so the step names the day — and the
overlapping pair of hours — in the same words the server would, and a day
listed both all day and with hours is refused by name. A send time inside the
quiet period on every day it occurs is refused. The reminder note on
the Actions step still warns that `stopAfterHours` counts quiet time too.

---

## What stops all of it

| Event | Effect |
|---|---|
| **Acknowledge** | stops escalation and reminders where `stopOn` says so; the alert stays live |
| **Clear** | ends the alert, runs the reset actions, stops everything |
| **The reset condition becomes true** | same as Clear, automatically |
| **The device leaves the scope** | alert cleared as `out_of_scope` |
| **The device stops being monitored** | same ([rule 37](Business-Rules#rule-37)) |
| **A maintenance window opens** | nothing ends — the alert stays open, escalation and reminders **pause** until the window ends, then it resolves or carries on as usual ([rule 16](Business-Rules#rule-16)) |
| **The parent goes dark** | dependency suppression retires it — a parent genuinely down, not one in maintenance ([rule 38](Business-Rules#rule-38)) |
| **A more specific automation carves the device out** | cleared as `superseded` ([rule 18](Business-Rules#rule-18)) |
| **The pin is removed** | a dimensioned alert clears ([rule 57](Business-Rules#rule-57)) |

A **quiet period** is not in this table on purpose: it ends nothing and pauses
nothing about the alert itself. It holds the sends, and the summary email
reports what is still outstanding when it ends ([rule 92](Business-Rules#rule-92)).
