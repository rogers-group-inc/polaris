// processtelemetry.go — per-pinned-program CPU/RAM sampling (Feature C).
//
// Unlike the inventory snapshot (cumulative CPUPercent), telemetry wants the
// RATE over the interval. Business rule 82, the same reasoning as
// cputimes.go for the host: a measurement must not be a short blocking slice
// the agent's own work can dominate. So each pinned PID's CUMULATIVE CPU time
// (user + system) is kept as a baseline between passes, keyed by PID AND the
// process's start time (a reused PID is a new process), and each pass reports
// the delta since the previous one — the whole cadence, with nothing blocking.
//
// A PID seen for the first time (agent start, a program restart) has no
// baseline: those PIDs alone fall back to the old prime → short sleep → read,
// so the first sample after a restart is still a real number. Until 0.28.4
// EVERY pass did that, a 300 ms blocking window once a minute (CQ-G010).
// Results are aggregated by program name (summed across instances) to match
// the AssetProcessSample model.
package collectors

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"github.com/polaris/agent/internal/transport"
)

// processCPUSampleWindow is the prime→read gap used ONLY for PIDs with no
// baseline yet. Short enough to keep the loop snappy, long enough for a
// meaningful number.
const processCPUSampleWindow = 300 * time.Millisecond

// procCPUBaseline is one PID's cumulative CPU seconds at a wall-clock instant.
type procCPUBaseline struct {
	createTime int64   // ms since epoch; a different value = a different process
	cpuSeconds float64 // user + system, cumulative
	at         time.Time
}

var procCPUBase = struct {
	sync.Mutex
	m map[int32]procCPUBaseline
}{m: map[int32]procCPUBaseline{}}

// procCPUPercent is the CPU rate between two readings of the SAME process, as
// gopsutil's Process.Percent reports it: percent of one core, so a process
// busy on two cores reads 200. ok=false when the two readings are not usable
// (a different process behind the PID, no elapsed time, or a counter that
// went backwards).
func procCPUPercent(prev, cur procCPUBaseline) (pct float64, ok bool) {
	if prev.createTime != cur.createTime {
		return 0, false
	}
	elapsed := cur.at.Sub(prev.at).Seconds()
	if elapsed <= 0 {
		return 0, false
	}
	delta := cur.cpuSeconds - prev.cpuSeconds
	if delta < 0 {
		return 0, false
	}
	return delta / elapsed * 100, true
}

// readProcCPU reads one process's cumulative CPU time now.
func readProcCPU(p *process.Process) (procCPUBaseline, bool) {
	t, err := p.Times()
	if err != nil || t == nil {
		return procCPUBaseline{}, false
	}
	ct, _ := p.CreateTime()
	return procCPUBaseline{createTime: ct, cpuSeconds: t.User + t.System, at: time.Now()}, true
}

// ProcessTelemetryOnce samples CPU/RAM for the pinned program names and returns
// one aggregated row per name. Returns nil when nothing is pinned or the
// process table can't be read.
func ProcessTelemetryOnce(pinnedNames []string) []*transport.ProcessTelemetrySample {
	if len(pinnedNames) == 0 {
		return nil
	}
	want := make(map[string]bool, len(pinnedNames))
	for _, n := range pinnedNames {
		want[n] = true
	}
	procs, err := process.Processes()
	if err != nil {
		return nil
	}

	// Collect the matching processes once (name lookup is the expensive call).
	type match struct {
		p    *process.Process
		name string
		cpu  float64
		have bool
	}
	var matches []*match
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || !want[name] {
			continue
		}
		matches = append(matches, &match{p: p, name: name})
	}
	if len(matches) == 0 {
		return nil
	}

	// Delta since the previous pass for every PID with a baseline; prime the
	// rest. The baselines are rewritten from this pass's readings, and PIDs
	// that are gone are dropped.
	procCPUBase.Lock()
	next := make(map[int32]procCPUBaseline, len(matches))
	var unprimed []*match
	for _, m := range matches {
		cur, ok := readProcCPU(m.p)
		if !ok {
			continue
		}
		if prev, seen := procCPUBase.m[m.p.Pid]; seen {
			if pct, good := procCPUPercent(prev, cur); good {
				m.cpu, m.have = pct, true
			}
		}
		next[m.p.Pid] = cur
		if !m.have {
			_, _ = m.p.Percent(0) // prime gopsutil's own counter for the fallback read
			unprimed = append(unprimed, m)
		}
	}
	procCPUBase.m = next
	procCPUBase.Unlock()

	// Fallback for PIDs with no usable baseline: one short sleep shared by all
	// of them. Approximately never after the first pass.
	if len(unprimed) > 0 {
		time.Sleep(processCPUSampleWindow)
		for _, m := range unprimed {
			if v, err := m.p.Percent(0); err == nil {
				m.cpu, m.have = v, true
			}
		}
	}

	// Aggregate by program name.
	type agg struct {
		count int
		cpu   float64
		rss   uint64
	}
	byName := make(map[string]*agg)
	order := make([]string, 0)
	for _, m := range matches {
		a := byName[m.name]
		if a == nil {
			a = &agg{}
			byName[m.name] = a
			order = append(order, m.name)
		}
		a.count++
		if m.have {
			a.cpu += m.cpu
		}
		if mi, err := m.p.MemoryInfo(); err == nil && mi != nil {
			a.rss += mi.RSS
		}
	}

	ts := time.Now().UTC().Format(time.RFC3339Nano)
	out := make([]*transport.ProcessTelemetrySample, 0, len(order))
	for _, name := range order {
		a := byName[name]
		cpu := a.cpu
		rss := a.rss
		out = append(out, &transport.ProcessTelemetrySample{
			Timestamp:     ts,
			Name:          name,
			CpuPct:        &cpu,
			MemRssBytes:   &rss,
			InstanceCount: a.count,
		})
	}
	return out
}
