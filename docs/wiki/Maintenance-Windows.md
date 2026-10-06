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
the window — on the phone's asset sheet as well as the desktop. Because nothing
is polled, the chart has no line inside the band; on the phone a chart section
with no readings says *Polling paused for maintenance* rather than *No samples*.

### Alerts already open stay open — they are paused, not cleared

An alert that was already up when the window opens **stays open** through the
window. While the device is in maintenance it is silenced: no new alerts fire
about the device, and escalation and reminders on the open alert pause.

When the window ends, polling resumes and the alert is judged on fresh
readings. If the device is healthy, the alert **resolves normally** through its
own automation — the reset actions run, exactly as they would for any recovery.
If the problem is still there, the alert simply carries on (no duplicate is
raised), and escalation and reminders pick up again. You can also clear it by
hand at any time.

A device that keeps reporting **during** the window doesn't have to wait for it
to end. A Polaris Agent keeps sending readings through a window, and so does a
**Poll Now**. If one of those readings shows the device is healthy again, the
open alert resolves right away, as it would outside a window. Only readings
taken after the window opened count, so a device that was already healthy
before the window can't clear its alert on stale data. Those readings never
raise a new alert.

That is deliberate: an alert someone was already tracking — acknowledged,
escalating, noted — should not be wiped out because a device went into
maintenance. (Between 2026-08-28 and 2026-09-30 Polaris did clear such alerts
when a window opened; that was reverted because it reset alerts operators were
still working.)

The same applies to devices silenced **behind** a device in maintenance: their
open alerts are paused too, not cleared. Only a genuine outage upstream — a
parent that is actually down — clears a child's alerts (see
[Dependency Suppression](Dependency-Suppression)).

### Except device-down alerts, which are cleared

A **device down** alert (from an automation on *monitor status is down*) is the
one kind a window clears instead of pausing. A device that is down during
planned maintenance is the downtime you announced, so leaving a red down alert
beside it adds nothing. Within a minute of the window opening, any open down
alert on the device is cleared, along with down alerts on devices silenced
behind it. The Events log records each one as cleared by `system:maintenance`.
No reset actions run, because nothing has recovered. If the device is still
down after the window ends, a new down alert fires once its automation's
missed-poll count is reached again. Every other alert on the device stays
paused, as described above.

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
| **Calendar** | every schedule's occurrences, as a month grid, a week or day time grid, or a list |

A schedule selects devices either by a **filter** or by **explicit asset ids**
(which is what the bulk bar pins), and states a recurrence.

**Create Schedule** (or **Save Changes** while editing) and **Cancel Edit** sit
bottom-right in the modal footer and show only on the Create Schedule tab; the
**×** in the header closes the modal.

### The Calendar tab

Occurrences are expanded **server-side**, because the recurrence engine works in
server-local wall clock and a browser in another timezone would paint them on
the wrong days.

Four views, switched top-right and remembered per browser; **‹ › Today** step
by the unit the view shows.

| View | What you see |
|---|---|
| **Month** | A window **a day or longer** (a change freeze, an ad-hoc "until next month") is drawn **once**, as a bar across the week row, continuing onto the next row with an open edge. A shorter window is a **chip on the day it starts**, labelled with its hours — an overnight 22:00 → 02:00 window is one chip, not one on each night. More than three bars in a week fold behind **+N more windows**. |
| **Week** / **Day** | Hours down the side, a column per day, each window a block at its hours (an overnight window is a block to midnight and another from it). Windows a day or longer sit in an **all-day** band above the hours. Today's column carries a red "now" line. |
| **List** | The same windows as rows — full names, dates, durations — grouped by the day they start, with windows already running when the month opens listed first. |

Clicking a day cell (or an hour in the Week / Day grid) opens the editor
prefilled with a one-time window there; clicking any window opens its schedule
for edit. The legend under the grid tells planned, ad-hoc and disabled apart.

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
| **Which operations** | agent upgrade, reinstall, uninstall, and a **firmware upgrade** of a switch, access point or FortiGate ([Assets](Assets#firmware)). A first install and a retry take no window — there is no agent running to disconnect, and silencing the host would hide a real problem |
| **What you see** | the device reads **maintenance** while it runs, and its Maintenance tab names the operation ("Polaris Agent upgrade", "Firmware upgrade") and the time it ends by. A firmware window suppresses everything behind the switch, exactly as a scheduled window with *mark dependents down* does — a rebooting switch takes them with it |
| **When it ends** | when the agent reconnects — not when the installer finishes, because the disconnect can be noticed up to a minute later. An uninstall ends when the uninstall does. A firmware upgrade that failed ends at once. One that reached the reboot ends when Polaris's own monitoring answers the device again, up to 10 minutes after the device confirmed its new version: its web interface comes back before the SNMP agent monitoring polls |
| **If the operation fails** | it ends immediately. An agent that is down because its upgrade failed is a real problem and you should hear about it |
| **If nothing ends it** | it expires on its own — 20 minutes for an agent upgrade or uninstall, 30 for a reinstall, 45 for a firmware upgrade (a switch flash is about fifteen minutes and the reboot up to another fifteen), extended to cover the wait for monitoring to answer when a run reaches it — at most eleven minutes past the moment the device confirmed its version. A device in maintenance is not being watched, so this can never be left open by a crash |

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
> paused (it stays open and resolves normally afterwards if the device is
> healthy) and a genuine failure that starts during it is not reported until the
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
| Scope | a device | an automation, or (globally) a set of devices, severities and alert kinds |
| Polling | **stopped** | unaffected |
| An alert already open | **stays open, paused** — resolves normally after the window, or sooner if an agent reading shows the device is healthy | unaffected |
| New alerts | **not raised** | **raised** and shown with a QUIET pill; the emails, pushes and chat messages are **held** |
| Reminders | **paused**, resume after the window | **held**, resume after the period |
| Escalation tiers | **paused**, resume after the window | **held**, resume after the period |
| Afterwards | the alert resolves or carries on | a **summary email** of what is still outstanding ([rule 92](Business-Rules#rule-92)) |
| Recurrence model | shared | shared |

**Maintenance silences the device. Quiet time silences the people, and tells
them afterwards.**
