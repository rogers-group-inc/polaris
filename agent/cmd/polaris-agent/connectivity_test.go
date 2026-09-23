package main

import (
	"testing"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/transport"
)

func connDef(id string, interval int) transport.ConnectivityCheckDef {
	return transport.ConnectivityCheckDef{
		ID: id, Kind: "icmp", Target: "10.0.0.1", IntervalSec: interval, TimeoutMs: 1000,
		Traceroute: transport.ConnectivityTracerouteDef{Enabled: true, EveryNRuns: 5},
	}
}

func TestConnectivityDue(t *testing.T) {
	now := time.Now()
	d := connDef("a", 60)
	if !connectivityDue(nil, &d, now) || !connectivityDue(&checkState{}, &d, now) {
		t.Fatal("a check that never ran is due")
	}
	st := &checkState{runCount: 1, lastRunAt: now.Add(-55 * time.Second)}
	if !connectivityDue(st, &d, now) {
		t.Error("55 s into a 60 s interval is due (5 s slack for tick jitter)")
	}
	st.lastRunAt = now.Add(-54 * time.Second)
	if connectivityDue(st, &d, now) {
		t.Error("54 s is not due")
	}
	d5 := connDef("b", 300)
	st.lastRunAt = now.Add(-120 * time.Second)
	if connectivityDue(st, &d5, now) {
		t.Error("a 5-minute check is not due after 2 minutes")
	}
}

func TestTracerouteModeFor(t *testing.T) {
	d := connDef("a", 60)
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

func TestPruneConnectivityState(t *testing.T) {
	a, b := connDef("a", 60), connDef("b", 60)
	states := map[string]*checkState{}
	pruneConnectivityState(states, []transport.ConnectivityCheckDef{a, b})
	states["a"].runCount = 7
	states["b"].runCount = 3

	b.Target = "10.0.0.2" // edited
	pruneConnectivityState(states, []transport.ConnectivityCheckDef{a, b})
	if states["a"].runCount != 7 {
		t.Error("an unchanged check keeps its state")
	}
	if states["b"].runCount != 0 {
		t.Error("an edited check re-baselines")
	}
	pruneConnectivityState(states, []transport.ConnectivityCheckDef{a})
	if _, ok := states["b"]; ok {
		t.Error("a removed check is dropped")
	}
}
