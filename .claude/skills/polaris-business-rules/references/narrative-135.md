# Business rule 135 — full narrative

> Written 2026-10-27 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 135](#rule-135) — A path check can be put in maintenance: it stops running everywhere and its alerts freeze, the way an asset's do

<a id="rule-135"></a>

## Rule 135 — A path check can be put in maintenance: it stops running everywhere and its alerts freeze, the way an asset's do

### What happened

2026-10-27, from the operator: the Path Monitor needed the Assets page's Maintenance button, for
path checks, configurable over the API as well as from the page. The case is planned work on a
check's TARGET — an ERP upgrade, a web server's patch night — where every agent host and the server
report the site failing and page someone about downtime that was announced. Asset maintenance
cannot express it: the hosts running the check are healthy, and putting them in maintenance would
silence everything else they report.

### The decision

Operator choices, 2026-10-27: a check in maintenance **pauses its runs and silences its alerts**
(rule 16's shape, not a silence-only variant that keeps collecting), and it is gated on
**`maintenanceManagement`**, the asset key, through the one schedules API.

- **One schedule table, two kinds of target.** `MaintenanceSchedule.pathCheckIds` names checks; a
  schedule targets assets (criteria / `assetIds`) OR checks, never both — `normalizeInput` refuses
  the mix (400), and an id naming no check is a 400 rather than a schedule that pauses nothing. The
  recurrence shape, the server-local wall clock, `startNow`, the calendar and the CRUD routes are
  shared verbatim. `GET /maintenance-schedules?target=` narrows the list, and each Maintenance modal
  lists only its own kind.
- **Open window rows are the truth**, as for assets: `PathCheckMaintenanceWindow`, diffed by
  `reconcilePathCheckWindows` inside the same 30 s `reconcileMaintenance` tick (and inline on every
  schedule write). It runs before the asset diff, whose quiet-tick early return would otherwise
  skip it. Close reasons, operator release holding for the current occurrence, and a spent ad-hoc
  one-shot (one check, no criteria) deleting itself all follow the asset rules. A check enters on
  its first open row and exits on its last; each transition writes one `path_check.maintenance_entered`
  / `_exited` Event and nudges the agents that run it.
- **Pausing is real where a check runs.** `agentConfigChecks` leaves a held check out — after the
  `MAX_CHECKS_PER_AGENT` cap, so a window never lets an over-cap check run in its place — and both
  config ETags fold that list, so agents refetch. `serverCheckDefinitions` leaves it out of the
  server job. No asset status changes: a path check has none, and its hosts stay monitored.
- **The engine freezes, rule 16's way.** Every path-sample read goes through `pathCheckIdWhere`,
  which never includes a held check — so nothing fires, a composite or reset tree cannot read it,
  and samples from BEFORE the window cannot keep a windowed `pathFailurePct` reading the outage the
  window was declared for. A held check's firing rows are marked seen so the vanished-state sweep
  does not clear them while the host still reports its other checks; a pending row restarts its
  debounce. The escalation sweep pauses follow-ups on a path alert whose dimension (the check) is
  held — the server's own row included, which has no asset to be suppressed.
- **Leaving.** `POST /maintenance-schedules/path-checks/:id/release` ends it now (`endReason:
  "operator"`); deleting a check drops it from every schedule and deletes a schedule left naming none.

### What is deliberately left alone

- A live alert is not retired on entry and recovers on its own evidence once runs resume — the rule
  16 posture operators asked for on assets.
- A composite path automation's per-host alert is not frozen by name (it has no check dimension): it
  reads the held check as absent, like any check that stopped reporting.
- Charts show no maintenance band for a check yet; the Path Monitor list's Maintenance column and the
  Events trail are the record.

Pinned by `tests/unit/maintenanceScheduleService.test.ts` (the reconcile, release, states, delete),
`tests/unit/pathCheckService.test.ts` (agent and server definitions), `tests/unit/pathFailureRateCeiling.test.ts`
(no fire, frozen not vanished, pending reset), `tests/unit/pathChecksUi.test.ts` (row verbs, picker)
and `tests/integration/pathCheckMaintenance.test.ts` (the API end to end with a bearer token).
