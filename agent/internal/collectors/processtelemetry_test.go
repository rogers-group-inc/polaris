package collectors

import (
	"math"
	"testing"
	"time"
)

// CQ-G010: per-PID CPU is the delta of cumulative CPU time since the previous
// pass — no blocking window — and a reused PID is never measured against the
// process that had it before.
func TestProcCPUPercent(t *testing.T) {
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	base := procCPUBaseline{createTime: 1000, cpuSeconds: 10, at: t0}

	t.Run("rate over the whole interval", func(t *testing.T) {
		// 30 s of CPU in 60 s of wall time = half a core.
		pct, ok := procCPUPercent(base, procCPUBaseline{createTime: 1000, cpuSeconds: 40, at: t0.Add(60 * time.Second)})
		if !ok || math.Abs(pct-50) > 1e-9 {
			t.Fatalf("got %v %v, want 50 true", pct, ok)
		}
	})

	t.Run("more than one core reads above 100, like gopsutil", func(t *testing.T) {
		pct, ok := procCPUPercent(base, procCPUBaseline{createTime: 1000, cpuSeconds: 130, at: t0.Add(60 * time.Second)})
		if !ok || math.Abs(pct-200) > 1e-9 {
			t.Fatalf("got %v %v, want 200 true", pct, ok)
		}
	})

	t.Run("a reused PID (different start time) is not usable", func(t *testing.T) {
		if _, ok := procCPUPercent(base, procCPUBaseline{createTime: 2000, cpuSeconds: 40, at: t0.Add(60 * time.Second)}); ok {
			t.Fatal("a different process behind the PID must not produce a reading")
		}
	})

	t.Run("no elapsed time or a counter that went backwards is not usable", func(t *testing.T) {
		if _, ok := procCPUPercent(base, procCPUBaseline{createTime: 1000, cpuSeconds: 40, at: t0}); ok {
			t.Fatal("zero elapsed must not produce a reading")
		}
		if _, ok := procCPUPercent(base, procCPUBaseline{createTime: 1000, cpuSeconds: 5, at: t0.Add(time.Minute)}); ok {
			t.Fatal("a backwards counter must not produce a reading")
		}
	})
}
