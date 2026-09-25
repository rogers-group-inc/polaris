# Maintenance windows

A maintenance window is how you tell Polaris *"we are working on this, do not
report it"*.

Gated by `maintenanceManagement`. Reached from **Assets → Maintenance**, from a
selection's bulk bar, or from the monitor pill's popover on a single device.

---

## What a window does

**It pauses everything** ([rule 16](Business-Rules#rule-16)):

- Stops **all** server-driven polling for the device.
- Counts the device as **down for child dependency suppression** — unless the
  schedule's *suppress children* option is off.
- Silences notifications for it **and for every dependency-suppressed child**.
- Holds `Asset.status = "maintenance"`, parking the previous status so it comes
  back afterwards.

Dashboards treat maintenance as **its own state, never an outage**. The monitor
pill turns purple, and every asset chart draws a labelled translucent band over
the window.

### It retires live alerts — it does not freeze them

An alert that was already up when the window opens is **cleared**, not paused.
The state row is released, **no reset actions run**, and a still-bad condition
**re-earns its debounce and fires anew after the window**.

That is the right behaviour: the alert that was live before the window is about
a device nobody was working on yet.

### Discovery must not fight it

Discovery and system writers never write a status over a maintenance asset. The
one carve-out is deletion-at-source — a discovery decommission sweep still
applies, because the device is genuinely gone.

---

## Creating one

Three tabs:

| Tab | |
|---|---|
| **Create Schedule** | the form, with a live device-list preview |
| **Schedules** | the list of what exists |
| **Calendar** | a month grid of every schedule's occurrences |

A schedule selects devices either by a **filter** or by **explicit asset ids**
(which is what the bulk bar pins), and states a recurrence.

### The Calendar tab

Occurrences are expanded **server-side**, because the recurrence engine works in
server-local wall clock and a browser in another timezone would paint them on
the wrong days.

Clicking a day cell opens the editor prefilled with a one-time window on that
date; clicking a chip opens its schedule for edit.

---

## The recurrence model

A schedule states **days and hours**, and **a day carries a list of hour
ranges**.

| Shape | Means |
|---|---|
| a day with **no** ranges | the whole day |
| a day with one or more ranges | those ranges |
| a day not selected | nothing |

So one day produces **zero or more occurrences**, and **each range is its own
occurrence with its own start**.

That matters because the operator-release check identifies an occurrence by its
**start**: an operator who ends maintenance during the 09:00 window stays
released for that window and **re-enters for the 14:00 one** — behaviour a
single range per day could not express.

Two rules follow:

- **Two ranges on the same day may not overlap** — refused at validation. Two
  occurrences over one instant makes "which occurrence is this?" unanswerable.
- **Overlap across days is allowed and ordinary** — a Friday night running into
  an all-day Saturday — and resolves to the **earliest-starting containing
  occurrence**.

The shape, its validator, its evaluator and the browser's editor for it are
shared verbatim with automation
[quiet time](Automation-Escalation#quiet-time).

### Everything is server-local wall clock

**There is no offset.** A window is picked in the *server's* wall clock, and the
editor asks the server what that is.

This is not pedantry. A browser that prefills a `datetime-local` from its **own**
clock posts the operator's digits for the server to read as its own — and on a
UTC-clocked host with a Central operator, *"now → now + 2 hours"* became a window
that started five hours ago and **had already ended**. The schedule saved
cleanly and nothing ever entered maintenance.

---

## Acting on a schedule from the device

The asset edit modal's **Maintenance** tab lists the schedules covering this
device, and each row carries its two verbs: **remove this asset** from the
schedule, or **delete the schedule** outright.

Before, acting on one of them meant leaving the asset, opening Assets →
Maintenance, finding the schedule among all the others and editing its targets.

### Only the explicit half is removable

A schedule's targets are the **union of a criteria filter and an explicit asset
list**, and only the explicit half can be removed one device at a time.

Dropping the id of a device the **filter** matches changes nothing the
reconcile can see: the filter still matches, the next tick re-targets the
device, and you would have been told *"removed"* about a device still heading
into the window. So that call is **refused**, and each row instead reports
**how the schedule reaches this asset** — explicitly, by criteria, or both —
rendering the reason rather than a button the server would reject.

**Narrowing a filter stays with the schedule builder**, which is the only
surface that can show you what else that filter catches.

### The last one out takes the schedule with it

A schedule with **no criteria** whose explicit list your removal would empty is
**deleted**, not saved empty.

A targetless schedule can never fire again, and every other write path already
refuses one — so leaving it behind would create a row the builder itself would
reject on its next save. The confirmation warns you about the delete before you
agree to it, and the result says which of the two happened rather than leaving
you to infer it.

### Neither verb closes an open window itself

Falling out of the target set is something the reconcile already handles — and
it is also what **restores the parked status**. Closing the window here as well
would fork the one exit path.

So a device currently *inside* a window leaves it on the next reconcile tick,
with the end recorded as a criteria change, or as a deletion when the schedule
went too.

---

## Watching what is in maintenance right now

The Maintenance modal's **Schedules** and **Calendar** tabs tell you what is
planned. To see what is *running*, put the **Active Maintenance** widget on a
dashboard ([Dashboard](Dashboard#the-widget-library)). One row per schedule in
effect, showing what it holds — device count and the asset types among them —
and **when its window expires**, in the server's wall clock with a countdown
beside it. Rows are ordered soonest-ending first, and the expiry turns amber in
the last half hour.

It is deliberately the mirror of every other widget: since maintenance is not
an outage, the down/warning/stale widgets leave these devices out, and this one
is where they reappear.

Clicking a row offers **Open schedule…** (the same editor the Assets page
opens, loaded on that schedule) and **Disable schedule** — which ends its open
windows immediately, returns the held devices to polling, and stops the
schedule firing until re-enabled. A **+ New schedule** button at the top of the
widget opens that editor empty, so a window can be scheduled from the dashboard
without going to Assets first. All three need `maintenanceManagement:write`,
like the modal itself.

A row filtered out of a *device*-scoped board does not mean the maintenance is
narrow: the widget lists a schedule whenever **any** of its devices is in
scope, and then shows the whole thing, so the count you read is the real one.

---

## Ad-hoc windows

The monitor pill's popover — on both the table and the slide-over's System tab —
offers:

- **"Enter maintenance mode until…"** — creates a one-shot schedule.
- **"End maintenance now"** — releases *this occurrence*, per the start-keyed
  rule above.

Every schedule mutation reconciles **inline**, so an ad-hoc window applies
immediately rather than on the next tick.

---

## Windows Polaris opens for itself

Some of what Polaris does to a device **is** downtime for it. Upgrading,
reinstalling or uninstalling the [Polaris Agent](Polaris-Agent) stops the agent
service on the host, which drops its connection — and without this, the
`agent.disconnected` automation would page you about work you asked for.

So those three operations put the asset in maintenance for their duration
([rule 80](Business-Rules#rule-80)). You do not create or manage these: they
open when the operation starts and end when the agent reconnects.

| | |
|---|---|
| **Which operations** | agent upgrade, reinstall, uninstall, and a **firmware upgrade** of a switch or access point ([Assets](Assets#firmware)). A first install and a retry take no window — there is no agent running to disconnect, and silencing the host would hide a real problem |
| **What you see** | the device reads **maintenance** while it runs, and its Maintenance tab names the operation ("Polaris Agent upgrade", "Firmware upgrade") and the time it ends by. A firmware window suppresses everything behind the switch, exactly as a scheduled window with *mark dependents down* does — a rebooting switch takes them with it |
| **When it ends** | when the agent reconnects — not when the installer finishes, because the disconnect can be noticed up to a minute later. An uninstall ends when the uninstall does. A firmware upgrade that failed ends at once. One that reached the reboot ends when Polaris's own monitoring answers the device again, up to 10 minutes after the device confirmed its new version: its web interface comes back before the SNMP agent monitoring polls |
| **If the operation fails** | it ends immediately. An agent that is down because its upgrade failed is a real problem and you should hear about it |
| **If nothing ends it** | it expires on its own — 20 minutes for an agent upgrade or uninstall, 30 for a reinstall, 45 for a firmware upgrade (a switch flash is about fifteen minutes and the reboot up to another fifteen). A device in maintenance is not being watched, so this can never be left open by a crash |

These windows are usually **very short** — an agent upgrade can open and close
one inside two seconds. That is shorter than the interval event automations run
on, which is why they judge an event against the device's maintenance history at
the moment it happened rather than against its state when they get round to
reading it ([rule 80a](Business-Rules#rule-80a)). Without that, a window this
brief would suppress nothing at all.

They do **not** appear on the Active Maintenance widget, which lists your
schedules — a fleet-wide agent upgrade would otherwise fill a wallboard with
one-minute entries. They do appear on the device: its status, its Maintenance
tab, its `maintenance.entered` / `maintenance.exited` events and its chart bands.

> **It silences the whole device, not just the agent.** For the length of the
> operation the asset is in maintenance, so a live alert on the way in is
> retired and a genuine failure that starts during it is not reported until the
> window ends. That is the same trade every maintenance window makes, for a
> minute or two per device.

Ending maintenance yourself (setting the status to something else) wins, as
always — the operation carries on, and you will hear about it if it breaks
something.

---

## Who holds the truth

Open `AssetMaintenanceWindow` rows are the **restart-safe** source of truth, and
the scheduler manages the status flips. Nothing else should write
`status = "maintenance"`.

Because rule 10 forces `monitored = false` on the four unmonitorable statuses,
the parked previous status can only ever be `active` — every other status is
untargetable in the first place.

---

## Maintenance vs quiet time

They are easy to confuse and do opposite things:

| | Maintenance window | Quiet time |
|---|---|---|
| Scope | a device | a reminder on one notify action |
| Polling | **stopped** | unaffected |
| The first alert | **retired** | unaffected |
| Reminders | n/a — there is no alert | **held**, and sent when the window ends |
| Escalation tiers | n/a | unaffected |
| Recurrence model | shared | shared |

**Maintenance silences the device. Quiet time silences the chasing.**
