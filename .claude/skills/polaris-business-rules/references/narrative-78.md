# Business rule 78 — full narrative

> Split out of `narrative-60-64.md` on 2026-09-21, which reached the 1500-line reference-file
> ceiling when rules 76–79 landed within a day of each other. Rule numbers are a stable
> citation key and did not change; only the file holding this one did. Rules 60–77 and 79 stay
> in `narrative-60-64.md`, whose name is itself a citation key and does not move.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 78](#rule-78) — An automation may choose to speak for a silenced device, and then it must name who silenced it

<a id="rule-78"></a>

## Rule 78 — An automation may choose to speak for a silenced device, and then it must name who silenced it

Dependency suppression exists to stop a storm. When a FortiGate goes dark, every switch, access
point, server and camera behind it stops answering too, and without suppression each of them
raises its own Down alert about an outage that has exactly one cause. So a device behind a
confirmed-down parent is marked `dependencySuppressed`, `assetCanTrigger` drops it from every
automation (rule 37), and any alert already live on it is retired by the 60-second sweep (rule
16). For the NOC that is the right answer: one alert, on the gate, is the outage.

### The plant operator hears nothing

It is the wrong answer for the people who care about one device. The request that forced this
rule (2026-09-20) was a PLC on a plant switch, with the plant operators subscribed to the PLC's
down automation. When the switch died the PLC went Dep. Down, the automation went silent, and the
only string anywhere in Polaris naming the switch as the reason was an audit Event
(`monitor.dependency_suppressed … parent SW-PLANT-3 down`) that nobody on the plant floor reads.
The switch's own alert went to the network team. The people whose line had stopped were told
nothing at all.

The operator's words: *"if the parent switch actually goes down, then the plant operators will
still get an email saying the PLC is dependency down and they'll know which switch is
responsible."* Two demands, both load-bearing: the alert still goes out, and it names the cause.

### The opt-out is the down trigger's own

Silence stays the default. What changed is that a `monitor status is down` automation can opt out
of it, and only that automation: `trigger.alertWhenDependencyDown` rides the trigger JSON beside
`missedPolls`, for the same reason `missedPolls` does — both are properties of the down verdict,
not of the rule's delivery. `validateMissedPolls` refuses the key off a down-detection trigger and
inside a multi-condition trigger (a silenced device reports nothing the other conditions could
read), and the one reader, `ruleAlertsWhenDependencyDown`, is gated on `isDownDetectionTrigger`
so a key stranded on a retyped trigger can never turn a CPU automation into one that fires about
silenced devices. `triggerIdentityOf` ignores it: ticking the box must not purge the rule's state
rows and re-arm every debounce, the same protection the count has.

The wizard's catalog carries the key's name (`downDetection.dependencyDownKey`), so a browser
talking to a pre-upgrade server renders no control rather than one whose key the API would 400.

### It fires on the edge, not on the count

The engine's gate loop keeps an opted-in automation's dependency-suppressed devices in `active`,
and `resolveAssetStateReadings` hands each of them a SYNTHESIZED reading: `value: "down"`,
`dependencyDown: true`, the probe's own verdict kept aside as `ownMonitorStatus`. The alert
therefore fires the moment the reconciler flags the device, not when the device's own probe —
running at half cadence while suppressed — reaches the missed-poll count.

That was a decision, taken with the operator, and the reasoning is worth keeping. The device's own
count is the definition of down for a device Polaris can reach (rule 36). A device behind a dark
switch is not one Polaris can reach; its own probe is going to fail whatever the switch does, and
waiting for it to say so would tell the plant operator, minutes late, what the pill already says.
The parent's confirmed verdict is the evidence. A device that keeps answering over a redundant
path is still handled honestly: the synthesized reading holds the alert while the flag holds, and
the moment the flag clears the real status returns — `up` recovers the alert normally.

### The alert says what it is, and names who

Every surface says DEPENDENCY DOWN, because a message reading "monitorStatus = down (threshold
down)" would be the one thing this alert is not saying. Five template tokens carry it
(`utils/notificationTemplate.ts`), all present-but-empty on every other alert so the default body
prints them for free: `{dependency.summary}` is the whole notice — *DEPENDENCY DOWN — PLC-7 is
unreachable because its upstream device SW-PLANT-3 is down* — and rides a slate banner under the
headline (the Dep. Down pill's colour) that `pruneEmptyDivs` removes on every other send;
`{dependency.upstream}` and `{dependency.rootCause}` are fact rows; `{dependency.tag}` appends
` · DEPENDENCY DOWN` to the default subject; and `{dependency.headline}` is the
compact form — the state and who, without the device's own name.

That fifth token exists because of a hole a live dev run found, and it is worth
recording as the general shape of the mistake. The seeded "Asset down"
automation carries `messageTemplate: "{asset} is down"`, and an operator's own
template WINS over the generated default — correctly, it is theirs. But push,
Slack, Teams and Pushbullet send `Notification.message` and nothing else, so on
the very automation most likely to be covering a PLC, the plant would have been
paged with the one fact they already knew ("ASHF-FILE-01 is down") and none of
the reason. The email was fine; the surfaces the operator actually carries were
not. So the notice is APPENDED to their words rather than replacing them —
`"ASHF-FILE-01 is down — DEPENDENCY DOWN — upstream ASHF-CORE-SW1 is down (root
cause ASHF-EDGE-FG1)"` — and skipped when their template already renders the
notice itself, since it is a catalogued token they may have used. `{trigger.summary}` is replaced by
`dependencyTriggerSummary` (the device's own probe did not decide this alert, so "Monitor status
is down" would mislead), and the default in-app message — what push, Slack, Teams and the phone
show — is the rule name plus the whole sentence.

Naming who is the harder half, and it is not `evaluateSuppression`'s answer. That function
returns a boolean per asset and throws away which parent decided it; worse, the device directly
above is not always the device that is down. A PLC's switch may itself be Dep. Down under a dark
FortiGate — its own probe reads `down` too, since it is behind the gate — and naming the switch
would send the plant operator to a box that is a victim, not a cause. So
`dependencyTreeService.resolveDependencyBlame` walks UP. A parent is blamed as `dependency_test`,
`maintenance`, `suppressed` or `down`, in that order: the two overlays first because the operator
has already named the cause ("pretend THIS box went offline"), and `suppressed` BEFORE `down` so a
switch that is both keeps the walk going to the gate. The first blamed monitored parent is the
UPSTREAM; the walk continues while the blamed node is blamed only for being suppressed itself,
and the first node dark in its own right is the ROOT CAUSE. Unmonitored parents are transparent
and unmonitored HA standbys ignored, as in `isParentOk`; among redundant parents a definitive
reason outranks `suppressed` and hostname breaks the tie; the walk is bounded at sixteen hops and
says `truncated` on the cap or a cycle. `{dependency.rootCause}` is BLANK when it is the upstream
device itself, so the "Root cause" row prunes away instead of repeating the "Upstream device" row.

Two things the walk deliberately is not. It is not `connectionPathService.resolveConnectionPath`,
whose parent tie-break prefers an `up` parent — exactly the wrong bias when the question is who is
down. And it is not the reconciler Event's `parentAssetIds`, which is the whole effective parent
set (healthy redundant parents included) and never reaches past layer 1.

The walk loads the ancestor closure hop by hop through a cache the engine renews every tick, so
three hundred PLCs behind one switch load the switch and the gate once between them. It never
throws: a failed read yields null and the alert goes out worded without a name — *because a
device above it is down* — since "your PLC is dependency down" beats silence even when the switch
cannot be named. The name, the reason and the hop count are snapshotted on
`Notification.dependencyDown` + `dependencyBlame`, so the row still explains itself after the
dependency tree is recomputed and the flag is a COLUMN because three readers need it without
reading text: the sweep, the engine's handoff and the alert surfaces' badge. (`templateCtx` would
not do — that snapshot is written only when the rule composes or escalates, and the simplest
in-app-only automation writes none.)

### The flavour follows the flag

An alert raised while the device was Dep. Down and an alert raised because its own probe failed
are two different statements, and the operator chose that a change between them be heard. So the
alert's flavour follows the asset's `dependencySuppressed`: for an opted-in rule the engine tick
reads each live alert's `dependencyDown`, and a firing row whose reading disagrees with it goes
through `handoffDependencyFlavour` — soft-clear as `system:dependency-down` or
`system:dependency-released`, release the state row, audit `notification.superseded`, and fire
again in the other flavour. No reset actions run either way: nothing recovered, and mailing
"Resolved" about a PLC that is still dark would be a lie.

Both directions matter. A PLC alerts as plain Down a minute before the switch above it is
confirmed down (they miss polls together, and the smaller count wins); when it turns Dep. Down
the plain alert ends and the dependency-down alert goes out naming the switch — the "which switch
is responsible" message the operator asked for. On the way back, the switch recovers, the PLC is
released, and if the PLC is STILL down the dependency-down alert — now claiming a switch that is
fine — ends and a plain Down alert is raised: *and now it is the PLC itself*. Only a genuinely
met reading triggers the handoff; a released device reading `recovering` or `warning` is simply
held until it reads `up`, as every down alert is (rule 36).

The 60-second sweep normally does the first half a tick early: `clearSuppressedAlerts` still
retires a plain alert on a suppressed asset, and the next engine tick raises the dependency
flavour. The in-loop handoff exists for the race where the flag flips between the sweep and the
loop, and for the reverse direction, which the sweep cannot see.

### Three things the opt-out does not reach

**Maintenance still silences.** The carve-out in the gate loop is dependency-only: a device in a
maintenance window stays in `suppressedIds` whatever its automation says. Announced downtime is not
an outage to report (rule 16 wins), and an opted-in PLC automation must not page the plant every
time the switch above it is scheduled for a firmware update.

**Reminders and escalation still pause.** The operator asked for one notification. The escalation
sweep already pauses every live alert on a suppressed asset; an alert raised BY this rule is on a
suppressed asset by construction, so it inherits the pause with no new code and resumes — or ends
— when the upstream is back. That is the whole of "one notification": the first email goes out,
and nothing chases it until the picture changes.

**The sweep never retires a dependency-down row.** `clearSuppressedAlerts` adds
`dependencyDown: false` to its query. Without it the sweep would retire the alert the engine just
raised, the engine would raise it again on the next tick, and a plant operator would receive one
email a minute until the switch came back. The exclusion is in the query rather than a branch
because such rows must never even reach the asset lookup: they are the one alert that is SUPPOSED
to be live on a suppressed asset, and the engine owns their end.

### Where it shows

The Active Alerts widget, the asset's Notifications tab and the phone's alert list badge the row
"Dep. Down" in the same slate the Status pill wears, the widget's tooltip naming the upstream; the
audit Event carries `dependencyDown`, `upstreamAssetId` and `rootCauseAssetId` for a script or a
SIEM to follow; and a Test-delivery of an opted-in automation renders the dependency notice
against an invented upstream (`SAMPLE_UPSTREAM_HOSTNAME`), so the operator sees the banner and
the rows a real one carries.

Pinned by `tests/unit/notificationDependencyDownAlert.test.ts` (the engine half, including that an
automation WITHOUT the key still drops the asset and that maintenance still silences),
`tests/unit/dependencyBlame.test.ts` (the walk — same fixtures `dependencyTreeService.test.ts`
builds), `tests/unit/notificationSuppressionSweep.test.ts` (the exclusion), the template and
email-template suites (the tokens and the pruning), `tests/unit/downDetectionTriggerSchema.test.ts`
(where the key may live) and the wizard DOM suite (the Actions-step row, the key surviving a
Trigger-step re-collect, the strip on a composite).
