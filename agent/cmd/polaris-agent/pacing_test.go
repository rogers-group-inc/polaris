package main

import (
	"context"
	"testing"
	"time"
)

// The bug these guard against: every loop was started in the same instant
// with a bare time.NewTicker, and a Go ticker keeps the phase it was created
// with. Four loops share a 300 s cadence and five share 60 s, so those groups
// fired together for the life of the process — on a two-core Windows host
// that meant a PowerShell CIM query and a tasklist spawn landing on the same
// instant every five minutes, while the response-time probe was being timed
// through the same process. Both charts grew a five-minute sawtooth.

// defaultIntervalSec mirrors the compiled cadence of each loop, so the tests
// below can check an offset against the interval it actually has to fit in.
// A loop added to loopPhaseSec without a line here fails TestEveryLoopPhaseIsKnown.
var defaultIntervalSec = map[string]int{
	"responseTime":       defaultResponseTimeIntervalSec,
	"command":            defaultCommandPollIntervalSec,
	"heartbeat":          defaultHeartbeatIntervalSec,
	"telemetry":          defaultTelemetryIntervalSec,
	"systemInfo":         defaultHeartbeatIntervalSec,
	"interfaces":         defaultInterfacesIntervalSec,
	"storage":            defaultStorageIntervalSec,
	"eventLog":           defaultEventLogIntervalSec,
	"processInventory":   defaultProcessInventoryIntervalSec,
	"serviceInventory":   defaultServiceInventoryIntervalSec,
	"processTelemetry":   defaultProcessTelemetryIntervalSec,
	"processLog":         defaultProcessLogIntervalSec,
	"serviceLog":         defaultProcessLogIntervalSec,
	"processConnections": defaultProcessConnectionsIntervalSec,
	"connectivity":       defaultConnectivityIntervalSec,
}

func TestEveryLoopPhaseIsKnown(t *testing.T) {
	for name := range loopPhaseSec {
		if _, ok := defaultIntervalSec[name]; !ok {
			t.Errorf("loop %q has a phase but no cadence in this test's table — add it", name)
		}
	}
	for name := range defaultIntervalSec {
		if _, ok := loopPhaseSec[name]; !ok {
			t.Errorf("loop %q has a cadence but no phase — it would collide with whatever shares it", name)
		}
	}
}

func TestLoopPhasesFitInsideAMinute(t *testing.T) {
	// Capped deliberately: a phase proportional to the interval would space
	// the 300 s loops further apart, but an operator who just installed the
	// agent would wait minutes for the first process list.
	for name, sec := range loopPhaseSec {
		if sec < 0 || sec >= 60 {
			t.Errorf("loop %q phase %ds is outside [0,60)", name, sec)
		}
	}
}

func TestLoopsSharingACadenceAreSpread(t *testing.T) {
	// The whole point. Two loops on the same interval must not fire together,
	// and the two that spawn a subprocess need real daylight between them.
	const minGapSec = 4

	byInterval := map[int][]string{}
	for name, sec := range defaultIntervalSec {
		byInterval[sec] = append(byInterval[sec], name)
	}
	for interval, names := range byInterval {
		for i := 0; i < len(names); i++ {
			for j := i + 1; j < len(names); j++ {
				a, b := loopPhaseSec[names[i]], loopPhaseSec[names[j]]
				gap := a - b
				if gap < 0 {
					gap = -gap
				}
				if gap < minGapSec {
					t.Errorf("%q and %q both run every %ds and are only %ds apart (phases %d/%d)",
						names[i], names[j], interval, gap, a, b)
				}
			}
		}
	}
}

func TestSubprocessSpawningLoopsAreFarApart(t *testing.T) {
	// processInventory shells out to `tasklist /svc` and serviceInventory to
	// PowerShell + Get-CimInstance. Launching PowerShell alone is most of a
	// core-second; these two landing together is what put the visible spike
	// on a two-core host.
	const minGapSec = 5
	gap := loopPhaseSec["serviceInventory"] - loopPhaseSec["processInventory"]
	if gap < 0 {
		gap = -gap
	}
	if gap < minGapSec {
		t.Errorf("the two subprocess-spawning loops are only %ds apart; want >= %ds", gap, minGapSec)
	}
}

func TestResponseTimeOwnsTheZeroMark(t *testing.T) {
	// responseTime measures a /heartbeat round trip through this process, so
	// it is the measurement every other loop has to get out of the way of.
	// Anything else sitting on its tick is being timed along with it.
	if loopPhaseSec["responseTime"] != 0 {
		t.Fatalf("responseTime phase = %d, want 0", loopPhaseSec["responseTime"])
	}
	for name, sec := range loopPhaseSec {
		if sec == 0 && name != "responseTime" {
			t.Errorf("loop %q sits on responseTime's tick at phase 0", name)
		}
	}
}

func TestLoopStartDelayNeverSkipsAWholeInterval(t *testing.T) {
	// A 20 s command poll must not be pushed out by a 45 s phase + jitter.
	for name := range loopPhaseSec {
		interval := time.Duration(defaultIntervalSec[name]) * time.Second
		if d := loopStartDelay(name, interval); d >= interval {
			t.Errorf("loop %q start delay %s >= its %s interval", name, d, interval)
		}
	}
}

func TestLoopJitterSlidesEveryLoopEqually(t *testing.T) {
	// Jitter spreads the FLEET; it must not disturb the phase spacing that
	// spreads the loops on one host. Same draw for everyone means the gaps
	// between loops are unchanged.
	const interval = 300 * time.Second
	a := loopStartDelay("processInventory", interval) - loopStartDelay("heartbeat", interval)
	want := time.Duration(loopPhaseSec["processInventory"]-loopPhaseSec["heartbeat"]) * time.Second
	if a != want {
		t.Errorf("jitter changed the gap between two loops: got %s, want %s", a, want)
	}
	if loopJitter < 0 || loopJitter >= maxLoopJitter {
		t.Errorf("loopJitter %s outside [0, %s)", loopJitter, maxLoopJitter)
	}
}

func TestRunLoopHonoursContextDuringTheStartDelay(t *testing.T) {
	// A host shutting down inside the offset window must not be held open by
	// it — the delay is a select on ctx.Done, not a sleep.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		// "processConnections" has the largest phase, so this would block for
		// ~47 s plus jitter if the wait ignored cancellation.
		runLoop(ctx, "processConnections", time.Hour, true, func() { t.Error("fn ran after cancel") })
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runLoop did not return promptly after its context was cancelled")
	}
}

// TestPhasesAreDistinctAndCadencesAreMinuteMultiples pins the property that
// makes the separation PERMANENT rather than merely true at boot.
//
// Every staggered cadence is a multiple of 60 s (60 / 300 / 600), and every
// phase is inside [0, 60). Two loops therefore stay exactly
// |phase_a - phase_b| seconds apart forever — their firing times can never
// converge, however long the process runs. Break either half and the drift
// comes back: a 45 s cadence, or two loops sharing a phase, and some pair
// starts landing together again on a period nobody will think to look for.
//
// `command` is the deliberate exception and is excluded: it polls every 20 s,
// so it re-enters the minute at 2 / 22 / 42 and does brush past other loops.
// It is one cheap GET with no subprocess and no collector, which is the whole
// reason it is allowed to.
func TestPhasesAreDistinctAndCadencesAreMinuteMultiples(t *testing.T) {
	seen := map[int]string{}
	for name, sec := range loopPhaseSec {
		if prev, dup := seen[sec]; dup {
			t.Errorf("loops %q and %q share phase %ds — they will fire together forever", prev, name, sec)
		}
		seen[sec] = name
	}
	for name, interval := range defaultIntervalSec {
		if name == "command" {
			continue
		}
		if interval%60 != 0 {
			t.Errorf("loop %q runs every %ds, which is not a multiple of 60 — its phase will drift into others", name, interval)
		}
	}
}

// TestNoTwoExpensiveLoopsEverCoincide walks the actual firing schedule for a
// simulated hour rather than reasoning about it, because the reasoning above
// is exactly the kind that survives a refactor while the behaviour does not.
func TestNoTwoExpensiveLoopsEverCoincide(t *testing.T) {
	// Anything that spawns a subprocess, enumerates the whole machine, or
	// holds a core for a measurable moment. Two of these landing on the
	// same second is the bug.
	expensive := []string{
		"processInventory", "serviceInventory", "systemInfo", "eventLog",
		"processLog", "serviceLog", "processTelemetry", "processConnections",
		"telemetry", "connectivity",
	}
	const minGapSec = 3
	const horizonSec = 3600

	type fire struct {
		at   int
		name string
	}
	var fires []fire
	for _, name := range expensive {
		interval := defaultIntervalSec[name]
		if interval == 0 {
			t.Fatalf("no cadence known for %q", name)
		}
		for at := loopPhaseSec[name]; at < horizonSec; at += interval {
			fires = append(fires, fire{at, name})
		}
	}
	for i := range fires {
		for j := i + 1; j < len(fires); j++ {
			if fires[i].name == fires[j].name {
				continue
			}
			gap := fires[i].at - fires[j].at
			if gap < 0 {
				gap = -gap
			}
			if gap < minGapSec {
				t.Fatalf("%q at %ds and %q at %ds are %ds apart — within one collection",
					fires[i].name, fires[i].at, fires[j].name, fires[j].at, gap)
			}
		}
	}
}

// TestResponseTimeIsNeverMeasuredDuringAnExpensivePass is the one the charts
// actually showed. responseTime times a /heartbeat round trip through this
// process; if a PowerShell CIM query is running when it does, the number it
// reports is about the agent, not the network.
func TestResponseTimeIsNeverMeasuredDuringAnExpensivePass(t *testing.T) {
	// A collection can hold a core for around a second, and the round trip
	// itself takes a moment, so keep a couple of seconds of clearance.
	const clearanceSec = 2
	const horizonSec = 3600

	expensive := []string{"processInventory", "serviceInventory", "systemInfo"}
	rtInterval := defaultIntervalSec["responseTime"]
	for rt := loopPhaseSec["responseTime"]; rt < horizonSec; rt += rtInterval {
		for _, name := range expensive {
			interval := defaultIntervalSec[name]
			for at := loopPhaseSec[name]; at < horizonSec; at += interval {
				gap := rt - at
				if gap < 0 {
					gap = -gap
				}
				if gap < clearanceSec {
					t.Fatalf("responseTime fires at %ds, %ds from %q at %ds", rt, gap, name, at)
				}
			}
		}
	}
}
