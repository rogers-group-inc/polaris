# Business rule 106 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 106](#rule-106) — Every alert email that leaves is recorded on its asset, and that record never raises an automation

<a id="rule-106"></a>

## Rule 106 — Every alert email that leaves is recorded on its asset, and that record never raises an automation

### What was asked

On 2026-10-12 the operator asked that an automation's email notification also create an
Event on the asset, saying that an email was sent and who it went to. Until then the only
record of a delivery was the drain's one summary Event per pass (`notification.delivered`:
"3 sent, 0 failed"), filed under no asset, naming nobody. A device's Events tab showed the
alert fire and clear, but not whether anyone had been told.

### Where the record is written, and why there

In the delivery drain (`notificationDeliveryService.ts → drainPendingDeliveries`), after
the status writes, from the rows that read `sent` — not at fan-out in
`notificationRecipientService`. Fan-out records an intention; a row can still fail three
times, or hit a deleted channel, and an Event saying "sent to ops@" for an email that never
left is worse than no Event. The drain is the first place that knows. One Event per sent
email row (a composed send is ONE row carrying the whole To / Cc / Bcc list — rule 25), all
written in one `logEventsBatch` per pass, so an alert storm costs one insert per 15s tick
however many emails it drains.

It is filed exactly as the other alert Events are — `resourceType: "notification"`,
`resourceId` the alert, `details.assetId` the device — because that is what
`eventLogService.ts → eventAssetIdOf` stamps into `Event.assetId`, the column the
asset-details Events tab reads. An alert with no asset (a capacity warning, a failed backup)
has no tab to put it on and gets none; a test fire (rule 65) is about an invented device and
gets none.

### Bcc is counted, never named

The Events tab is readable by anyone who can read the asset. A Bcc address listed there is
unblinded to all of them — the same exposure rule 60 forbids in the email's own footer. The
Event names To and Cc and carries only `bccCount` ("+2 Bcc"). Who exactly was on Bcc stays
on the delivery row's `meta.bcc`, where it already was.

### Why the record never raises an automation

An event-triggered automation's action pattern is a glob. One written as `*`, or as
`notification.*` to page on alert lifecycle, with an email action, would match the
`notification.email_sent` Event its own email produced: the email writes the Event, the
event tail fires the automation, the automation emails, and so on once per 15s drain for as
long as the automation exists — a cooldown slows it, nothing stops it. The same reasoning
already kept event-triggered automations out of the "Create an Event" action (the carve-out
in `polaris-change-impact` → cross-cutting/automation-action-types.md: the event tail writes
no Events, because one that did would feed its own trigger); this Event is written by the drain, not the tail, so that carve-out does not cover
it.

So `runEventTail` skips it before both matcher sets — trigger and reset — through
`notificationTypes.ts → eventFeedsAutomations`, keyed on `ALERT_EMAIL_SENT_ACTION`. The
cursor still advances past it with the rest of the batch. Nothing is lost by the exclusion:
"an email was sent" is the consequence of an alert, and any automation that wants to act on
the alert can trigger on the alert itself.

### Pinned by

`tests/unit/automationActions.test.ts` — `emailSentEventsFor` (what is written, Bcc never
named, assetless / test / non-email rows skipped, the all-clear and push-fallback wording)
and the rule 106 guard (`eventFeedsAutomations` refuses the email Event, admits every other
alert lifecycle Event); "a failed email writes no asset email Event" for the sent-only half.
