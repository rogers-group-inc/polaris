package collectors

import (
	"math"
	"testing"

	"github.com/shirou/gopsutil/v3/mem"
)

// The one invariant the chart depends on: the four bands close on Total.
// Everything else in this file exists to prove that holds for readings no
// well-behaved OS would produce, because the readings come from separate
// syscalls on a live system and occasionally do.
func assertClosed(t *testing.T, b MemBreakdown) {
	t.Helper()
	if !b.Ok {
		t.Fatalf("breakdown not Ok")
	}
	sum := b.Used + b.Buffers + b.Cached + b.Free
	if sum != b.Total {
		t.Errorf("bands do not close on total: used=%d buffers=%d cached=%d free=%d sum=%d total=%d",
			b.Used, b.Buffers, b.Cached, b.Free, sum, b.Total)
	}
}

func TestMemBreakdownLinuxShape(t *testing.T) {
	// A plausible /proc/meminfo-derived reading: gopsutil has already
	// computed Used = Total - Free - Buffers - Cached on this path.
	const total = 16 << 30
	vm := &mem.VirtualMemoryStat{
		Total:   total,
		Free:    2 << 30,
		Buffers: 1 << 30,
		Cached:  5 << 30,
		Used:    total - (2 << 30) - (1 << 30) - (5 << 30),
	}
	b := memBreakdownFrom(vm, 0)
	assertClosed(t, b)
	if b.Used != 8<<30 {
		t.Errorf("used = %d, want %d", b.Used, uint64(8<<30))
	}
	if b.Cached != 5<<30 {
		t.Errorf("cached = %d, want %d", b.Cached, uint64(5<<30))
	}
	if b.Free != 2<<30 {
		t.Errorf("free = %d, want %d", b.Free, uint64(2<<30))
	}
}

func TestMemBreakdownWindowsCacheOverride(t *testing.T) {
	// GlobalMemoryStatusEx reports no cache, so gopsutil's Cached is 0 and
	// its Free (= Available) still has the standby cache folded in. The
	// override is the whole point of the Windows path: without it the cache
	// band reads zero on every Windows host.
	const total = 32 << 30
	vm := &mem.VirtualMemoryStat{
		Total:     total,
		Available: 20 << 30,
		Free:      20 << 30,
		Used:      12 << 30,
	}
	b := memBreakdownFrom(vm, 8<<30) // 8 GiB in the system cache
	assertClosed(t, b)
	if b.Cached != 8<<30 {
		t.Errorf("cached = %d, want the override %d", b.Cached, uint64(8<<30))
	}
	if b.Used != 12<<30 {
		t.Errorf("used = %d, want %d", b.Used, uint64(12<<30))
	}
	// Free is the REMAINDER, not gopsutil's Available — the cache came out
	// of the same 20 GiB Available reported.
	if b.Free != 12<<30 {
		t.Errorf("free = %d, want %d", b.Free, uint64(12<<30))
	}
}

// The underflow this clamping exists to prevent: unclamped, Total-Used on
// these numbers wraps a uint64 to ~16 EiB and the chart's free band swallows
// the axis.
func TestMemBreakdownClampsOverreportedUsed(t *testing.T) {
	vm := &mem.VirtualMemoryStat{Total: 8 << 30, Used: 9 << 30, Cached: 1 << 30}
	b := memBreakdownFrom(vm, 0)
	assertClosed(t, b)
	if b.Used != 8<<30 {
		t.Errorf("used = %d, want it clamped to total %d", b.Used, uint64(8<<30))
	}
	if b.Free != 0 || b.Cached != 0 {
		t.Errorf("nothing should be left for cache/free: cached=%d free=%d", b.Cached, b.Free)
	}
}

func TestMemBreakdownClampsOverreportedCache(t *testing.T) {
	// Cache is trimmed before the process band, never the other way round:
	// an over-reported cache must not inflate the number an operator acts on.
	vm := &mem.VirtualMemoryStat{Total: 8 << 30, Used: 6 << 30, Buffers: 1 << 30, Cached: 4 << 30}
	b := memBreakdownFrom(vm, 0)
	assertClosed(t, b)
	if b.Used != 6<<30 {
		t.Errorf("used = %d, want it untouched at %d", b.Used, uint64(6<<30))
	}
	if b.Buffers != 1<<30 {
		t.Errorf("buffers = %d, want %d", b.Buffers, uint64(1<<30))
	}
	if b.Cached != 1<<30 {
		t.Errorf("cached = %d, want it trimmed to the remainder %d", b.Cached, uint64(1<<30))
	}
	if b.Free != 0 {
		t.Errorf("free = %d, want 0", b.Free)
	}
}

func TestMemBreakdownRejectsUnusableReadings(t *testing.T) {
	if b := memBreakdownFrom(nil, 0); b.Ok {
		t.Error("nil reading should not be Ok")
	}
	// Total of 0 means the syscall answered with nothing usable. Reporting
	// Ok here would put a zero-height stack on the chart.
	if b := memBreakdownFrom(&mem.VirtualMemoryStat{}, 0); b.Ok {
		t.Error("zero-total reading should not be Ok")
	}
}

func TestRound1(t *testing.T) {
	cases := []struct{ in, want float64 }{
		{0, 0},
		{12.34, 12.3},
		{12.35, 12.4},
		{99.99, 100},
	}
	for _, c := range cases {
		if got := round1(c.in); got != c.want {
			t.Errorf("round1(%v) = %v, want %v", c.in, got, c.want)
		}
	}
	// NaN/Inf reach this from a division by a zero core count on a host that
	// briefly reports none; they must not serialize into the payload as
	// `NaN`, which is not valid JSON and would fail the whole push.
	if got := round1(math.NaN()); got != 0 {
		t.Errorf("round1(NaN) = %v, want 0", got)
	}
	if got := round1(math.Inf(1)); got != 0 {
		t.Errorf("round1(+Inf) = %v, want 0", got)
	}
}
