package main

// Agent-run connectivity checks — the scheduler half. The probes live in
// internal/collectors/connectivity*.go; this file decides which checks are
// due each minute, whether each run carries a traceroute, runs them on a
// small bounded pool, and pushes one batch per stream.
//
// ONE 60 s loop (phase in loopPhaseSec, cadence in pacing_test.go), not one
// loop per check: every agent cadence must be a whole minute on a fixed phase
// (see TestPhasesAreDistinctAndCadencesAreMinuteMultiples), and a check's own
// intervalSec is a multiple of 60, so "due" is decided per tick.
//
// This loop has its OWN time budget (connectivityTickBudget, 55 s) instead of
// the shared 30 s collectionTimeout. That guard exists for OS calls that cannot
// be cancelled (statfs, ioctl), whose goroutine is expected to leak; here every
// operation is context-bound (DialContext, the request context, Poll with a
// computed timeout, IcmpSendEcho2's own timeout), so workers really do stop at
// their deadline. The natural bound for "N checks plus a few traceroutes" is
// "before the next tick", and checks that cannot be started in time are left
// due for the next tick — with one log line, so starvation is visible (business
// rule 82: the measurer must not quietly dominate the host).

import (
	"context"
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/config"
	"github.com/polaris/agent/internal/transport"
)

const (
	defaultConnectivityIntervalSec = 60
	connectivityWorkers            = 4
	connectivityTickBudget         = 55 * time.Second
	connectivityDueSlack           = 5 * time.Second
	// The server caps a host at 20; this is the agent's own ceiling.
	maxConnectivityChecks = 64
)

type connectivityRuntimeCfg struct {
	checks []transport.ConnectivityCheckDef
}

var connectivityCfg atomic.Value // connectivityRuntimeCfg

func loadConnectivityCfg() connectivityRuntimeCfg {
	if v := connectivityCfg.Load(); v != nil {
		return v.(connectivityRuntimeCfg)
	}
	return connectivityRuntimeCfg{}
}

// checkState is the scheduler's memory of one check.
type checkState struct {
	defHash          string
	lastRunAt        time.Time // stamped at run START, so due-ness never drifts with run length
	runCount         int       // runs started under this defHash
	lastOk           bool
	lastTracerouteAt time.Time
}

// connectivityDue: never run, or at least one interval (minus a little
// slack for tick jitter) since the last run started.
func connectivityDue(st *checkState, def *transport.ConnectivityCheckDef, now time.Time) bool {
	if st == nil || st.runCount == 0 {
		return true
	}
	interval := time.Duration(def.IntervalSec) * time.Second
	return now.Sub(st.lastRunAt) >= interval-connectivityDueSlack
}

// tracerouteModeFor: the first run of a definition always traces (the
// baseline path), then every Nth run; a run following a PASS traces only if
// it fails — the pass→fail transition always has a fresh path.
func tracerouteModeFor(st *checkState, def *transport.ConnectivityCheckDef) collectors.TraceMode {
	if !def.Traceroute.Enabled {
		return collectors.TraceNever
	}
	every := def.Traceroute.EveryNRuns
	if every <= 0 {
		every = 5
	}
	if st == nil || st.runCount%every == 0 {
		return collectors.TraceAlways
	}
	if st.lastOk {
		return collectors.TraceOnFail
	}
	return collectors.TraceNever
}

// pruneConnectivityState drops checks no longer shipped and resets any whose
// definition changed, so an edited check re-baselines.
func pruneConnectivityState(states map[string]*checkState, defs []transport.ConnectivityCheckDef) {
	keep := make(map[string]string, len(defs))
	for i := range defs {
		keep[defs[i].ID] = collectors.DefHash(&defs[i])
	}
	for id, st := range states {
		h, ok := keep[id]
		if !ok {
			delete(states, id)
			continue
		}
		if st.defHash != h {
			states[id] = &checkState{defHash: h}
		}
	}
	for id, h := range keep {
		if _, ok := states[id]; !ok {
			states[id] = &checkState{defHash: h}
		}
	}
}

func connectivityLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	_ = cfg // cadence is the fixed 60 s tick; each check carries its own interval
	states := map[string]*checkState{}
	runLoop(ctx, "connectivity", time.Duration(defaultConnectivityIntervalSec)*time.Second, true, func() {
		pushConnectivityOne(ctx, client, states)
	})
}

type connectivityJob struct {
	def  transport.ConnectivityCheckDef
	mode collectors.TraceMode
	st   *checkState
}

type connectivityOutcome struct {
	job    connectivityJob
	sample *transport.ConnectivitySample
	trace  *transport.ConnectivityTraceroute
}

func pushConnectivityOne(ctx context.Context, client *transport.Client, states map[string]*checkState) {
	defs := loadConnectivityCfg().checks
	if len(defs) > maxConnectivityChecks {
		log.Printf("connectivity: %d checks shipped, running the first %d", len(defs), maxConnectivityChecks)
		defs = defs[:maxConnectivityChecks]
	}
	pruneConnectivityState(states, defs)
	if len(defs) == 0 {
		return
	}

	now := time.Now()
	var due []connectivityJob
	for i := range defs {
		st := states[defs[i].ID]
		if connectivityDue(st, &defs[i], now) {
			due = append(due, connectivityJob{def: defs[i], st: st})
		}
	}
	if len(due) == 0 {
		return
	}
	// Longest-waiting first, so a tick that runs out of budget starves the
	// most recently run check rather than the same one every time.
	sort.Slice(due, func(i, j int) bool { return due[i].st.lastRunAt.Before(due[j].st.lastRunAt) })

	tickCtx, cancel := context.WithTimeout(ctx, connectivityTickBudget)
	defer cancel()
	jobs := make(chan connectivityJob)
	outcomes := make(chan connectivityOutcome, len(due))
	var wg sync.WaitGroup
	opts := collectors.ConnectivityOpts{UserAgent: "polaris-agent/" + version}
	for w := 0; w < connectivityWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				o := opts
				o.Trace = j.mode
				runCtx, runCancel := context.WithTimeout(tickCtx,
					time.Duration(j.def.TimeoutMs)*time.Millisecond+collectors.TracerouteBudget)
				s, tr := collectors.RunOnce(runCtx, &j.def, o)
				runCancel()
				outcomes <- connectivityOutcome{job: j, sample: s, trace: tr}
			}
		}()
	}
	// Dispatch — bookkeeping happens HERE, in the loop goroutine, so the state
	// map has a single writer.
	deferred := 0
dispatch:
	for _, j := range due {
		j.mode = tracerouteModeFor(j.st, &j.def)
		select {
		case jobs <- j:
			j.st.lastRunAt = time.Now()
			j.st.runCount++
		case <-tickCtx.Done():
			deferred = len(due) - countStarted(due, j)
			break dispatch
		}
	}
	close(jobs)
	wg.Wait()
	close(outcomes)
	if deferred > 0 {
		log.Printf("connectivity: %d checks deferred — tick budget exhausted", deferred)
	}

	var samples []*transport.ConnectivitySample
	var traces []*transport.ConnectivityTraceroute
	for o := range outcomes {
		o.job.st.lastOk = o.sample.OK
		samples = append(samples, o.sample)
		if o.trace != nil {
			o.job.st.lastTracerouteAt = time.Now()
			traces = append(traces, o.trace)
		}
	}
	if len(samples) > 0 {
		resp, err := client.PushSamples(&transport.SamplesBody{Stream: "connectivity", Samples: samples})
		if err != nil {
			log.Printf("push connectivity samples: %v", err)
		} else if verbose {
			log.Printf("connectivity sent: rows=%d -> accepted=%d rejected=%d", len(samples), resp.Accepted, resp.Rejected)
		}
	}
	if len(traces) > 0 {
		resp, err := client.PushSamples(&transport.SamplesBody{Stream: "connectivityTraceroute", Samples: traces})
		if err != nil {
			log.Printf("push connectivity traceroutes: %v", err)
		} else if verbose {
			log.Printf("connectivity traceroutes sent: rows=%d -> accepted=%d rejected=%d", len(traces), resp.Accepted, resp.Rejected)
		}
	}
}

// countStarted is how many jobs before `stop` were dispatched.
func countStarted(due []connectivityJob, stop connectivityJob) int {
	for i, j := range due {
		if j.def.ID == stop.def.ID {
			return i
		}
	}
	return len(due)
}
