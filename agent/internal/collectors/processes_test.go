package collectors

import (
	"testing"
	"time"
)

func TestAggregateByName(t *testing.T) {
	raws := []procRaw{
		{Name: "nginx", CPUPct: 5, HasCPU: true, RSSBytes: 100, Username: "www", Exe: "/usr/sbin/nginx", CreateMsec: 2000},
		{Name: "nginx", CPUPct: 7, HasCPU: true, RSSBytes: 150, Username: "www", Exe: "/usr/sbin/nginx", CreateMsec: 1000},
		{Name: "postgres", CPUPct: 3, HasCPU: true, RSSBytes: 800, Username: "pg", Exe: "/usr/bin/postgres", CreateMsec: 500},
	}
	out := aggregateByName(raws)
	if len(out) != 2 {
		t.Fatalf("expected 2 programs, got %d", len(out))
	}
	// Sorted by summed CPU desc: nginx (12) before postgres (3).
	if out[0].Name != "nginx" {
		t.Fatalf("expected nginx first (highest summed CPU), got %s", out[0].Name)
	}
	if out[0].InstanceCount != 2 {
		t.Errorf("nginx instanceCount = %d, want 2", out[0].InstanceCount)
	}
	if out[0].CpuPct == nil || *out[0].CpuPct != 12 {
		t.Errorf("nginx cpu = %v, want 12 (summed)", out[0].CpuPct)
	}
	if out[0].MemRssBytes == nil || *out[0].MemRssBytes != 250 {
		t.Errorf("nginx rss = %v, want 250 (summed)", out[0].MemRssBytes)
	}
	// Earliest CreateTime kept (1000 ms, not 2000).
	if out[0].StartedAt == nil || *out[0].StartedAt != msecToRFC3339(1000) {
		t.Errorf("nginx startedAt = %v, want earliest (1000ms)", out[0].StartedAt)
	}
	if out[1].Name != "postgres" || out[1].InstanceCount != 1 {
		t.Errorf("postgres row wrong: %+v", out[1])
	}
}

func TestAggregateByNameEmpty(t *testing.T) {
	if out := aggregateByName(nil); len(out) != 0 {
		t.Errorf("nil input should yield empty, got %d", len(out))
	}
}

func TestAggregateByNameTieBreakByName(t *testing.T) {
	// Equal CPU → deterministic order by name asc.
	raws := []procRaw{
		{Name: "zeta", CPUPct: 1, HasCPU: true},
		{Name: "alpha", CPUPct: 1, HasCPU: true},
	}
	out := aggregateByName(raws)
	if out[0].Name != "alpha" || out[1].Name != "zeta" {
		t.Errorf("equal-CPU tie should sort by name; got %s, %s", out[0].Name, out[1].Name)
	}
}

// A program none of whose PIDs has an interval rate yet (the agent's first
// scrape, or a process born since the last one) reports NO cpuPct — never 0,
// which would rank "not measured" as "idle" in the top-5 alert list.
func TestAggregateByNameUnmeasuredCPU(t *testing.T) {
	raws := []procRaw{
		{Name: "fresh", RSSBytes: 10},
		{Name: "mixed", CPUPct: 4, HasCPU: true},
		{Name: "mixed"},
	}
	out := aggregateByName(raws)
	byName := map[string]*float64{}
	for _, s := range out {
		byName[s.Name] = s.CpuPct
	}
	if byName["fresh"] != nil {
		t.Errorf("fresh cpu = %v, want nil (unmeasured)", *byName["fresh"])
	}
	if p := byName["mixed"]; p == nil || *p != 4 {
		t.Errorf("mixed cpu = %v, want 4 (the measured PID only)", p)
	}
}

func TestIntervalCPUPct(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	prev := map[string]cpuBaseline{"42": {cpuSec: 10, key: "42:7", at: t0}}
	// 60 CPU-seconds over 300 s = 20 %; over 2 cores' worth it can exceed 100.
	if pct, ok := intervalCPUPct(prev, "42", "42:7", 70, t0.Add(300*time.Second)); !ok || pct < 19.999 || pct > 20.001 {
		t.Errorf("rate = %v %v, want 20", pct, ok)
	}
	if _, ok := intervalCPUPct(prev, "42", "42:99", 70, t0.Add(300*time.Second)); ok {
		t.Error("a reused PID (different start time) must not be differenced")
	}
	if _, ok := intervalCPUPct(prev, "43", "43:7", 70, t0.Add(300*time.Second)); ok {
		t.Error("no baseline must yield no rate")
	}
}
