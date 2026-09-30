package collectors

import (
	"math"
	"testing"

	"github.com/shirou/gopsutil/v3/cpu"
)

// times builds one cumulative reading. Only the fields the delta math reads
// are worth naming; everything else stays zero.
func times(name string, user, system, idle, iowait float64) cpu.TimesStat {
	return cpu.TimesStat{CPU: name, User: user, System: system, Idle: idle, Iowait: iowait}
}

func approx(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 0.001 {
		t.Errorf("%s = %v, want %v", label, got, want)
	}
}

// The plain case: one core, half the span busy.
func TestBusyPercentsSteadyLoad(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 10, 5, 85, 0)}
	cur := []cpu.TimesStat{times("cpu0", 35, 5, 145, 0)}
	// delta: user +25, idle +60 → 25 busy of 85 total ≈ 29.4%
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if len(per) != 1 {
		t.Fatalf("len(per) = %d, want 1", len(per))
	}
	approx(t, per[0], 25.0/85.0*100, "per[0]")
	approx(t, agg, 25.0/85.0*100, "aggregate")
}

// iowait is not busy — a host blocked on disk is not a host burning CPU, and
// gopsutil's own math excludes it. Pinned because moving it would silently
// change what every CPU threshold in the fleet fires on.
func TestBusyPercentsIowaitIsNotBusy(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 0, 0, 0, 0)}
	cur := []cpu.TimesStat{times("cpu0", 10, 0, 40, 50)}
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 10, "per[0]") // 10 busy of 100 total, NOT 60
	approx(t, agg, 10, "aggregate")
}

// On Linux the kernel counts guest time inside user already, so adding the
// guest fields to the total would inflate the denominator on any host running
// VMs. Every other platform reports guest as zero, so the same input must
// produce a different total only under the linux flag.
func TestBusyPercentsLinuxGuestNotDoubleCounted(t *testing.T) {
	prev := []cpu.TimesStat{{CPU: "cpu0"}}
	cur := []cpu.TimesStat{{CPU: "cpu0", User: 50, Idle: 50, Guest: 20}}

	linuxTotal, linuxBusy := cpuBusy(cur[0], true)
	approx(t, linuxTotal, 100, "linux total")  // guest folded into user
	approx(t, linuxBusy, 50, "linux busy")
	otherTotal, _ := cpuBusy(cur[0], false)
	approx(t, otherTotal, 120, "non-linux total")

	per, _, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 50, "per[0] on linux")
}

// The aggregate is the summed-delta ratio, not the mean of the per-core
// percentages. They agree when every core advanced equally; this fixes the
// case where they do not, because that is the one the choice was made for.
func TestBusyPercentsAggregateIsSummedNotMeaned(t *testing.T) {
	prev := []cpu.TimesStat{
		times("cpu0", 0, 0, 0, 0),
		times("cpu1", 0, 0, 0, 0),
	}
	cur := []cpu.TimesStat{
		times("cpu0", 100, 0, 0, 0), // 100 total, all busy  → 100%
		times("cpu1", 0, 0, 10, 0),  //  10 total, none busy →   0%
	}
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 100, "per[0]")
	approx(t, per[1], 0, "per[1]")
	// Mean of the vector would be 50; the summed form is 100/110.
	approx(t, agg, 100.0/110.0*100, "aggregate")
	if math.Abs(agg-50) < 1 {
		t.Error("aggregate looks like the mean of the per-core vector")
	}
}

// A core whose counters stood still (parked, offline) reports 0 rather than
// poisoning the reading — the cores that DID advance are still good.
func TestBusyPercentsParkedCoreReportsZero(t *testing.T) {
	prev := []cpu.TimesStat{
		times("cpu0", 0, 0, 0, 0),
		times("cpu1", 7, 0, 3, 0),
	}
	cur := []cpu.TimesStat{
		times("cpu0", 30, 0, 70, 0),
		times("cpu1", 7, 0, 3, 0), // frozen
	}
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 30, "per[0]")
	approx(t, per[1], 0, "per[1] (parked)")
	approx(t, agg, 30, "aggregate")
}

// Two reads in the same instant: no span, so no number. Publishing a ratio of
// two near-zero deltas would be noise dressed up as a measurement.
func TestBusyPercentsRejectsNonAdvancingCounters(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 10, 5, 85, 0)}
	cur := []cpu.TimesStat{times("cpu0", 10, 5, 85, 0)}
	if _, _, ok := busyPercents(prev, cur, true); ok {
		t.Error("ok = true, want false for counters that did not advance")
	}
}

// A VM restored from a snapshot or resumed from suspend can hand back
// counters SMALLER than the previous read. Every per-core delta is negative,
// the total is negative, and the whole reading has to be thrown away.
func TestBusyPercentsRejectsBackwardsCounters(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 500, 100, 900, 0)}
	cur := []cpu.TimesStat{times("cpu0", 10, 5, 85, 0)}
	if _, _, ok := busyPercents(prev, cur, true); ok {
		t.Error("ok = true, want false for counters that went backwards")
	}
}

// A hot-plugged or hot-unplugged vCPU changes the slice length, and index i
// stops meaning the same core in both reads. Nothing is comparable.
func TestBusyPercentsRejectsCoreCountChange(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 0, 0, 0, 0)}
	cur := []cpu.TimesStat{
		times("cpu0", 10, 0, 90, 0),
		times("cpu1", 10, 0, 90, 0),
	}
	if _, _, ok := busyPercents(prev, cur, true); ok {
		t.Error("ok = true, want false when the logical-core count changed")
	}
}

// No baseline at all (a prime that failed at process start) is the other
// route into the fallback.
func TestBusyPercentsRejectsEmptyBaseline(t *testing.T) {
	cur := []cpu.TimesStat{times("cpu0", 10, 0, 90, 0)}
	if _, _, ok := busyPercents(nil, cur, true); ok {
		t.Error("ok = true, want false with no previous reading")
	}
}

// Individual fields can move inconsistently across a counter reset, which can
// leave a busy delta larger than the total one. Clamp rather than emit 400%.
func TestBusyPercentsClampsAboveHundred(t *testing.T) {
	prev := []cpu.TimesStat{{CPU: "cpu0", Idle: 100}}
	cur := []cpu.TimesStat{{CPU: "cpu0", User: 60, Idle: 90}}
	// total delta +50, busy delta +60 → 120% before clamping
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 100, "per[0]")
	approx(t, agg, 100, "aggregate")
}

func TestClampPct(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{-0.1, 0},
		{0, 0},
		{42.5, 42.5},
		{100, 100},
		{100.1, 100},
		{math.NaN(), 0},
		{math.Inf(1), 0},
		{math.Inf(-1), 0},
	}
	for _, c := range cases {
		if got := clampPct(c.in); got != c.want {
			t.Errorf("clampPct(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestMeanPct(t *testing.T) {
	if got := meanPct(nil); got != 0 {
		t.Errorf("meanPct(nil) = %v, want 0", got)
	}
	approx(t, meanPct([]float64{0, 50, 100}), 50, "meanPct")
	approx(t, meanPct([]float64{25}), 25, "meanPct single")
}

// The whole point of the change: a burst of the agent's own work is diluted
// across the cadence instead of being the entire reading. One core, 2
// CPU-seconds of agent work inside a 60 s span reads as ~3.3% — under the old
// 1-second window the same burst read as 0% or 100% depending only on whether
// it landed inside the window.
func TestBusyPercentsDilutesAgentBurstOverTheCadence(t *testing.T) {
	prev := []cpu.TimesStat{times("cpu0", 0, 0, 0, 0)}
	cur := []cpu.TimesStat{times("cpu0", 2, 0, 58, 0)} // 2 busy of 60 s
	per, agg, ok := busyPercents(prev, cur, true)
	if !ok {
		t.Fatal("ok = false, want true")
	}
	approx(t, per[0], 2.0/60.0*100, "per[0]")
	approx(t, agg, 2.0/60.0*100, "aggregate")
	if agg > 5 {
		t.Errorf("aggregate = %v, want a burst diluted across the span", agg)
	}
}

// End to end against the real host: the sampler must return a plausible
// reading without blocking for a second, and must keep returning one on
// repeated calls (the second call runs on the baseline the first one stored).
func TestHostCPUPercentsReturnsPlausibleReading(t *testing.T) {
	per, agg, ok := hostCPUPercents()
	if !ok {
		t.Skip("host CPU counters unavailable in this environment")
	}
	if len(per) == 0 {
		t.Fatal("no per-core readings")
	}
	for i, v := range per {
		if v < 0 || v > 100 {
			t.Errorf("per[%d] = %v, outside [0,100]", i, v)
		}
	}
	if agg < 0 || agg > 100 {
		t.Errorf("aggregate = %v, outside [0,100]", agg)
	}

	// Called straight back, the counters have barely moved — the sampler
	// falls back to a short blocking window rather than returning garbage.
	per2, agg2, ok2 := hostCPUPercents()
	if !ok2 {
		t.Fatal("second call returned ok = false")
	}
	if len(per2) != len(per) {
		t.Errorf("core count changed between calls: %d then %d", len(per), len(per2))
	}
	if agg2 < 0 || agg2 > 100 {
		t.Errorf("second aggregate = %v, outside [0,100]", agg2)
	}
}
