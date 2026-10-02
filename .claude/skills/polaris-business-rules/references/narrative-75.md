# Business rule 75 — full narrative

Split out of `narrative-60-64.md` on 2026-09-18 when that file reached the 1500-line ceiling, the
same way `narrative-44-48.md` was split from `narrative-36-43.md` and `narrative-60-64.md` from it.
**The filenames are stable citation keys** — each keeps its original name whatever range it now
holds, because code comments, commits and the other skills link to them. Read the invariant in
`invariants-30-43.md` first; this is the reasoning behind it.

<a id="rule-75"></a>

## Rule 75 — An alert may name many problems on one device, and it ends only when the last of them does

A PoE fault rarely hits one port. A PSU browns out, an injector fails, a switch reboots — and
eight ports fault inside the same 60-second engine tick. Before this rule that was eight alerts,
eight emails and eight acknowledge links, because alert state was keyed per `(rule, asset,
dimension)` with no per-asset coalescing. Rule 57 had already written the gap down, at the end of
its own narrative: *"a PSU browning out on a 48-port switch is 48 alerts, 48 emails and 48 ack
links."* It is the same complaint one layer up from the one rule 57 answers — the pin gate stops
an automation alerting about ports nobody chose, and says nothing about the ports somebody did.

### What is shared, and what is emphatically not

The temptation is to re-key the state machine per asset. That would have been wrong, and the
measure of how wrong is everything hanging off the current key: `forPolls` runs, `bandMetSince`
per tier, the hysteresis dead band, `recoveredSince`, the pin gates, the vanished-state sweep.
Every one of those is a statement about ONE component, and a device-level key would have had to
answer "has it held for three polls?" about eight ports at once.

So **`NotificationRuleState` is untouched.** It stays keyed `(ruleId, assetId, dimensionKey)` and
every mechanism above still runs per contribution. Only the `Notification` row is shared: many
firing state rows point at one of them. The whole feature sits behind `ruleGroupsByAsset`, which
is false for every rule in an install that has not ticked the box, so a fleet that does not use
this pays nothing — not a query, not a branch on the hot path.

That choice bought one property worth naming, because it is what makes the second phase of this
work (folding alerts across several automations) cheap: the question "was that the last
contribution?" is a `count` over state rows `WHERE notificationId = ? AND state = 'firing'`, and
that WHERE **carries no `ruleId`**. It is already the right question whether the contributions came
from one automation or five.

### The snapshot is for rendering, and only for rendering

`Notification.members` carries the contributions — key, operator-facing label, ruleId, severity,
`joinedAt`, `leftAt`. It exists because the alert email renders at DELIVERY time and the alert page
renders after the clear, both long after the state rows were released, and a delivery-time join
back to a table that no longer holds the answer is not a join that can work.

It is therefore **a render snapshot and never the live truth**, and the direction matters: asking
the snapshot whether something is still firing would either strand an alert nothing can clear (a
stale entry) or end one that is still firing (a missing entry). Both failures are silent. The
state rows are asked; the snapshot is written.

The snapshot also keeps departed contributions, with `leftAt` stamped rather than being dropped.
What the alert covered is the history the snapshot exists to carry — an operator reading a cleared
alert wants to know it was eight ports, not the one that happened to recover last.

`mergeMembers` deliberately does NOT drop a stored contribution just because a tick produced no
reading for it. A collection gap is not a recovery — the same rule the engine's no-readings freeze
enforces one layer down, and the same one rule 57 learned the hard way when a single unreadable
PoE column made a port look absent and raised a duplicate alert per collection gap. Departure is
stamped on the recovery transition by `markMemberLeft`, which is the only place that knows.

### Buffering, and why it is not an optimization

`fire()` under grouping writes nothing: it buffers the contribution and returns, and
`flushGroupFires` does every write once it can see all of that tick's.

This is correctness, not speed. The eight ports land in one `readings` loop, so a
find-then-join per reading would be eight reads, eight updates and — the part that matters —
up to eight sends, on precisely the tick the feature exists to quieten. Buffered, the eight
become **one create and one send by construction**: nothing is suppressed after the fact,
because the second message is never created.

The same argument one level up is why sends drain once per TICK (`pendingSends`, drained in
`evaluateAllNotificationRules` after every rule) rather than at the end of each rule's flush.
Within a single automation the two are equivalent; across automations they are not, and building
it the cheap way would have meant a PoE fault and a temperature alarm arriving together producing
a fire and then a growth — two messages about one moment.

The flush's position is load-bearing and easy to break: **after the readings loop, before the
custom-reset pass**, because that pass re-reads firing rows from the database rather than from the
pre-loop snapshot. And nothing is written in `fire()` on purpose — upserting the state row there
would park it `firing` with a null `notificationId` until the flush, and a row in that shape is
unreachable by every recovery path there is.

### The bug this rule is mostly about

`recover()` used to run `fireReset` before the clear, so the reset's delivery rows could hang off
a still-live notification id. Under grouping, unchanged, that meant **the first of eight ports to
come back mailed the alert's "Resolved" while seven were still faulted.**

So `recover()` asks `releaseGroupMember` FIRST and returns before `fireReset`, before the clear and
before the `notification.auto_cleared` Event when it was not the last one. `fireResolved` carries
the same guard internally rather than at its four call sites, because a guard that has to be
remembered at four places is a guard that will be missed at the fifth.

A middle contribution's departure still rewrites the alert: its list, count and severity, and its
message unless the operator wrote a custom template — in which case the message is left alone,
deliberately. Re-rendering one here would mean rebuilding a full template context from a recovery
that carries no reading, and a sentence the operator wrote would come back with half its tokens
blanked. A stale component list inside a custom sentence is the smaller lie.

### One chokepoint, because the assumption was in more places than it looked

`clearActiveNotification` is where the release happens, and every clear path goes through it:
auto-recovery, both timed sweeps, the carve-out handoff, the device-down handoff, the
vanished-state sweep.

That concentration is the point. None of those paths reads `Notification.ruleId` — they look
innocent of any 1:1 assumption — but every one of them carried it through
`NotificationRuleState.notificationId`, which had been a private pointer from one state row to one
alert since the day it was added. Any single one of them clearing an alert on behalf of one port
would have ended it for the other seven.

The vanished-state sweep needed one thing more than the release: its Event vocabulary. Under
grouping most departures are not clears, so it logs `notification.member_left` when others are
still firing, instead of an audit trail that says "Cleared" about an alert still on screen.

### Timed resets time the ALERT

`reset.mode: "timed"` measured `now - st.firedAt`, per state row. Contributions join on different
ticks, so each would have expired on its own clock — the alert shrinking port by port, each
departure mailing its own reset, the last one finally ending an alert whose components had been
leaving for an hour. A grouped alert is timed from `Notification.triggeredAt`, which is the only
clock that means "this alert has been up for an hour", which is what the operator set.

### The two decisions that were the operator's, not ours

**A later contribution sends one more message.** Contributions arriving in the same tick are free
(they are the same fire); one arriving later updates the alert and sends once, naming the whole
set, with `[UPDATED · n]` on the subject where nobody wrote a template — the COUNT, because
"another port faulted" is noise and "now 9 ports" is a spreading fault. The accepted cost is
stated plainly: ports failing one per tick over eight ticks produce eight messages over eight
minutes. That is no worse than the eight at once it replaces, the common case is one, and each
contribution's own hold already staggers them.

**An update says what changed** (2026-10-02). The count alone was not enough: a port that
recovers and faults again inside one alert leaves the count where it was, and prod's PoE-fault
automation mailed `[UPDATED · 2]` three times in three hours, each byte-identical to the first send.
`classifyGroupChanges` (read BEFORE `mergeMembers`, which clears the `leftAt` that marks a return)
sorts each joining contribution into joined / returned, and `describeGroupChanges` turns that into
the `{alert.change}` sentence and the subject tag (`[UPDATED · 2 · port7 back]`). The sentence is
applied to a COPY of the context in `drainPendingSends`, never to the stored `templateCtx`, so a
reminder replaying that snapshot does not repeat an old update as news. A rejoin still sends — the
decision above stands; only its content changed.

**A later contribution re-opens an acknowledgement.** Acknowledging "3 ports faulted" is not
acknowledging "now 9 ports", so the ack columns are cleared and `escalationState` is reset, which
restarts the reminder and escalation clocks — the point of re-opening. Nothing is lost: the
`notification.reopened` Event names the prior acknowledger and their note, which is where the
audit trail for this has always lived.

### Severity, and the flapping port

The alert carries the **max** of its ACTIVE contributions' severities. A band change therefore
belongs to one contribution and is folded (`reconcileGroupSeverity`): the member's own
`firingSeverity` and `bandMetSince` are written per state row exactly as before, and the ALERT is
rewritten, re-notified and its `escalationState.bandSince` re-stamped only when the GROUP's
severity actually moved. Without that split one port oscillating between two bands would restart
the paging clock for the other seven, every time it moved.

### Two things that are not optional

**`Notification.dimension` stays a single key** — the primary contribution, worst severity then a
natural sort so port2 precedes port10. Seven readers treat it as one string (`alertChartService`,
`alertInterfaceService`, `nocDashboardService` and its dimension sort, `alert-ack-view.js`,
`assets.js`, `mobile/alerts.js`, `widgets/activeAlerts.js`). Making it a list would have been a
one-line change with seven silent consequences. The full set lives in `members`; `dimensionCount`
is denormalized beside it so the list surfaces can render "+7" without pulling the blob into a
query that narrows with an explicit `select`.

Because it is only the primary, the Active Alerts widget does NOT print `dimension` beside the
hostname on a grouped alert — `groupName` set (an Alert Group) OR `dimensionCount` non-null (an
automation's own `groupByAsset` fold, which has no group name): "port39" there read as the whole
alert while the message beneath listed every faulted port. The row wears a GROUP pill after its
title instead (tooltip: group name or "Grouped by device", + the component count), and an ungrouped
alert keeps its dimension, which is what
tells two rows of one per-interface automation apart.

**`groupByAsset` is a first-class column and never a key inside `trigger`.**
`triggerIdentityOf` / `triggerSignature` are computed from the trigger and feed the carve-out
shadow index, so a flag hidden in there would stop a grouped automation shadowing its ungrouped
sibling and quietly break business rule 46 — two alerts where the operator had arranged for one.
There is a unit test whose only job is to assert the flag is not in the trigger.

### Opt-in, and what turning it on costs

Off by default, per automation, and refused (`validateGrouping`) on anything that does not report
per component — a composite already fires once per device, a host metric has no device, and an
event automation writes no state row for the "last contribution?" count to see. The refusal names
WHY, because "invalid" tells an operator nothing about which of their choices to change.

Turning it on or off retires the rule's live alerts as `system:rule-regrouped` so the next tick
re-raises them in the new shape. Doing nothing was not an option: the firing branch is a no-op for
a steadily-firing condition, so an operator ticking the box mid-storm would have seen no change
until every port recovered.

Two things change for an operator who ticks it, and both belong in the release note rather than
being discovered: **`{dimension}` starts rendering a list**, and **one acknowledgement now covers
every affected component** — with the alert staying up until the last one recovers.

### Concurrency

Settled in the database, not in the engine. The partial unique index
`notifications_group_key_live` (`groupKey IS NOT NULL AND cleared = false`) refuses a second live
alert per group key whatever raced — an overlapping tick, a retried job — and the P2002 catch
re-reads and joins, so a losing tick still lands its contributions instead of throwing them away.
Prisma cannot express a partial unique index, so it lives in the migration SQL alone and a schema
diff will report it as drift forever; that is expected, and "fixing" the drift removes the only
thing standing between two ticks and two alerts for one device.

A JOIN that finds the alert already cleared falls through to CREATE. That is not an edge case: it
is what happens the first time anyone clicks Clear on a grouped alert, because
`clearNotifications` deliberately does not release the state rows.

### The second half: folding across automations

Folding one automation's components answers the PoE storm. It does not answer the other half of
the same complaint: the switch that has a PoE fault AND a chassis temperature alarm AND a dead
uplink is one incident to whoever is holding the pager, and three automations watching it means
three more alerts.

An **AlertGroup** is an operator-named set of automations whose alerts about one device fold into
a single alert. It is opt-in, it is built on exactly the machinery above, and the only structural
addition is one indirection.

### The split, and why the alternatives were rejected

**A group owns DELIVERY. Its members own DETECTION.** Member automations keep their trigger,
scope, holds, severity bands and reset; the group carries the one set of notify actions, the one
escalation chain, the one reminder cadence and the one acknowledge-note policy. While an
automation is in a group it stops delivering on its own.

That is not a preference. Escalation tiers and reminder cadence are per-automation, so an alert
raised by three of them has three answers to "when does this page someone?" and no way to choose
between them. Two alternatives were considered and both fail on exactly that:

- **The automation that fired FIRST owns delivery.** Cheapest to build — the group is only a
  label — but the owner is then decided by timing, so the same fault reaches different people
  depending on which check happened to notice first.
- **Union the recipients on one message.** Answers the To line, and nothing else: escalation and
  reminder cadence are exactly as ambiguous as before, and the recipient list changes shape
  mid-alert as contributions arrive.

The columns a group carries are precisely the ones re-read LONG after the alert exists, resolved
by id: `actions` (the repeat pass re-runs notify actions), `escalation`, `repeat`,
`emailComposition`, `resetActions`, `requireAckNote`. `messageTemplate` and `bandNotify` stay on
the member automation because they are consumed once at fire and frozen into the `Notification`
row. A group has no `severity` at all — a grouped alert sits at the max of its active
contributions, each resolved by its own automation's bands.

### One indirection, rule-shaped on purpose

`alertOwnerOf(notification)` answers the group when there is one, else the automation. It returns
a **rule-shaped** object deliberately: `effectiveAckNoteForSeverity`, `escalationChainsForSeverity`,
`allEscalationsOf` and `allRepeatsOf` all take a rule-ish thing, and handing them one keeps the
grouped path on the same code as the ungrouped path instead of growing a parallel set that can
drift. `kind` exists only for the surfaces that must SAY which it was.

Every delivery-time policy read goes through it: the ack-note gate on all four acknowledge
surfaces, the escalation sweep (whose candidate set widens to
`ruleId IN (...) OR alertGroupId IN (...)`), `runResetActionsForCleared`, and
`getNotificationForViewer`. A **disabled** group owns nothing — its members go back to delivering
on their own, so an alert that outlives the switch-off falls back to its automation rather than
silently losing its escalation.

**The engine's own sends go through it too** (fixed 2026-09-30 — for the first twelve days
the fire path did not). `fire()` buffers each contribution with its MEMBER's actions, and
`drainPendingSends` used to send exactly those, with the member's `emailComposition`: the
group's recipients never heard about a new alert, only about its reminders and escalations,
and a member with no notify action of its own — the normal shape inside a group, and exactly
the case the delete-confirm dialog warns about — sent nothing at all. Found in review, not in
use. Now every send the engine makes on the alert's behalf resolves the owner from the ALERT
(`groupOwnersOf`, keyed on the stamped `alertGroupId`, so a device outside the group's scope and
a disabled group both fall back to the member): the first fire and every growth (one lookup
per drain pass), `reconcileGroupSeverity`'s re-notify, `fireResolved` in `reuse` mode and
`fireReset`. The member's band policy still decides WHETHER a severity change or a "Resolved"
is sent — `bandNotify` stays on the member — and `dedicated` resolved actions stay the member's,
since the operator wrote them for exactly that send. A grouped automation also always snapshots
`templateCtx` and loads `{asset.*}` detail (`groupWantsContext` / `groupWantsAssetDetail`),
because the group may escalate, remind or compose where its member would not. Pinned by
`tests/integration/alertGroupDelivery.test.ts`.

Fixing that exposed the other half of the same gap. The Groups tab has no recipient editor — its
hint promised that recipients are "seeded from the first automation you add", and nothing did
the seeding. While members still delivered on their own, nobody could tell; once the group
really owned delivery, a group created in the UI owned it and delivered to nobody. So a save
that sets membership, posts no `actions`, and finds the group with none of its own now copies
the first such member's actions, escalation chain, email layout and reset actions into it —
once, into unset fields only (`alertGroupService → seedDeliveryFromMembers`). Copying rather than
reading through to the member live was deliberate: a group whose recipients silently changed
whenever someone edited one of its automations would be a group that does not own delivery at
all.

### The alert keeps a primary ruleId, and that is load-bearing

It would be tidier for a group-owned alert to carry a null `ruleId`. It would also be six
regressions. A null-ruleId alert is un-escalatable (`ruleId: { in: [...] }` never matches NULL in
Prisma), un-sweepable, invisible to every relevance-filtered NOC severity pill
(`triggerMatchesRelevance` reads `rule.trigger`), nameless in the Active Alerts widget and on the
acknowledge page, and permissive on the ack-note gate. So the alert keeps the OPENING
rule in `ruleId` and carries `alertGroupId` beside it — and PROVENANCE stays the automation's
throughout: `exec.ruleId`, the `POLARIS_RULE` handed to a script, the audit details. Which
automation raised this is a different question from who is telling people about it, and grouping
only changes the second.

The one place that needed real work rather than an indirection is the NOC relevance filter. A
grouped alert may be raised by several automations, so "is this alert about the thing this widget
measures?" is answered by **any** contributing trigger — read off the alert's own `members`
snapshot, one query for the page. Without it, a switch's grouped alert vanishes from the
interfaces pill whenever its primary contribution happened to be a temperature condition: the
alert is still about a dead port, and the widget would have said the switch was fine.


### Which devices a group governs

A group without a device filter is relying on its members' scopes agreeing about which
devices matter, and they will not: "PoE fault" is written fleet-wide, "chassis temperature"
covers every FortiGate, and the operator wanted one alert for the switches at one site. So a
group carries a `scope` of its own — the automations' OWN schema, built with the same
condition tree, evaluated by the same `evaluateScopeCondition`.

**It narrows, it does not replace.** Detection stays the automation's (that is the whole
split this rule is built on); the group's scope says where the FOLD applies. On a device the
scope selects, a member's alerts join the group's single alert and the group delivers them.
On a device it does not select, that member keys on ITSELF and delivers alone — exactly as an
ungrouped automation would, because its own Devices step still said to watch that device.

That per-device test is the point. It is what lets "Switch health — Ashfield" and
"Switch health — Dock" be two groups over the same automations, paging different people,
rather than forcing a duplicate set of automations per site.

Two consequences that are easy to get wrong, and were:

- **`alertGroupId` is stamped only where the group governs.** An alert keyed `rule:`
  because the scope excluded its device must not still carry the group, or it would fold
  alone and page the group's recipients anyway — the half-applied version of the setting,
  and the one nobody would predict from the screen. Caught on real hardware: HUB2 fell out
  of scope, correctly split into two `rule:` alerts, and still read as delivered by
  "Lab gate health" until the stamp was gated too.
- **A scope CHANGE retires the group's live alerts** (`system:group-rescoped`), for the
  same reason joining and leaving do: it moves devices into and out of the group's
  governance, and an alert whose recipients and escalation chain swapped under a reader is
  worse than a brief retire-and-raise. Compared as JSON, not by identity — the editor posts
  a rebuilt tree on every save, so a reference check would retire everything on every save.

**Resolved through `loadScopeAssetIds`, not by matching rows in memory.** That is the
documented path, and the reason is `interfaceName`: it is relation-backed, resolved in SQL
by `scopeInterfaceIndex`, and an undecorated row silently reads as "no interfaces". Cached
per GROUP per tick, so five member automations resolve it once between them.

A FAILED resolve falls back to **governing everything** and records an Event saying so. The
opposite default would be worse in a way that reads as the feature breaking: one folded
alert would scatter back into one per component per automation, at exactly the moment
something is already wrong.

NULL or `{allAssets:true}` means every device its members cover — what a group had before
the column, so nothing is backfilled and no existing group changes.

**On the client** the tree is the shared `PolarisConditionBuilder`, fed by a new shared
`PolarisScopeVocabulary` module. That module exists because the Alert Groups editor would
otherwise have been the SIXTH copy of the `optionsFrom` value-suggestion switch, and every
copy ends `default: return []` — so a newly added field degrades to a free-text box on
whichever surfaces were not updated, silently. Alert Groups sits behind
`automationManagement`, the same gate as the wizard's Devices step, and wants the same
fields from the same endpoints, so the two now share one vocabulary and the wizard delegates
to it. The other three consumers deliberately stay separate: each is behind a different
permission key with its own schema route, which is what those routes exist for.
### Membership

At most ONE group per automation, because a fire must have a single alert to join.

Eligible: `asset_metric`, `asset_state` and **`composite`**. The composite case is why
`triggerCanJoinGroup` is wider than `triggerIsPerDimension` — a composite already fires once per
device at dimensionKey "", which is redundant as a self-fold (the checkbox refuses it) and is
exactly one good whole-device contribution to a group. "Switch health" wanting one beside a
PoE-fault automation is the obvious case, not an exotic one.

Refused: `host_metric` (no device to group by), and `event` / `change` — **structurally**, not
cautiously. The event tail writes no `NotificationRuleState` row at all, so there would be nothing
for the "was that the last contribution?" count to see, and the alert could never learn that the
event's part in it had ended. Revisit only with a state row for them. The picker returns the
refusals rather than filtering the rows out: an operator hunting for "Agent disconnected" and not
finding it would reasonably conclude the list was broken.

Membership IMPLIES the per-component fold. An operator who put an automation in a group and still
got eight alerts per switch would call that broken, and would be right.

### Keys, and the cross-rule lookup

`alertScopeOf` keys a member's alerts on the GROUP (`grp:<groupId>|<assetId>`) rather than on
itself, which is what makes every member fold into the same alert per device. It also means
joining or leaving CHANGES the key, so the old episode's alert and the new one cannot fight over
the same row in the partial unique index.

The lookup could no longer be free. A rule folding its own components finds its alert in the state
rows it has already loaded — a contribution and its alert are always the same automation's — but a
group's alert may have been opened by a different member entirely, whose state rows this rule's
pass never sees. So there is a TICK-scoped index of live alerts by `groupKey`: one query bounded
by live alerts rather than fleet size, loaded lazily so an install with no groups never issues it,
and updated in memory as alerts are created so a later member joins rather than racing the index.

### Nothing changes owner mid-life

Joining, leaving, disabling a group and deleting one all RETIRE the affected live alerts
(`system:rule-regrouped`, `system:group-disabled`, `system:group-deleted`) and release their state
rows, so the next tick re-raises them under whoever owns them now. An alert whose recipients,
template and escalation chain swapped under a reader would be worse than a brief retire-and-raise,
and the same reasoning already governs editing a trigger.

Deleting a group does NOT delete its automations (`SetNull` on both sides) — they go back to
delivering on their own. The confirm dialog says what that costs, including the case that is
otherwise invisible: a member with no notify action of its own was relying on the group to do the
telling, and would go silent without saying so.

### Rule 75 — the invariant as stated in full until 2026-09-30

Moved here verbatim when this branch caught up with the 2026-09-22 restructure and the invariant in `invariants-30-43.md` was cut back to the contract shape.

**An alert may name many problems on one device, and it ends only when the last of them does** — a CONTRIBUTION is `(automation, component)` on an asset. When an automation sets `groupByAsset` (a first-class column on `NotificationRule`, valid only on a per-dimension asset trigger — `validateGrouping` refuses it anywhere else, and `ruleGroupsByAsset` is the one gate the engine branches on), its per-component alerts consolidate into ONE `Notification` per device. **The state machine is unchanged**: `NotificationRuleState` stays keyed `(ruleId, assetId, dimensionKey)` and every hold (`forPolls` / `forDurationSec`), severity band, hysteresis dead band, poll-count run and pin gate still runs per contribution — only the notification row is shared, so many firing state rows point at one of them. Two sources of truth and the direction between them is load-bearing: **the state rows are the LIVE truth** ("was that the last contribution?" is a `count` over them, never a read of the snapshot — `releaseGroupMember` / `stillFiringElsewhere`, and note the WHERE carries no `ruleId`), while **`Notification.members` is a RENDER snapshot** (`AlertMember[]` — key, label, ruleId, severity, joinedAt, leftAt) existing only because the email renders at delivery time and the alert page renders after the clear. `Notification.dimension` stays a SINGLE key — the PRIMARY contribution, worst severity then natural sort — because seven readers treat it as one string (`alertChartService`, `alertInterfaceService`, `nocDashboardService`, `alert-ack-view.js`, `assets.js`, `mobile/alerts.js`, `widgets/activeAlerts.js`); `dimensionCount` is denormalized beside it so the list surfaces can render "+7" without pulling the blob. **Fires are BUFFERED, not written per reading** (`fire()` pushes into a `GroupBuffer` and returns; `flushGroupFires` writes after the readings loop and before the custom-reset pass, which re-reads firing rows from the database): a read-modify-write per reading would be eight reads, eight updates and eight sends on precisely the tick the feature exists to quieten, so the eight ports a failing PSU faults become **one create, one send, by construction** — nothing is suppressed after the fact, the second send is never created. Sends drain ONCE per tick (`pendingSends`, drained in `evaluateAllNotificationRules` after every rule), so contributions arriving together produce one message however many there are. A contribution arriving LATER joins the live alert, updates its list/count/severity/message and sends **one** more message naming the whole set — and **re-opens an acknowledgement** (`acknowledged` cleared, `escalationState` reset so reminder and escalation clocks restart, a `notification.reopened` Event naming the prior acknowledger and their note): acknowledging "3 ports faulted" is not acknowledging "now 9 ports". The alert carries the **max** of its ACTIVE contributions' severities (`groupSeverity`), so a band change on one contribution rewrites and re-notifies the alert only when the GROUP's severity moved (`reconcileGroupSeverity`) — one flapping port must not restart the paging clock for the other seven — and `firingSeverity` / `bandMetSince` stay per state row, untouched. **A MIDDLE contribution recovering ends nothing**: `recover()` asks `releaseGroupMember` first and returns before `fireReset` / `fireResolved` / the clear, or the first of eight ports to come back mails the alert's "Resolved" while seven are still faulted (`fireResolved` carries the same guard internally, for its four call sites). `clearActiveNotification` is the ONE chokepoint every clear path goes through — auto-recovery, both timed sweeps, the carve-out handoff, the device-down handoff, the vanished-state sweep — which matters because none of those read `Notification.ruleId` but every one carried the same 1:1 assumption through `NotificationRuleState.notificationId`; the vanished sweep additionally logs `notification.member_left` rather than "Cleared" when others are still firing, since under grouping most departures are not clears. A **timed** reset times the ALERT (`Notification.triggeredAt`), never each contribution's own `firedAt`, or the first-joined port expires the alert from under the later ones. `{dimension}` renders the capped list (`GROUP_LABEL_CAP`), with `{dimension.count}` / `{dimension.first}` / `{dimension.list}` as the ways back to its parts — all three set on every alert, so an ungrouped one describes its single component and a template is never broken by the automation not being grouped. Concurrency is settled by the partial unique index `notifications_group_key_live` (`groupKey IS NOT NULL AND cleared = false`, migration SQL only — Prisma cannot express it, so the drift report is expected and must not be "fixed"), with a P2002 catch that re-reads and joins; a JOIN finding the alert cleared falls through to CREATE, which is not an edge case but the first time anyone clicks Clear, since `clearNotifications` deliberately does not release state rows. **Off by default and opted into per automation** — turning it on or off retires the rule's live alerts (`system:rule-regrouped`) so the next tick re-raises them in the new shape, and `groupByAsset` is deliberately NOT part of `triggerIdentityOf` / `triggerSignature`, or a grouped rule would stop shadowing its ungrouped sibling in the carve-out index (business rule 46). → [narrative-75.md#rule-75](narrative-75.md#rule-75) **THE SECOND HALF — ALERT GROUPS.** An `AlertGroup` is an operator-named set of automations whose alerts about ONE device fold into a single alert. It owns **DELIVERY ALONE** — notify actions, escalation chain, reminder cadence, acknowledge-note policy, `emailComposition`, `resetActions` — while its members own **DETECTION ALONE** (trigger, scope, holds, bands, reset) and stop delivering on their own while grouped. That split is the only one with a coherent answer: escalation tiers and reminder cadence are per-automation, so an alert raised by three of them otherwise has three answers to "when does this page someone?"; letting the automation that fired FIRST own delivery makes the recipients depend on which check noticed first, and unioning the recipients answers the To line while leaving escalation as ambiguous as before. The columns a group carries are exactly the ones re-read LONG after the alert exists; `messageTemplate` and `bandNotify` stay on the member because they are consumed once at fire and frozen into the row, and a group has NO `severity` because a grouped alert sits at the max of its contributions. **`alertOwnerOf` is the one indirection** (rule-shaped on purpose, so `effectiveAckNoteForSeverity` / `escalationChainsForSeverity` / `allRepeatsOf` keep working unchanged rather than growing a parallel set that drifts) and every delivery-time policy read goes through it: the ack-note gate, the escalation sweep (whose candidate set widens to `ruleId IN (...) OR alertGroupId IN (...)`), `runResetActionsForCleared`, `getNotificationForViewer`. A **DISABLED** group owns nothing — its members go back to delivering on their own, so an alert outliving the switch-off falls back to the rule rather than losing its escalation. **`Notification.ruleId` stays set to the automation that OPENED the alert** — deliberately NOT the worst contribution, which `dimension` and the message follow and which changes as severities move; provenance that moved mid-life would be worse than provenance that is merely the first cause: a null-ruleId alert is un-escalatable (`ruleId IN` never matches NULL), un-sweepable, invisible to the NOC's relevance-filtered pills, nameless in the Active Alerts widget and permissive on the ack-note gate — six regressions for nothing. Provenance (`exec.ruleId`, `POLARIS_RULE`, script runs) stays the AUTOMATION's even when the group supplied the actions. Membership: **at most one group per automation** (a fire must have a single alert to join), `asset_metric` / `asset_state` / `composite` only — a composite is the natural whole-device contribution, which is why `triggerCanJoinGroup` is WIDER than `triggerIsPerDimension` by exactly that case — and `host_metric` / `event` / `change` are refused, the last two STRUCTURALLY: the event tail writes no state row, so nothing could ever tell the alert their part in it had ended. Membership IMPLIES the per-component fold. **A group may carry a `scope` of its own** — the automations' OWN scope schema, built with the same condition tree and evaluated by the same `evaluateScopeCondition` — which NARROWS where the fold applies without touching what any member watches: on a device the scope selects, a member's alerts join the group's one alert and the group delivers them; on a device it does not, that member keys on ITSELF and delivers alone, exactly as an ungrouped automation would. That per-device test is what lets one set of automations serve several groups routed to different people. `alertGroupId` is stamped on the alert ONLY where the group governs — an alert keyed `rule:` that still carried the group would fold alone and page the group anyway, the half-applied version of the setting. Resolved once per group per tick through `loadScopeAssetIds` (the path that decorates relation-backed leaves; matching rows in memory would read `interfaceName` as "no interfaces"), and a FAILED resolve falls back to governing everything and says so as an Event — the opposite failure would scatter one folded alert back into one per component. A scope CHANGE retires the group's live alerts (`system:group-rescoped`) for the same reason joining does. NULL / `allAssets` = every device its members cover, which is what every group had before the column. `alertScopeOf` keys a member's alerts on the GROUP (`grp:<id>|<assetId>`), so joining or leaving CHANGES the key and the two episodes cannot collide; the cross-rule lookup is a TICK-scoped index of live alerts by `groupKey` (one query bounded by live alerts, loaded lazily so an install with no groups never issues it) because a member's alert may have been opened by a different automation entirely. Joining, leaving, disabling and deleting all RETIRE the affected live alerts (`system:rule-regrouped` / `system:group-disabled` / `system:group-deleted`) so the next tick re-raises them under whoever owns them now — an alert cannot change owner mid-life. The NOC relevance filter matches when **ANY** contributing trigger does, or a switch's grouped alert vanishes from the interfaces pill whenever its primary contribution happened to be a temperature condition.
