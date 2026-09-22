# Business rule 82 — full narrative

> Written 2026-09-22 as its own file rather than appended to `narrative-60-64.md`, which
> has been at the 1500-line reference-file ceiling since rules 78 and 80 were split out.
> Rule numbers are a stable citation key — never renumber.
>
> **81 is deliberately skipped.** It was published as the discovery stale-IP rule
> (`b48de573`) and reverted wholesale the same week; a reader who saw it would find this
> rule under a number they already associate with something else, and a citation key that
> means two things is worse than a gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 82](#rule-82) — A measurement of the host must not be dominated by the measurer, and a scheduling offset is not a way to protect one

<a id="rule-82"></a>

## Rule 82 — A measurement of the host must not be dominated by the measurer, and a scheduling offset is not a way to protect one

An operator watching an agent on a **single-vCPU VM** reported CPU that read far higher
than the host was doing, and named the cause correctly: the agent appeared to be running
its other collections while it took the reading.

The reading was `cpu.Percent(1*time.Second, true)` — block one second, report that
second, once a minute. On a host with cores to spare that is merely a noisy estimator of
a minute. On one core it is something worse, and the difference is worth stating
precisely, because it is the part that makes this a rule rather than a tuning note:

**The error is not noise, it is bias, and the bias is the measurer's own.** The sample
covered 1 second in 60, so anything the agent itself did inside that second entered the
chart magnified about sixtyfold, while the other fifty-nine went unmeasured. On one
vCPU the agent's own work *is* the whole core. A `processConnections` sweep or a
`tasklist /svc` still running when the window opened put the host at ~100% — a number
describing the agent's scheduling, not the machine's load. And it was not random: the
collectors that overrun are the same ones every minute, so the same hosts read high the
same way, forever, which is precisely what makes a biased estimator worse than a noisy
one. Nobody looking at the chart could tell.

### The offsets could not have fixed it, and this is the general lesson

Polaris had already been here. Business rule territory adjacent to this one — the loop
phase-offsets added in agent 0.19.0 (`cmd/polaris-agent/main.go` → `loopPhaseSec`) —
exists because every collection loop used to fire on the same instant and put a
five-minute sawtooth on both the CPU chart and the response-time chart. The obvious
reading of this new report is that the phase table needs another adjustment.

It does not, and it cannot:

> **A phase offset staggers when a pass STARTS. It says nothing about how long the pass
> runs.**

On the single-core hosts where this matters, every pass runs long — that is the same
property that makes the host worth worrying about. `processConnections` sits at phase 57
and telemetry's window opened at phase 8; the sweep only had to overrun by **11 seconds**
to land inside the thing being measured. No arrangement of a fourteen-entry table holds a
one-second hole open on a host whose passes overrun, and any arrangement that appears to
is one slow host away from not doing so.

So the window was **deleted, not moved**. `internal/collectors/cputimes.go` reads the
kernel's cumulative per-core counters each telemetry pass (`cpu.Times(true)` — `/proc/stat`
on Linux, `GetSystemTimes` on Windows, `host_statistics` on macOS) and reports the delta
since the previous pass. **The telemetry loop's cadence is the averaging window**, the
collector never blocks, and the agent's own work can only ever contribute its true share
of the interval — a few percent — because there is no longer a small window for it to
dominate. Nothing is sampled away either: every second of the minute is inside some
reading.

The general form, which is what a future change has to honour: **never put a
timing-sensitive measurement behind a scheduling offset.** If a measurement needs the
process to be quiet, the measurement is wrong, because the process cannot promise to be
quiet. Measure the span instead of an instant inside it.

### Three things this gets wrong by default

**Not `cpu.Percent(0, …)`, despite it having exactly this semantic.** gopsutil offers
delta-since-last-call and it is tempting to simply pass 0. Its last-call state is a
**package global shared by every caller in the process**: a second collector calling
`Percent` for its own purposes would consume this one's baseline and silently shrink the
window to the gap between the two calls — the original bug, restored, in a form no test
against `cputimes.go` would ever see because nothing in that file changed. The baseline
is ours, in `cpuSampler`, and the arithmetic (gopsutil's own `getAllBusy` /
`calculateBusy`, idle and iowait excluded, Linux guest time not double-counted because
the kernel already folds it into user) is reproduced locally so the percentage keeps
exactly the meaning it had.

**The aggregate is the summed-delta ratio, not the mean of the per-core vector.** The two
agree whenever every core's counters advanced by the same amount, which is the ordinary
case and why the difference is easy to miss. They diverge when a core was parked for part
of the span, and the summed form is the one that still means "this host's CPU" there. It
also keeps its meaning when the per-core vector is truncated at `maxReportedCores` (512),
since it never looked at the vector.

**Four conditions have no usable baseline** and fall back to one short (250 ms) blocking
read, each covered by `cputimes_test.go`: no previous reading at all, a changed
logical-core count (a hot-plugged or hot-unplugged vCPU, after which index *i* is not the
same core in both slices), counters that did not advance (two reads in one instant), and
counters that went **backwards** (a VM restored from a snapshot, a host resumed from
suspend). None is expected in normal operation — the package's `init()` primes the
baseline at process start, so even the first telemetry pass has one — and the fallback
deliberately does not restore the old one-second window.

### What this rule does not reach

**Per-pinned-program telemetry keeps its prime → sleep(300 ms) → read window**
(`internal/collectors/processtelemetry.go`), and that is not an oversight. A per-process
percentage is that process's own CPU time over elapsed wall time, so a collector holding
the core **depresses** other processes' readings rather than inflating them — the
opposite failure, and a far less misleading one. Carrying per-PID baselines across passes
is also not free the way a host-wide one is: the pinned set changes, PIDs come and go, and
a baseline for a PID that exited is a baseline for a different process.

### What operators see

The CPU chart is **flatter** than it was before agent 0.20.0, and **CPU thresholds fire on
a sustained average rather than on a lucky sample**. That is the correction, not a
regression: the spikes it removes were largely the agent measuring itself. An operator who
tuned a threshold against the old values should re-check it, and one who wants a sharper
chart on a particular host shortens `telemetry_interval_sec`, which shortens the averaging
window with it. Documented at `docs/wiki/Polaris-Agent.md` → "What the CPU number
measures".

**An installed agent keeps the old behaviour until it is upgraded**, so a fleet reads the
old way until it is rolled — the same caveat the 0.19.0 phase fix carries.
