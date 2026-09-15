# Escalation, reminders and quiet time

Three different answers to "nobody has dealt with this yet", and they live in
three different places because they are three different questions.

| Control | Question | Lives on |
|---|---|---|
| **Escalation** | if this stays unhandled, who *else* should hear? | the **severity section** |
| **Reminder** (`repeat`) | how often should this delivery chase? | the **notify action** |
| **Quiet time** | when should the chasing pause? | inside the reminder block |

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

**"Repeat this action"** at the foot of a notify row: *re-send every N minutes*,
*give up after N hours*, plus the quiet-time editor.

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

Up to 8 recurring windows per reminder, edited with the same day/hours editor
the Maintenance modal uses: seven day rows, each **off**, **all day**, or
carrying **one or more hour ranges**.

Because a day carries a *list* of ranges, one window says *"nights during the
week, all weekend"*. That is why the wizard edits a **single** window and lists
any others read-only — a one-shot, a monthly freeze, a window with active-date
bounds — rather than offering to rewrite them into something the rows cannot
say.

### Five things quiet time is

1. **Held, never skipped.** The sweep does not advance the reminder's clock on
   one it withholds, so that reminder stays **due** and goes out on the first
   tick after the window ends. There is nothing to schedule — a held reminder is
   simply an overdue one.
2. **The reminder that ends a hold reports the silence.** It carries
   *"Reminders resumed after a quiet period — this alert has been active for
   9h 12m"* in the body and `· ACTIVE 9h 12m` in the subject. The question after
   a silent night is how long this has been going on, not which reminder number
   arrived. That marker rides **only** that reminder.
3. **The hold is closed by the send, not by the window ending** — a reminder
   whose channel was dead retries next sweep and must still be the one that
   reports the silence.
4. **A hold only exists where a reminder was actually withheld.** Quiet with
   nothing due stamps nothing, so a reminder that comes due 20 minutes after the
   window ended is an ordinary reminder and says so.
5. **Times are server-local wall clock.** The zone comes from the server on the
   automations schema payload, not from your browser — a browser prefilling
   22:00 from its own clock is the whole trap. A 22:00–06:00 window survives DST
   and midnight.

### What quiet time is not

It does **not** touch the first alert, the escalation tiers, or the reset
notifications. A tier exists to chase a specific person harder, so silencing it
from a control that says "reminders" would weaken an escalation you configured
somewhere you were not looking. `escalation.stopOn` and `repeat.stopOn` are
still the only things that stop either.

A **maintenance window** is not a quiet hold. It retires the alert outright
([rule 16](Business-Rules#rule-16)).

### Validation

A half-typed day contributes no window, so the step asks what is wrong and
**names the day** — and the overlapping pair of hours — in the same words the
server would. Without that, a ticked box with nothing behind it saves silently
as "no quiet time" and you find out from the reminders still arriving overnight.

The live note warns about the two pairings that surprise people: `stopAfterHours`
counts quiet time too, and an all-day-every-day window holds every reminder
indefinitely.

---

## What stops all of it

| Event | Effect |
|---|---|
| **Acknowledge** | stops escalation and reminders where `stopOn` says so; the alert stays live |
| **Clear** | ends the alert, runs the reset actions, stops everything |
| **The reset condition becomes true** | same as Clear, automatically |
| **The device leaves the scope** | alert cleared as `out_of_scope` |
| **The device stops being monitored** | same ([rule 37](Business-Rules#rule-37)) |
| **A maintenance window opens** | the alert is **retired**, not frozen ([rule 16](Business-Rules#rule-16)) |
| **The parent goes dark** | dependency suppression retires it ([rule 38](Business-Rules#rule-38)) |
| **A more specific automation carves the device out** | cleared as `superseded` ([rule 18](Business-Rules#rule-18)) |
| **The pin is removed** | a dimensioned alert clears ([rule 57](Business-Rules#rule-57)) |

Note that a maintenance window **ends** an alert rather than pausing it. A still
bad condition re-earns its debounce and fires anew after the window — which is
correct, because the alert that was live before the window is about a device
nobody was working on yet.
