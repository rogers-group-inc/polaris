# Business rule 78 — full narrative

> Split out of `narrative-60-64.md` on 2026-09-21, which reached the 1500-line reference-file
> ceiling when rules 76–79 landed within a day of each other. Rule numbers are a stable
> citation key and did not change; only the file holding this one did. Rules 60–77 and 79 stay
> in `narrative-60-64.md`, whose name is itself a citation key and does not move.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 78](#rule-78) — An automation may choose to speak for a silenced device, and then it must name who silenced it
- [Rule 78a](#rule-78a) — A dependency-down alert is acknowledged when its root cause's own alert is, and says whose acknowledgement it carries

<a id="rule-78"></a>

## Rule 78 — An automation may choose to speak for a silenced device, and then it must name who silenced it

Dependency suppression exists to stop a storm. When a FortiGate goes dark, every switch, access
point, server and camera behind it stops answering too, and without suppression each of them
raises its own Down alert about an outage that has exactly one cause. So a device behind a
confirmed-down parent is marked `dependencySuppressed`, `assetCanTrigger` drops it from every
automation (rule 37), and any alert already live on it is retired by the 60-second sweep (rule
16 — a genuine outage only; a device silenced by a maintained parent keeps its alert frozen). For the NOC that is the right answer: one alert, on the gate, is the outage.

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
cannot be named. The name, the reason, the hop count and the whole chain between them are snapshotted on
`Notification.dependencyDown` + `dependencyBlame`, so the row still explains itself after the
dependency tree is recomputed and the flag is a COLUMN because three readers need it without
reading text: the sweep, the engine's handoff and the alert surfaces' badge. (`templateCtx` would
not do — that snapshot is written only when the rule composes or escalates, and the simplest
in-app-only automation writes none.)

The email draws that chain (`{dependency.path}`, `alertDependencyPathService`, 2026-10-02): root
cause on the left, the alerting device on the right, each device in the Device Map location box
its a:/b:/f:/r:/jb: codes put it in, a generic box labelled with its Location when it has none,
and the LLDP port names on each link. The operator asked for it so a plant reader sees which
boxes sit between the dark one and theirs, and where each of them physically is. Two decisions
are worth keeping. It draws the FIRE-TIME chain, not a fresh walk at delivery: the picture has
to agree with the sentence above it, and an escalation an hour later that drew a different chain
under an unchanged sentence would contradict itself. And it draws at most four devices — the root
cause and the one below it, the upstream device and the alerting device, with a "+N more" gap
between — because the two ends are what the email is for; the middle is the asset page's job.

**The all-clear draws the chain as it is now (2026-10-08).** The reset email, the one announcing
the dependency-down alert is over, repeated the fire-time picture: a red "Root cause" and a grey
"Dep. Down" under a green "Resolved" header. Its one image contradicted the message. The
operator caught it. The fix keeps the fire-time DEVICES (the same chain, in the same order, so
the reader recognizes the picture they were paged with) and colours each one by what it reads at
DELIVERY: Up, Recovering, Missed poll, Down, Dep. Down, In maintenance, or "State unknown" when
the read failed. Those states are read, never assumed. An alert can end while the root cause is
still recovering, and a picture that painted everything green would claim a recovery Polaris has
not seen. The drain learns it is rendering an all-clear from `meta.allClear` on the composed row,
which `expandDeliveries` stamps from the same fact as `noAck` (only an all-clear sets it). The
render memo is keyed per kind of send, so a firing email and its all-clear draining in one pass
never share a picture.

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
retires a plain alert on an asset suppressed behind a genuinely down parent (never one whose
blame chain runs through a maintenance window), and the next engine tick raises the dependency
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

**So a live alert on a suppressed device is not evidence of maintenance** (2026-10-09).
`notificationService.maintenanceHoldsByAsset`, which stamps the MAINT pill on the Active Alerts
widget and the asset Alerts tab, used to answer "upstream" from `dependencySuppressed` alone, on
the premise that the sweep had already retired everything not owed to a window. This exemption is
exactly where that premise fails: a site gate went down, the truck-scale server behind it got its
DEPENDENCY DOWN alert, and the row wore MAINT ("an upstream device is in a maintenance window")
while no window was open anywhere. "upstream" is now read off `resolveDependencyBlameMany` — a
`maintenance` link in the chain, the same test the sweep applies — and a failed walk claims
nothing. The pause the pill described was real; only its cause was wrong, so the Dep. Down
badge's tooltip now says reminders and escalation wait for the upstream. Pinned by
`tests/integration/alertMaintenanceHold.test.ts`.

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

### Rule 78 — the invariant as stated in full until 2026-09-22
> Moved here verbatim from the invariants file on 2026-09-22, when the invariant layer was cut back to the contract alone; the short invariant now points here for the reasoning and the dated history. Nothing below was rewritten.

**An automation may choose to speak for a silenced device, and then it must name who silenced it** — dependency suppression silences every automation about a device behind a dark parent (rules 16 and 37), and exactly ONE thing may opt out of that silence: the `monitorStatus == down` trigger itself, through its own key `alertWhenDependencyDown` (in the trigger JSON beside `missedPolls`, refused anywhere else and inside a multi-condition trigger, read only through `notificationTypes.ruleAlertsWhenDependencyDown`, and not part of `triggerIdentityOf`). An opted-in automation keeps its dependency-suppressed devices in evaluation and **fires on the suppression EDGE** — `resolveAssetStateReadings` hands each such device a synthesized `down` reading flagged `dependencyDown`, because the upstream's confirmed verdict IS the evidence and waiting for the device's own count at half cadence would tell the plant operator late what the pill already says. The alert it raises **says DEPENDENCY DOWN** (the `{dependency.summary}` banner, the ` · DEPENDENCY DOWN` subject tag, `{trigger.summary}` replaced by `dependencyTriggerSummary`, the in-app message the whole sentence) **and names who silenced it**: `dependencyTreeService.resolveDependencyBlame` walks UP from the device — a parent is blamed as `dependency_test` / `maintenance` / `suppressed` / `down` in that order, so a switch that is both suppressed and reading `down` under a dark gate keeps the walk going to the gate — and the alert carries the UPSTREAM device (directly above) and the ROOT CAUSE (dark in its own right; blank in the template when it is the upstream itself, so the row prunes rather than repeats), snapshotted on `Notification.dependencyDown` + `dependencyBlame` so the row explains itself after the tree is recomputed. **The alert's flavour follows the asset's flag**: a live plain Down alert whose device turns Dep. Down, or a dependency-down alert whose upstream is back while the device stays dark, is ENDED (`system:dependency-down` / `system:dependency-released`, audited as `notification.superseded`, NO reset actions — nothing recovered) and raised again in the other flavour, so the operators hear "and it is the switch" or "and now it is the PLC itself". Three things the opt-out does NOT reach: a **maintenance window still silences** (rule 16 wins — announced downtime is not an outage to report); **reminders and escalation still pause** while the asset is suppressed (rule 16's pause in the escalation sweep, unchanged — the operator asked for one notification); and **`clearSuppressedAlerts` never retires a `dependencyDown` row** — the sweep excludes them in its query, because retiring the one alert that is supposed to be live on a suppressed asset would have the engine re-raise it every tick. A blame walk that fails still lets the alert out, worded without a name: "your PLC is dependency down" beats silence even when the switch cannot be named. Every automation WITHOUT the key behaves exactly as before.


<a id="rule-78a"></a>

## Rule 78a — A dependency-down alert is acknowledged when its root cause's own alert is, and says whose acknowledgement it carries

Asked for on 2026-10-09: with Dependency-Down Bypass on, a gate going dark raises its own Down
alert and one DEPENDENCY DOWN alert per opted-in device behind it. The NOC acknowledges the
gate's alert, with a note saying what happened and who is on it, and every dependency alert
underneath stays unacknowledged. On the Active Alerts widget that reads as a dozen problems
nobody owns, when there is one problem somebody owns. The operator's words: when the
triggering asset's alert is acknowledged, acknowledge the bypass alerts too, and when hovering
the acknowledge pill, show the reason typed on the triggering alert.

### Which alert is "the triggering asset's"

The ROOT CAUSE's, not the upstream's. Rule 78's blame walk already separates the two: on a
two-hop chain the upstream is a switch that is itself suppressed — a victim — and the device
actually down is the FortiGate above it. The FortiGate's alert is the one the NOC acknowledges.
The root's alert is identified by shape, shared by both edges through `ROOT_DOWN_ALERT_WHERE`:
live, about a device, not a wizard test, not itself dependency-flavoured, and stamped
`metric: "monitorStatus"` (what every down automation writes). A root cause blamed for
`maintenance` or `dependency_test` raises no down alert of its own, so there is nothing to
inherit and nothing is looked up.

### Both edges, because either can come first

Acknowledging the root's alert cascades to every live dependency alert already naming it. But a
dependency alert can also be raised AFTER the acknowledgement — a device behind the gate flips
Dep. Down a tick later, or a plain Down alert is handed off into the dependency flavour (rule
78). Without the fire-time half, those would sit unacknowledged under an acknowledged outage,
which is the exact picture the operator asked to get rid of. So the engine asks
`rootCauseAckFor` before creating the row and writes it acknowledged.

### What is copied, and what says it was copied

`acknowledgedBy` and `acknowledgeNote` are the root alert's, copied — every surface that already
prints them (the "ack jsmith" pill, the ack card's Note row, the asset tab, the phone) prints the
right person and the right reason without learning anything new. What they cannot tell on their
own is that the note was typed about a different device, so `Notification.acknowledgedVia`
records the root alert (`{notificationId, assetId, hostname}`) and the ack pill's hover says
"Inherited from the root cause's alert on FG-PLANT" above the note. A column rather than a
marker in the note: the note is the operator's text and is quoted back verbatim.

### Decisions worth keeping

- **The dependency automation's note policy is not re-asked.** The acknowledgement was made,
  under the root automation's own policy; refusing the cascade because a different automation
  wants a note would leave the very rows this rule exists to close open.
- **A born-acknowledged alert still delivers.** The plant operators the bypass exists for (rule
  78) still need to hear their PLC is down; the acknowledgement says the NOC owns the outage, not
  that nobody else should be told. Reminders and escalation were already paused for a
  dependency alert while its device is suppressed.
- **One way only.** Acknowledging a dependency alert acknowledges nothing upstream: a plant
  operator seeing their PLC alert does not own the gate.
- **The cascade is best-effort.** It runs after the operator's own write and its failure is
  swallowed — the operator's acknowledgement of the root must never fail because the children
  could not be read. The return value stays the count the operator acknowledged.
- **A flavour hand-off is a new alert.** When the upstream recovers and the device stays down,
  rule 78 ends the dependency alert and raises a plain Down one — that is the device's own
  outage now, and it inherits nothing.

Pinned by `tests/integration/dependencyDownAckInherit.test.ts` (the JSON-path match against a
real database, the feed's `ackInheritedFrom`, one-way only), `tests/unit/dependencyDownAckInherit.test.ts` (the cascade and the pure helpers),
`tests/unit/notificationDependencyDownAlert.test.ts` (born acknowledged, the root-cause lookup,
the maintenance and plain-Down exclusions) and `tests/unit/widgetActiveAlerts.test.ts` (the
hover).
