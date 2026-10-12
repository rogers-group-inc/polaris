# Business rule 105 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 105](#rule-105) — A capacity severity change is recorded by one evaluator, and only once it has held

<a id="rule-105"></a>

## Rule 105 — A capacity severity change is recorded by one evaluator, and only once it has held

### What happened

On 2026-10-12 the operator reported that the baseline "Capacity severity escalated"
automation kept alerting on `capacity.severity_changed`, yet every time they opened
Server Settings → Maintenance the Database card read **All capacity checks passed**.
They asked whether these were blips, and then asked for the event to require the
condition to be true for some minutes before it is created.

Reading the code turned up two causes, and either one alone produces the report.

**Brief conditions alerted on a single reading.** `capacityService.ts →
recordCapacityTransition` wrote an Event the first time a snapshot's severity
differed from the stored `capacity.lastSeverity`. Several reasons are readings
rather than settings, and cross their line briefly: the share of dead rows on a
sample table rises until autovacuum runs and then falls (`autovacuum_lag`), the
disk-read average depends on the window since the last reading (`db_io_pressure`),
and the rollup and monitor-handler reasons follow job timing
(`sample_rollup_lagging`, `monitor_handler_timeout_pressure`). One reading over the
line was an escalation, and the next reading under it was a recovery.

**Three evaluators with different inputs wrote one stored severity.** The
`capacityWatch` job graded every 10 minutes with `pgTuningNeeded: false` and no
Capacity Advisor gaps. `GET /server-settings/pg-tuning`, called on every admin page
load by `public/js/app.js → checkCapacity`, graded with the real PostgreSQL tuning
check but no advisor gaps. `GET /server-settings/capacity-advisor`, the Maintenance
tab itself, graded with both. All three called `recordCapacityTransition` against
the same Setting. On a host where one of the inputs only some evaluators read was
true (`pg_tuning_needed`, `pool_undersized`, `monitor_workers_undersized`,
`max_connections_undersized`, `monitor_handler_timeout_pressure`), an admin loading
any page escalated the severity and the next job tick recovered it, with nothing
about the host having changed. Each pair was another alert.

### The decision

**One evaluator.** Only the `capacityWatch` job records a transition. Both routes
grade for display and write nothing, so a page load can neither start nor reset a
change. The job grades with the same inputs the Maintenance tab shows: the
PostgreSQL tuning check moved out of `serverSettings.ts` into
`services/pgTuningService.ts → computePgTuning` so the job can call it, and the job
uses `getCapacitySnapshotWithAdvisor`, the same two-pass grade `/capacity-advisor`
runs, so the advisor-gap reasons are in its verdict too. The extra cost is three
`count()` queries and one `pg_settings` read every 10 minutes. The advisor
recompute already ran on the tick, so it is not new work.

**A change must hold.** The stored row gains a `pending` change: its severity, when
the run of disagreeing readings began (`since`), and the latest of them (`lastAt`).
A reading that agrees with the recorded severity discards the pending change. A
reading that disagrees extends it, and once `since` is at least the hold
(`capacity.alertHold`, default 30 minutes) in the past, the latest severity is
recorded and the Event written, carrying `heldSec` and "(held N min)" in its
message. The hold is set on the Database card or by `PUT
/server-settings/capacity-alert-hold`, from 0 (the first reading, the behaviour
before this rule) to 1440 minutes, and changing it writes
`capacity.alert_hold_updated`.

The choices inside that, and why:

- **The readings in a run need not agree with each other.** Watch, then
  critical, then warning, against a recorded ok, is one run of "not ok", and the
  severity written when it matures is the latest. Keying the run on the pending
  severity was rejected: a host stepping between watch and warning would restart
  its hold on every step and never alert, though it was never once healthy.
- **The hold is symmetric.** A recovery waits too. A recovery written on a
  single good reading would let a host flapping at a threshold clear its alert on
  one reading and raise it again after another full hold, which is the same noise
  this rule removes, only at a slower rate. The cost is that the all-clear arrives
  one hold late.
- **A gap in the readings restarts the run.** If the previous disagreeing reading
  is more than 2.5 ticks old (`PENDING_STALE_GAP_MS`), nobody watched the
  condition in between: Polaris was stopped, or the job failed. The run starts
  again from the new reading rather than counting the gap as time held.
- **The first-ever reading is a baseline, recorded at once.** There is nothing for
  it to differ from. Its `direction: "initial"` is not what the baseline
  automation's `detailsMatch: { direction: "escalated" }` matches, so it never
  alerts.
- **The default is 30 minutes.** With a 10-minute tick that is four agreeing
  readings, first to last. That is long enough to absorb an autovacuum cycle, and
  short against the hours to weeks over which the conditions worth a page (a
  filling disk, a projection that will not fit) build up.

The Database card shows what the alerting side last recorded and any change it is
waiting out, since `GET /capacity-advisor` returns `capacityTransition` from
`getCapacityTransitionState`. A card reading Healthy beside an open alert now says
why on the same screen.

### What it does not change

The two verbs and their split at `ok` (business rule 32(e), pinned in
`tests/unit/capacityTransition.test.ts`) are unchanged: the hold decides *when* a
transition is written, never which action it is. The sidebar's critical-capacity
alert still comes from the live `/pg-tuning` grade on page load. It is a display,
not an Event, and a host that is critical right now should say so at once.
`platform.lifecycle_*` transitions already had one evaluator (the daily job) and
need no hold: a lifecycle condition is true for months.
