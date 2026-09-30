// processes.go — current-state process inventory, aggregated by program name.
//
// Cross-platform via gopsutil/v3/process (no build tags needed). The agent
// reports ONE row per program name with instances summed, matching the server's
// AssetProcess model (pinning is by name, so the table is name-keyed). The
// per-pinned-program time-series (Feature C) samples instantaneous CPU; this
// inventory snapshot reports the MEAN CPU since the previous inventory scrape
// (intervalCPUPct over each PID's cumulative CPU time) — no sampling sleep, and
// unlike gopsutil's CPUPercent (average since the process STARTED) it answers
// "what is using the CPU now": a month-old service that began spinning ten
// minutes ago ranks at the top rather than near zero. That ranking is what the
// high-CPU alert email's top-5 list is read from. The first scrape after the
// agent starts carries no CPU (no baseline yet).
package collectors

import (
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"github.com/polaris/agent/internal/transport"
)

// msecToRFC3339 converts gopsutil CreateTime (ms since the Unix epoch) to
// RFC3339Nano UTC. 0/negative → "".
func msecToRFC3339(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.Unix(ms/1000, (ms%1000)*1_000_000).UTC().Format(time.RFC3339Nano)
}

// procRaw is one PID's reading before aggregation. Exported field names keep
// aggregateByName unit-testable without a live process table.
type procRaw struct {
	Pid         int32
	Name        string
	CPUPct      float64
	HasCPU      bool // false: no interval rate for this PID yet (see intervalCPUPct)
	RSSBytes    uint64
	Username    string
	Exe         string
	CreateMsec  int64  // process start, ms since epoch (gopsutil CreateTime)
	ServiceUnit string // resolved Windows service / systemd unit (Phase 4); "" if none
}

// Per-PID CPU baselines from the previous inventory scrape (intervalCPUPct).
var (
	procCPUMu   sync.Mutex
	procCPUPrev map[string]cpuBaseline
)

// ProcessInventoryOnce enumerates running processes and returns one aggregated
// sample per program name. Returns nil if the process table can't be read.
func ProcessInventoryOnce() []*transport.ProcessSample {
	procs, err := process.Processes()
	if err != nil {
		return nil
	}
	now := time.Now()
	procCPUMu.Lock()
	prev := procCPUPrev
	procCPUMu.Unlock()
	next := make(map[string]cpuBaseline, len(procs))
	raws := make([]procRaw, 0, len(procs))
	pids := make([]int32, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			continue
		}
		r := procRaw{Pid: p.Pid, Name: name}
		if ct, err := p.CreateTime(); err == nil {
			r.CreateMsec = ct
		}
		if t, err := p.Times(); err == nil && t != nil {
			id := strconv.Itoa(int(p.Pid))
			key := id + ":" + strconv.FormatInt(r.CreateMsec, 10)
			sec := t.User + t.System
			next[id] = cpuBaseline{cpuSec: sec, key: key, at: now}
			if pct, ok := intervalCPUPct(prev, id, key, sec, now); ok {
				r.CPUPct, r.HasCPU = pct, true
			}
		}
		if mi, err := p.MemoryInfo(); err == nil && mi != nil {
			r.RSSBytes = mi.RSS
		}
		if u, err := p.Username(); err == nil {
			r.Username = u
		}
		if exe, err := p.Exe(); err == nil {
			r.Exe = exe
		}
		raws = append(raws, r)
		pids = append(pids, p.Pid)
	}
	procCPUMu.Lock()
	procCPUPrev = next
	procCPUMu.Unlock()
	// Resolve the backing service/unit per PID (Phase 4 control). Batch call —
	// Linux reads /proc/<pid>/cgroup; Windows parses one `tasklist /svc`; other
	// OSes return an empty map. Best-effort; "" → not controllable.
	units := resolveServiceUnits(pids)
	if len(units) > 0 {
		for i := range raws {
			if u, ok := units[raws[i].Pid]; ok {
				raws[i].ServiceUnit = u
			}
		}
	}
	return aggregateByName(raws)
}

// aggregateByName collapses per-PID readings into one sample per program name:
// instanceCount = number of PIDs, cpuPct/memRssBytes summed, the earliest
// CreateTime kept, and a representative (first non-empty) exe + username. A
// program none of whose PIDs has a CPU rate yet reports no cpuPct (nil, not 0 —
// "not measured" must not read as "idle"). Pure + deterministic (output sorted
// by summed CPU desc then name) so it's straightforward to unit-test.
func aggregateByName(raws []procRaw) []*transport.ProcessSample {
	type agg struct {
		count       int
		cpu         float64
		hasCPU      bool
		rss         uint64
		exe         string
		username    string
		serviceUnit string
		createMsec  int64
		hasCreate   bool
	}
	byName := make(map[string]*agg)
	order := make([]string, 0)
	for _, r := range raws {
		a := byName[r.Name]
		if a == nil {
			a = &agg{}
			byName[r.Name] = a
			order = append(order, r.Name)
		}
		a.count++
		if r.HasCPU {
			a.cpu += r.CPUPct
			a.hasCPU = true
		}
		a.rss += r.RSSBytes
		if a.exe == "" && r.Exe != "" {
			a.exe = r.Exe
		}
		if a.username == "" && r.Username != "" {
			a.username = r.Username
		}
		if a.serviceUnit == "" && r.ServiceUnit != "" {
			a.serviceUnit = r.ServiceUnit
		}
		if r.CreateMsec > 0 && (!a.hasCreate || r.CreateMsec < a.createMsec) {
			a.createMsec = r.CreateMsec
			a.hasCreate = true
		}
	}

	out := make([]*transport.ProcessSample, 0, len(order))
	for _, name := range order {
		a := byName[name]
		s := &transport.ProcessSample{
			Name:          name,
			InstanceCount: a.count,
		}
		if a.hasCPU {
			cpu := a.cpu
			s.CpuPct = &cpu
		}
		rss := a.rss
		s.MemRssBytes = &rss
		if a.exe != "" {
			exe := a.exe
			s.ExePath = &exe
		}
		if a.username != "" {
			u := a.username
			s.Username = &u
		}
		if a.serviceUnit != "" {
			su := a.serviceUnit
			s.ServiceUnit = &su
		}
		if a.hasCreate {
			ts := msecToRFC3339(a.createMsec)
			s.StartedAt = &ts
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ci, cj := derefF(out[i].CpuPct), derefF(out[j].CpuPct)
		if ci != cj {
			return ci > cj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func derefF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
