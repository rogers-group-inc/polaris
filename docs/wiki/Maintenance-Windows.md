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

## Ad-hoc windows

The monitor pill's popover — on both the table and the slide-over's System tab —
offers:

- **"Enter maintenance mode until…"** — creates a one-shot schedule.
- **"End maintenance now"** — releases *this occurrence*, per the start-keyed
  rule above.

Every schedule mutation reconciles **inline**, so an ad-hoc window applies
immediately rather than on the next tick.

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
