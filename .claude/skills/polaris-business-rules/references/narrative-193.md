## Rule 193 — A group may wait for a share of its fold to be failing before it raises anything

**The ask (2026-11-18).** "For group alerts, I want to set a percent threshold, so that alerts don't happen unless a percent of something is having issues. So if I have 87 things doing the same path monitor, I can say 100% or 80% of them have to fail before an alert is generated." One host losing a path is that host's problem; the alert the operator wants is "the path is broken", which only shows when most of the hosts running the check see it.

**Decisions (asked, answered 2026-11-18).**
- Below the threshold there is **no alert at all** — not a visible alert with its email held. Polaris keeps evaluating; the alert opens the tick the share is reached.
- Once raised, the alert ends **when the last member recovers** (rule 75 and 75(a)), not when the share drops under the line — no raise / resolve / raise flapping around the threshold, and no second "reset below" percent to configure.
- The denominator is the **hosts reporting results**, not every assigned host: with 5 of 87 agents offline, 100 % must still be reachable.
- It applies to **every multi-device fold** — per automation (and its per-path-check split), device + automation (the whole group), per subnet. A per-device fold folds one device's own components, so "percent of devices" means nothing there and the value is dropped.

**How.** The fold already sorts each tick's fires into buckets by groupKey (`foldBuckets`). The placement was lifted into `placeContribution` so a second caller could place EVERY reading the same way: `recordFoldReporting`, called by both evaluators just before their flush, counts each device the automation read under the alert it would join (`TickAlertIndex.reporting`). For a path check that is "a sample within the automation's lookback", which is what an offline agent stops producing — the Stale rule (85(a)) by another route, without a second query. Devices in maintenance produce no live reading and are in neither count.

Where `flushGroupFires` would have created an alert for a governed multi-device bucket, `deferForFailingPercent` parks the bucket on the tick instead (`TickAlertIndex.deferred`). Nothing is written: `fire()` only buffers for a grouped rule, so the state row stays `clear` (or `pending` under a hold, whose run is already satisfied) and the contribution fires again on the next tick. That is what makes "no alert at all" free — no new state, no new column on `NotificationRuleState`.

The count has to wait for the END of the tick because a whole-group fold spans member automations evaluated one after another: rule A's flush cannot see rule B's failing devices. `releaseFailingPercentAlerts` runs after the rule loop and before the paced sends; for each held groupKey it unions the failing devices across entries, unions the reporting set with them (a failing device reported by definition), and on `failingPercentMet` opens the alert with the first entry's `createGroupAlert` and joins the rest — the path two members landing in one tick always took. The alert then takes rule 75's first-send hold like any other.

Only OPENING is gated. A live alert's joins go through `joinGroupAlert` as before, so a device failing after the alert is up joins it whatever the share. That is also why changing the percent retires nothing.

**Cost.** Nothing for a group without a threshold. With one, each tick places every reading of each member automation once (cached governance and subnet lookups, one `subnetsOf` query for a subnet fold) — linear in readings, no per-reading query — and the end-of-tick pass is in-memory until a threshold is met.

**Rejected.**
- Opening the alert and holding its sends while below — the operator chose "no alert", and a visible below-threshold alert would still escalate, page the NOC widgets and count in the Alerts list.
- Counting from the members snapshot or state rows — they hold only the failing side; the denominator needs the devices that were fine, which only the readings know.
- A per-rule percent — the group is what decides what ONE alert spans, so it is the only place "percent of that alert's devices" is defined.

Pinned by `tests/integration/alertGroupFailingPercent.test.ts` and the `effectiveMinFailingPercent` / `failingPercentMet` cases in `tests/unit/alertGroups.test.ts`.
