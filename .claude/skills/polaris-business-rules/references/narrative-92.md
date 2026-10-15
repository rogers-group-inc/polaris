# Business rule 92 — full narrative

> Written 2026-10-03 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 92](#rule-92) — Quiet time withholds the send, never the alert — and what it withheld is reported when it ends

<a id="rule-92"></a>

## Rule 92 — Quiet time withholds the send, never the alert — and what it withheld is reported when it ends

### The ask

2026-10-03. The operator wanted two things rule 44 could not give them. First, a quiet time
that applied to *every* automation at once — "a global quiet time for notice through serious,
and let critical fire at will" — configured from a Settings button on the Automations page
with the same progression the automation wizard has: which devices, which alerts, when. Second,
and this is the part that changed the meaning of the word: *"just because it's quiet doesn't
mean the alerts should be dropped."* At the end of each quiet range they wanted one summary
email per person who would have been told, listing what was **still outstanding** — an
interface that went down and came back inside the window is not news at 07:30 — plus any alert
that kept recurring (more than X times, same automation, same device, same port or mount) with
the count and every time it fired. No graphs; each row opens the device in Polaris. And a
summary is email, full stop: a person who prefers push gets the summary by email anyway,
because there is no summary push and there should not be.

Asked how an automation's own quiet time should relate to a global one, they said the
per-automation quiet time should work the same way — hold the sends, summarise afterwards —
with an automation that has one being exempt from the global schedules. And then, a little
later: *"automations with quiet time configurations also need the ability to quiet only the
repeat emails and the escalation emails."* That sentence is the `holds` setting.

And later still, looking at the step itself: *"instead of a toggle for overriding the global
quiet time schedules, make it a 3 way toggle, Off, Ignore Global Quiet Time, Override Global
Quiet Time."* The toggle had conflated two things — "this automation has windows of its own"
and "the global schedules stand aside" — so a critical automation on an install whose global
quiet time covered every severity had no way to say "never quiet" short of inventing a window
that never opens. The middle setting is that sentence, stored as `{ignoreGlobal: true}` in the
same column (`ruleQuietTimeSchema`), so the resolver still asks one question of one column.

Two days later (2026-10-05) the `holds` mode itself went: *"when a severity is selected, then
underneath each selection is 'alerts' and 'escalation alerts' and underneath each of those are
their own 'reminders'. by default if a severity is selected, then all of those are selected
also, but then the user can de-select 'reminders' or 'escalations'."* One mode for the whole
policy could not say "hold warning entirely but let critical's escalation tier through", and
the engine already told the four kinds of send apart — a tier's first run and its repeats are
different code paths from the base reminder pass. So the policy carries `held`, a per-severity
map of the four kinds, the sweep asks the resolver per DUE send naming its kind, and the
legacy pair is read as "every kind" or "every kind but the fire" until the editor re-saves it.
Ticked means held and, for the first alert, reported in the summary — the user confirmed that
reading over the inverse, so an unticked box is simply a send that goes out live.

### What rule 44 was, and why it had to widen rather than be joined

Rule 44 lived inside a notify action's reminder settings and paused REMINDERS only. Its own
narrative argued, correctly for its question, that the first alert must always send and that
an escalation tier chasing a specific person must not be silenced from a control labelled
"reminders". Both arguments assumed the operator's question was "stop the chasing overnight".
The 2026-10-03 question is a different one — "nobody needs to hear about a warning at 02:00,
tell them at 07:30 what is still wrong" — and a reminder-only hold cannot answer it: the first
alert *is* the 02:00 email.

The alternative was to leave rule 44's control where it was and add a second one beside it.
That would have put two things called "quiet time" on one automation that mean different
things, one inside each reminder block and one on its own step. So quiet time became ONE
policy of the automation (`NotificationRule.quietTime`) and of the install (`QuietTimeSchedule`),
with a `holds` mode (since 2026-10-05 the per-severity `held` map) that says how much of the automation it silences — and rule 44's
machinery survives inside it as the part that still makes sense: a held send is an overdue
one, the hold is stamped, and the reminder that ends it says how long the alert has been going.

### The decisions, and the constraints that forced them

**The decision is made in `executeActions`, not in the engine.** Every people-facing send
passes through `automationActionService.executeActions` — the engine's fire and growth paths,
the event/change tail (which never builds a `Reading`, so a hold placed in `enqueueAlertActions`
would have missed every event-driven automation), and the three all-clear paths. The sweep's
tiers and reminders pass through it too, but the sweep has already gated them and says so with
`exec.escalation` / `exec.repeat`. One read of the alert row there answers both questions the
function has: is this fire quiet, and is this all-clear about an alert nobody was told of.

**The held rows ARE the recipient list.** `expandDeliveries` has seven ways to resolve who an
action reaches, the rule-39 preference filter, the dispatch stamp and the composed body. The
summary needs exactly that answer, so rather than rebuild the resolver beside itself, a held
fire runs the expander unchanged with `hold` set: the rows are written `status: "held"`, which
the drain never selects, and the summary reads them back — an email row's To line and Cc, a
web-push row's `meta.userId` reached by the account's email, chat rows reaching nobody.
`alreadyEmailedOnChannel` ignores held rows, or a held email would block a later real
push-to-email fallback for the same address.

**Precedence is a property of the automation.** `resolveQuietHold` asks the automation's own
`quietTime` first and, when it has one, nothing else — matching or not. That is the operator's
"quiet times in an automation override the global quiet times", and it is what lets a critical
automation carry its own policy without a global schedule reaching past it. Only an automation
with no quiet time of its own consults the global schedules, oldest first: severity, alert kind
(`Notification.metric`; an event alert has none and matches only "any"), window, then scope —
scope last because it is the one test that needs a device read, done through a `ScopeAsset`
select of its own since `ASSET_DETAIL_SELECT` lacks `discoveredByIntegrationId`.

**Held, never advanced — and the summary restarts the clocks.** The sweep holds both passes
above them, like suppression, so nothing in `escalationState` moves; every due tier and
reminder goes out on the first sweep after the window. For an alert whose FIRE was held, that
would have paged everyone the moment the window ended about an alert the summary had just
listed, so the sweep's `startAt` becomes `max(startAt, quietSummarizedAt)`. A shifted start
rather than seeded state keys, because `tierIsDue` reads a tier with a state entry and no
repeat as "already ran" — seeding would have silenced that tier forever.

**The summary is one email per reader, in the reader's zone.** Rule 25 says an ALERT is one
message to one To line, rendered in the install's zone, because nothing about one reader may
split the audience of an alert. A summary is not an alert: it is already addressed to one
person, and `userTimezoneService` had reserved `resolveTimeZone` for exactly "a per-user
digest". So each recipient's copy renders their own zone (explicit → detected → install), and
an address with no account gets the install's. It goes through the policy's own channel, else
the first email channel among the held rows, else the first enabled email channel; none at all
leaves the row `unroutable` with a warning Event and the alerts still on the Active Alerts page.
Each recipient is retried for ten minutes of ticks, not the drain's three — one email a night
must survive a short SMTP outage — and a row that still failed carries a **Resend** verb on the
Settings tab, which re-queues only the recipients it never reached. That verb exists because
the very first summary on the dev stack failed every attempt on a mistyped channel host, seconds
before the host was corrected, and there was no way to send it.

**Each reader is told only about their own alerts.** The first version decided the
summary's contents once per SOURCE and mailed that one list to the union of every listed
alert's audience. A source is a whole global quiet time, which covers every automation that
does not opt out, so on 2026-10-12 an infrastructure distribution group received a summary
naming devices from automations that had never paged it. The operator: *"i want filtered
results that only pertain to that recipient."* The held rows already said who each alert was
for, so the create step reads them for EVERY covered alert and keeps the answer per recipient
(`SummaryRecipient.alertIds`, by address and by push account). The drain renders each copy
through `detailsForRecipient`: outstanding rows whose alert is theirs, and recurring rows with
any member that is theirs (a recurring row now carries `notificationIds`). A reader whose
own alerts all recovered gets the all-quiet copy that counts their own alerts, or no email
when `summaryAlways` is off. The row's `details` stays the whole night: it is the record of
what the source held. The all-quiet row built from static recipients carries no `alertIds`
and lists nothing, so it is unaffected. A row written before this change has no `alertIds`
and renders whole, which is what it actually sent. Each sent copy also records `zone` and
`sentAt`, so the Recipients view's **View email**
(`GET /automations/quiet-times/summaries/:id/email?address=`,
`renderSentSummaryEmail`) re-renders exactly that reader's copy from the stored facts, with
today's template and letterhead.

**Due is "the stretch ended, the send time arrived, and it is not quiet again".** A window
ending 06:00 with a 07:30 send time summarises at 07:30; a second window that opened at 07:00
folds those alerts into ITS summary rather than mailing mid-silence. The send time is refused
only when it is inside the quiet period on EVERY day the period occurs, in the browser and on
the server (`summaryTimeConflicts` walks a year of occurrences, midnight-spanning ones at both
days' HH:MM, and compares the days quiet at HH:MM against the days touched at all). The first
version refused a time inside ANY window, and the first operator to build "nights and weekends"
with a 07:30 summary hit it at once: Saturday 07:30 is quiet, so no morning time was legal, yet
the semantics already handled it — weekday nights summarise at 07:30 and the weekend rolls
into Monday's. Only a time that is never free (every night 22:00–08:00, summary 07:30) is a
contradiction. A deleted schedule flushes at once, named from the stamp the alert carries.

**What is still outstanding, and what recurred.** Decided once, at creation, and stored on
the `QuietTimeSummary` row: uncleared alerts are listed; an alert that fired more than the
threshold times for one (automation, device, component) is listed with every fire time and
whether it is still active, and is not repeated under outstanding. Every held alert of the
source is stamped `quietSummarizedAt`, listed or not — "covered" is not "named". Nothing
outstanding and nothing recurring writes an `empty` row and no email — until 2026-10-05, when the
operator asked for the opposite: *"I do want to send a summary email even if nothing happened,
just letting the user know that emails are still working and that nothing outstanding happened
overnight."* That is the ALL-QUIET email (`summaryAlways`, on by default, the operator's call).
It covers two cases the old rule treated as silence: every held alert recovered (the email goes
to whoever those alerts would have reached, with the count) and NOTHING was held at all — which
has no held alert to anchor a summary on, so `createAllQuietSummaries` walks the recurrence
instead (`lastQuietStretch`: the stretch that most recently ended), writes one row per stretch
(deduped on `coveredTo`, never for a stretch that ended before the policy's last edit), and
derives the audience from the automations the policy covers: the static recipients of their
notify actions. Device-dependent recipients were left out at first, and on 2026-10-06 an
all-quiet email on an install that routes by device region reached only 3 people (the
operator: *"could we include users in device regions?"*). `recipientDeviceRegion` and
`recipientDeviceRegionLevels` now resolve against every region snapshot of the rule's
MONITORED in-scope devices (`loadScopeRegionSnapshots`, deduped per distinct set, read once
per rule and only when an action routes that way) — everyone the rule could page from any of
them. A device's address-book contacts stay out: outside contacts of one device, not a
standing audience. The editor's checkbox reads **All-Quiet Summary emails** (operator's wording).

**The all-clear of an alert nobody was told about says nothing.** `fireReset`, `fireResolved`
and the operator clear all converge on `executeActions`, which already knows an all-clear by
`ctx.severity === "resolved"`; when the row has `quietHeldAt` and no `quietSummarizedAt`, the
notify actions are skipped and an Event says why. Once a summary has named the alert, its
all-clear goes out like any other.

**What never changes.** A wizard test delivery is never held — it exists to show the email.
Scripts, API calls and the audit Event run through every quiet period, in both modes. An
unreadable policy is "not quiet" (the rule-44 posture: a bad blob must cost one page too many,
never an outage nobody heard of), and so is a failed catalog or alert read in the hot path,
logged at warn.

### The migration

Existing `repeat.quiet` windows were promoted into `NotificationRule.quietTime` by a one-shot
(`migrateRepeatQuietToQuietTime`) in the `followUps` mode — the one that keeps doing what they
did (pause reminders) and adds only what the operator asked for the same day (pause the tiers
too). Holding first alerts and summarising is one click in the Quiet time step, but it is the
operator's click: a migration must not start withholding first alerts overnight on a
configuration that never asked it to. An old export file carrying `repeat.quiet` imports the
same way (`normalizeRuleInputCore`). `AlertGroup.repeat.quiet` is simply no longer read.

### Recipient exceptions (rule 120)

Since 2026-10-14 a policy may name addresses that do not follow it. Such a hold is SPLIT: who is held is decided per address, a reminder or tier pass is sent (live to the excepted readers, `deferred` for the rest) and advances its state instead of being skipped, and the held readers get the newest copy when the window ends. Everything in this narrative still describes a policy with no exceptions. See [narrative-120.md](narrative-120.md#rule-120).

### 92(f) — the summary tells every covered reader the whole stretch (2026-10-15)

The operator runs one global *nights and weekends* quiet time over every automation. One
morning the summary's recipients list showed five all-quiet emails where about twelve were
expected. Two gaps, one cause each.

**The audience was decided by whoever happened to be held.** A summary had two builders: the
held-alert path, whose recipients were the `held` delivery rows and nothing else, and the
all-quiet pass for a stretch NOTHING was held in, whose recipients were the covered
automations' static recipients. The held path marked its source handled, so the all-quiet
pass skipped it. One team's held alert at 02:00 therefore decided the audience for the whole
global quiet time: every reader of every other covered automation got no morning email at all
— and the all-quiet email exists precisely so its arrival proves the path works. Now the held
path adds the same static audience (`coveredRulesOf` + `staticRecipientsOfRules`), each with
an empty held list, so they get the all-quiet copy; per-reader filtering (2026-10-12) is
untouched, nobody is shown another team's devices.

**A reader paged live would have been told "all quiet".** The policy holds serious and below;
a critical goes out live at 03:00. Once the audience widened, that reader's morning email
would say nothing happened. The operator's call: list it. *Rejected:* skipping the all-quiet
copy for anyone who got a live alert — the email would then vanish for exactly the people
having the worst night, and the summary would stop being the one place the night is told.
*Rejected:* deciding at summary time which source a live alert "belonged" to by re-running
the window, kind and scope match — with several global schedules that guess can disagree
with the one decision function. Instead the FIRE records it: a fire not held while a window
is open is stamped `quietSource` with no `quietHeldAt` (`resolveQuietWindow`, the same
precedence as `resolveQuietHold` minus severity and send kind), and the summary reads
`quietSource` + `triggeredAt` within the stretch. Being stamped without `quietHeldAt` keeps
it out of the held set, its all-clear unaffected and its clocks untouched. A rule-120 split
fire that reached every reader live is stamped the same way.

Found alongside: `deleteQuietTimeSchedule` counted held alerts with
`quietSource: { equals: { kind, id } }` against a stamp that also carries `name`, so the
"N held alert(s) will be summarised now" count was always zero. It filters on the `id` path now.

### Where it lives

`utils/quietTime.ts` (the policy shape, `summaryTimeConflicts`, `summarySendAt`),
`services/quietTimeHoldService.ts` (the decision), `services/quietTimeScheduleService.ts` (the
global rows), `services/quietTimeSummaryService.ts` + `jobs/sendQuietTimeSummaries.ts` (the
summary), `utils/quietSummaryEmailTemplate.ts` (the email), the hold in
`automationActionService.executeActions` / `notificationRecipientService.expandDeliveries`,
the sweep gate in `notificationEscalationService`, the route
`src/api/routes/quietTimeSchedules.ts`, and in the browser `quiet-time-editor.js` (shared by
the automation wizard's step 6 and `quiet-time-wizard.js`), `automations-settings.js`, the
`PolarisRecurrence` schedule composite, and the QUIET pill on the alert surfaces. Pinned by
`tests/unit/quietTimeConfig.test.ts`, `quietTimeHoldAtFire.test.ts`, `quietTimeHoldResolve.test.ts`, `quietTimeSummary.test.ts`, `quietSummaryEmailTemplate.test.ts`,
the quiet block of `notificationRepeat.test.ts`, `migrateRepeatQuietToQuietTime.test.ts`,
`quietTimeEditorDom.test.ts` and `quietTimeSettingsDom.test.ts`.
