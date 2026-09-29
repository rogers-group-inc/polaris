# Business rule 89 — full narrative

> Written 2026-09-29 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 75 is claimed by an in-flight worktree (alert
> grouping); 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 89](#rule-89) — A per-core CPU alert names the cores and yields to the all-cores alert on the same device

<a id="rule-89"></a>

## Rule 89 — A per-core CPU alert names the cores and yields to the all-cores alert on the same device

### The case

The automation builder offered "CPU utilization" (`cpuPct`) and nothing finer, while the
Polaris Agent and vCenter had been reporting a per-core vector
(`AssetTelemetrySample.cpuCorePcts`) since 2026-09-18 for the asset CPU chart. The fault
an operator could see on that chart and could not alert on is the single-threaded one: a
runaway process pinning one core of a 16-core server reads as 6% on the all-cores average,
so no `cpuPct` threshold catches it without also paging on every ordinary busy hour. The
operator asked for a condition that fires when one or more cores run hot, whose
notification says WHICH cores and lists the top five CPU processes, and which gives way
to the regular CPU alert when the whole device is busy.

### What was built

**`cpuCorePct` — "Highest CPU core utilization"** is an ordinary asset metric. Each
sample's reading is its hottest core (`utils/cpuCores.ts → hottestCorePct`), so the
aggregation, the window, the poll-counted hold (rule 19), severity bands and hysteresis all
work unchanged: "sustained for 3 polls" means three samples in each of which SOME core was
over the line. That is deliberate — a scheduler moves a hot thread between cores, and a
per-core hold would restart every time it moved.

**One alert per device, not one per core.** The dimension key is `""`. A 64-core host with
three hot cores raises one alert, not three, and the reset, acknowledge and escalation
machinery sees one thing. Which cores are hot is the reading's LABEL, computed by
`notificationEngine → labelHotCores`: each core is reduced over the same samples the
reading was (the same aggregation, the last N for a count window, the newest for `latest`)
and named when that value meets the base threshold (`coresOver`). When no single core
meets it — the per-sample hottest core can clear the line while no one core's average does
— the hottest core is named, so the alert never names nothing. The label renders into the
message (`[Core 3 (97%), Core 7 (93%)]`), the trigger sentence and the email's component
row, which `METRIC_COMPONENT_NOUNS` captions "CPU cores" (the metric deliberately has no
`METRIC_DIMENSIONS` entry: that would give it a dimension space and a filter input).

**The same email a CPU alert gets.** `processRankingForMetric` ranks the `{processes.top}`
table by CPU, and `isResourceScopedAlert` keeps the CPU and memory charts and drops the
connectivity graphs — the two things rule-of-thumb debugging of a hot core needs first.

**Only devices that report cores.** SNMP, FortiOS REST, WinRM and SSH leave
`cpuCorePcts` null, and the resolver reads only rows that carry a vector, so such a device
has NO reading rather than a zero. An automation on it simply never fires; it does not
pretend the device is idle.

### Why the all-cores alert wins, and how

Every core is hot when the device is hot. Without a handoff, a busy server would raise the
regular "High CPU utilization" alert AND a per-core alert listing all its cores — two
alerts, two emails and two acknowledgements for one fact. The operator asked for the
per-core alert to be superseded, and the all-cores alert is the right survivor: it is the
broader statement, it is what the baseline automation raises, and it already carries the
same process table.

Rule 18's carve-out cannot express this. It compares automations that watch the SAME
thing (`triggerSignature`), and `am:cpuPct:` and `am:cpuCorePct:` are different signatures
on purpose — merging them would let a hostname-scoped per-core rule carve the baseline CPU
alert out of that host, the opposite of what was asked. And a static "a `cpuPct` rule
covers this device" test would silence the per-core rule everywhere, since the baseline CPU
automation covers every device: the per-core alert would never fire at all.

So the handoff is keyed on a LIVE alert, not on coverage: while the device carries an
uncleared, non-test alert raised on the `cpuPct` asset metric
(`notificationEngine → assetsWithLiveAllCoresCpuAlert`), a per-core rule evaluates no
reading for it, clears any alert it had raised with reason `system:superseded`, resets its
pending hold, and writes `notification.superseded` with `details.reason = "all-cores-cpu"`.
Acknowledged still counts — acknowledging does not end an alert. When the all-cores alert
clears, the per-core rule is free again on the next tick; if a core is still hot it fires
fresh, which is correct: the device has gone from "busy" to "one core busy".

**Tick order** (`evaluationOrder`) evaluates per-core rules after every other rule, so a
device that crosses both lines in the same tick gets the all-cores alert and never a
one-tick per-core alert beside it.

### Rejected alternatives

- **One alert per core** (dimension key = core index). Faithful to the data, useless to the
  reader: a pegged 32-core host would page 32 times, and a thread hopping cores would
  retire one alert and raise another every poll.
- **Reading = the highest per-core AVERAGE** (max over cores of each core's mean). It
  answers "is one core sustained high" more literally, but it has no per-sample series, so
  the poll-counted hold (rule 19) could not be counted off it, and a migrating hot thread
  would never read high at all.
- **Supersede by coverage (rule 18 style).** Described above: it would silence the
  per-core rule wherever the baseline CPU automation runs, which is everywhere.
- **Suppress per-core while the all-cores VALUE is high, alert or not.** It would make one
  automation's behaviour depend on another automation's threshold without either saying
  so; the live alert is the thing both the operator and the engine can see.

### Scope notes

A per-core condition inside a multi-condition (composite) automation is NOT handed off —
a composite has no single metric to supersede, and the author of a tree chose its
conditions together. The asset Alerts tab's "can trigger" list is a coverage question and
still lists a per-core automation beside the CPU one: whether it will speak depends on a
live alert, which that list does not model.

Pinned by `tests/unit/cpuCores.test.ts` and `tests/integration/cpuCoreAlert.test.ts`.
