package main

import (
	"testing"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/transport"
)

func pathDef(id string, interval int) transport.PathCheckDef {
	return transport.PathCheckDef{
		ID: id, Kind: "icmp", Target: "10.0.0.1", IntervalSec: interval, TimeoutMs: 1000,
		Traceroute: transport.PathCheckTracerouteDef{Enabled: true, EveryNRuns: 5},
	}
}

func TestPathCheckDue(t *testing.T) {
	now := time.Now()
	d := pathDef("a", 60)
	if !pathCheckDue(nil, &d, now) || !pathCheckDue(&checkState{}, &d, now) {
		t.Fatal("a check that never ran is due")
	}
	st := &checkState{runCount: 1, lastRunAt: now.Add(-55 * time.Second)}
	if !pathCheckDue(st, &d, now) {
		t.Error("55 s into a 60 s interval is due (5 s slack for tick jitter)")
	}
	st.lastRunAt = now.Add(-54 * time.Second)
	if pathCheckDue(st, &d, now) {
		t.Error("54 s is not due")
	}
	d5 := pathDef("b", 300)
	st.lastRunAt = now.Add(-120 * time.Second)
	if pathCheckDue(st, &d5, now) {
		t.Error("a 5-minute check is not due after 2 minutes")
	}
}

func TestTracerouteModeFor(t *testing.T) {
	d := pathDef("a", 60)
	if tracerouteModeFor(nil, &d) != collectors.TraceAlways {
		t.Error("the first run traces (baseline)")
	}
	if tracerouteModeFor(&checkState{runCount: 5}, &d) != collectors.TraceAlways {
		t.Error("every 5th run traces")
	}
	if tracerouteModeFor(&checkState{runCount: 3, lastOk: true}, &d) != collectors.TraceOnFail {
		t.Error("after a pass, trace only if this run fails")
	}
	if tracerouteModeFor(&checkState{runCount: 3, lastOk: false}, &d) != collectors.TraceNever {
		t.Error("still failing: no extra trace (the transition already had one)")
	}
	d.Traceroute.Enabled = false
	if tracerouteModeFor(nil, &d) != collectors.TraceNever {
		t.Error("disabled never traces")
	}
}

func TestPrunePathCheckState(t *testing.T) {
	a, b := pathDef("a", 60), pathDef("b", 60)
	states := map[string]*checkState{}
	prunePathCheckState(states, []transport.PathCheckDef{a, b})
	states["a"].runCount = 7
	states["b"].runCount = 3

	b.Target = "10.0.0.2" // edited
	prunePathCheckState(states, []transport.PathCheckDef{a, b})
	if states["a"].runCount != 7 {
		t.Error("an unchanged check keeps its state")
	}
	if states["b"].runCount != 0 {
		t.Error("an edited check re-baselines")
	}
	prunePathCheckState(states, []transport.PathCheckDef{a})
	if _, ok := states["b"]; ok {
		t.Error("a removed check is dropped")
	}
}
