// cputimes.go — host CPU% measured across the WHOLE cadence, not a 1 s slice
// of it.
//
// The reading used to be `cpu.Percent(1*time.Second, true)`: block for one
// second, report that second. On a host with spare cores that is merely
// noisy. On a single-vCPU VM it is wrong in a specific, repeatable way — the
// agent measured 1 second out of every 60, so anything the AGENT ITSELF was
// doing inside that second landed in the chart magnified ~60x, and on one
// core the agent's own work is the whole core. A `processConnections` sweep
// or a `tasklist /svc` that overran its slot and was still running when the
// window opened put the host at 100% for a sample that described the agent's
// scheduling rather than the host's load.
//
// The loop phases in main.go (0.19.0) keep collectors off telemetry's slot on
// a host where every pass is short. They cannot help on a host where a pass
// that started 11 seconds earlier is STILL RUNNING — which is exactly the
// single-core VM they would need to help on. Phases stagger when a pass
// starts; they say nothing about how long it takes.
//
// So there is no window any more. Each pass reads the kernel's CUMULATIVE
// per-core counters (/proc/stat on Linux, GetSystemTimes on Windows,
// host_statistics on macOS) and reports the delta since the previous pass.
// The measured span is the entire cadence, so the agent's own work can only
// ever contribute its true share of the minute — a few percent — instead of
// the entire reading on the ticks where it happens to collide. Nothing
// blocks, and no part of the minute goes unmeasured.
//
// The arithmetic is gopsutil's own (getAllBusy / calculateBusy), reproduced
// here rather than reached through `cpu.Percent(0, true)` so the baseline is
// OURS. gopsutil keeps its last-call state in a package global shared by
// every caller in the process; a second collector calling Percent would
// silently consume this one's baseline and shrink the window to the gap
// between the two calls, which is the bug this file exists to remove.
package collectors

import (
	"math"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
)

// cpuFallbackWindow is the blocking sample used only when there is no usable
// baseline (see hostCPUPercents). Deliberately far shorter than the 1 s it
// replaces: this path should fire approximately never — the baseline is
// primed at process start — so the shortest span that still yields a number
// is the right trade.
const cpuFallbackWindow = 250 * time.Millisecond

// minCPUTimesDelta is the smallest total counter movement, in CPU-seconds
// summed across every core, that counts as a real window. Below it the two
// readings are effectively the same instant (two calls back to back) or the
// counters went backwards (a VM restored from a snapshot, a host resumed
// from suspend), and the ratio would be noise or negative. Both cases fall
// back rather than publishing a fabricated percentage.
const minCPUTimesDelta = 0.05

// cpuSampler holds the previous cumulative reading. One instance per process
// (hostCPUTimes below) — the span it reports is "since whenever this was last
// asked", so sharing it between two callers would give each of them half a
// window.
type cpuSampler struct {
	mu   sync.Mutex
	last []cpu.TimesStat
}

var hostCPUTimes = &cpuSampler{}

func init() {
	// Prime at process start so the FIRST telemetry pass already has a
	// baseline and never has to fall back. That first sample spans process
	// start → first tick (the loop phase plus this process's jitter, so
	// roughly 8–28 s), which covers the agent's own startup — enrollment,
	// first heartbeat, first inventory passes. On a single-core VM that
	// genuinely is a busy stretch and the number should say so; it is the
	// host's real first half-minute, not a measurement artifact.
	hostCPUTimes.prime()
}

func (s *cpuSampler) prime() {
	t, err := cpu.Times(true)
	if err != nil || len(t) == 0 {
		return
	}
	s.mu.Lock()
	s.last = t
	s.mu.Unlock()
}

// hostCPUPercents returns per-logical-core busy percentages over the span
// since the previous call, plus the aggregate across all of them. ok is false
// only when the counters cannot be read at all.
func hostCPUPercents() (per []float64, aggregate float64, ok bool) {
	return hostCPUTimes.percents()
}

func (s *cpuSampler) percents() ([]float64, float64, bool) {
	cur, err := cpu.Times(true)
	if err != nil || len(cur) == 0 {
		return nil, 0, false
	}

	s.mu.Lock()
	prev := s.last
	s.last = cur
	s.mu.Unlock()

	if per, agg, ok := busyPercents(prev, cur, runtime.GOOS == "linux"); ok {
		return per, agg, true
	}

	// No usable baseline: first call after a failed prime, a vCPU
	// hot-plugged or hot-unplugged under us, or counters that did not
	// advance. One short blocking window gets this pass a number; the
	// reading just stored becomes the next pass's baseline, so the
	// following sample is back on the interval-mean path.
	fb, err := cpu.Percent(cpuFallbackWindow, true)
	if err != nil || len(fb) == 0 {
		return nil, 0, false
	}
	return fb, meanPct(fb), true
}

// busyPercents converts two cumulative readings into one busy percentage per
// core plus the aggregate. Exported to the package (and to its test) as a
// pure function: every branch here describes a host doing something odd —
// a core parked, a counter reset, a vCPU added — and those are not
// reproducible against a real /proc/stat.
//
// The aggregate is computed from the SUMMED deltas rather than as the mean of
// the per-core percentages. The two agree whenever every core's counters
// advanced by the same amount, which is the normal case; they diverge when
// one core was offline for part of the span, and the summed form is the one
// that still means "this host's CPU" there. It also keeps its meaning when
// the per-core vector is truncated at maxReportedCores, since it never looked
// at the vector.
func busyPercents(prev, cur []cpu.TimesStat, linux bool) ([]float64, float64, bool) {
	if len(prev) == 0 || len(prev) != len(cur) {
		// No baseline yet, or the logical-core count changed between reads —
		// index i is not the same core in both slices, so nothing here is
		// comparable.
		return nil, 0, false
	}

	out := make([]float64, len(cur))
	var totalAll, totalBusy float64
	for i := range cur {
		prevAll, prevBusy := cpuBusy(prev[i], linux)
		curAll, curBusy := cpuBusy(cur[i], linux)
		all, busy := curAll-prevAll, curBusy-prevBusy

		totalAll += all
		totalBusy += busy

		if all <= 0 {
			// This core's counters stood still (parked / offline) or went
			// backwards. It ran nothing we can attribute, so 0 is the honest
			// per-core answer; whether the reading as a WHOLE is usable is
			// decided by totalAll below, which is still carrying the negative.
			out[i] = 0
			continue
		}
		out[i] = clampPct(busy / all * 100)
	}

	if totalAll < minCPUTimesDelta {
		return nil, 0, false
	}
	return out, clampPct(totalBusy / totalAll * 100), true
}

// cpuBusy splits one cumulative reading into (total, busy) CPU-seconds,
// matching gopsutil's getAllBusy so the percentage keeps exactly the meaning
// it had when cpu.Percent computed it — only the span changes.
//
// Idle and iowait are not busy. On Linux, guest time is ALREADY counted
// inside user (and guestNice inside nice) by the kernel, so adding the guest
// fields again would inflate the denominator on any host running VMs; every
// other platform reports them as zero and the subtraction would be a no-op,
// but the condition mirrors gopsutil's rather than relying on that.
func cpuBusy(t cpu.TimesStat, linux bool) (total float64, busy float64) {
	total = t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq +
		t.Softirq + t.Steal + t.Guest + t.GuestNice
	if linux {
		total -= t.Guest
		total -= t.GuestNice
	}
	busy = total - t.Idle - t.Iowait
	return total, busy
}

// meanPct averages a per-core vector — the aggregate for the fallback path,
// where all we have is what cpu.Percent handed back.
func meanPct(per []float64) float64 {
	if len(per) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range per {
		sum += v
	}
	return clampPct(sum / float64(len(per)))
}

// clampPct keeps a percentage inside [0,100] and turns NaN/Inf into 0. A
// counter that jumps backwards on one field but not another can produce
// either, and a chart is better served by a floor than by a spike nobody can
// explain.
func clampPct(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
