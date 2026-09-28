// services.go — current-state service inventory (systemd units on Linux,
// Windows services via SCM). The service DIMENSION: unlike the process
// inventory (keyed by program name, so a Spring Boot app shows up as "java"),
// this enumerates UNITS as first-class entities, so a service backed by a
// shared runtime is visible as itself and oneshot/exited units with no live
// process still appear.
//
// Platform-specific enumeration lives in the build-tagged files
// (services_linux.go / services_windows.go / services_other.go); this file is
// just the exported entry point + shared shaping. The server full-replaces the
// asset's rows per push (persistAssetServices, delete-replace) and derives
// `controllable` from the platform + load state, so the agent only reports raw
// facts.
package collectors

import (
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"github.com/polaris/agent/internal/transport"
)

// unitDetail is the MainPID + memory + CPU triple pulled from `systemctl show`.
// Lives here (untagged) alongside its pure parser so both are unit-testable on
// any OS; the Linux collector is its only real caller.
type unitDetail struct {
	mainPid  int
	memBytes uint64
	hasMem   bool
	cpuNsec  uint64 // CPUUsageNSec — cumulative, whole cgroup
	hasCPU   bool
}

// serviceRaw is one platform-collected service row plus the cumulative CPU
// counter behind it, before the interval rate is derived. cpuKey names what the
// counter measures (a cgroup + its main PID, or a PID + its start time); when
// it changes between scrapes the service restarted and the baseline is dropped
// rather than differenced against a different process.
type serviceRaw struct {
	sample *transport.ServiceSample
	cpuSec float64
	hasCPU bool
	cpuKey string
}

// cpuBaseline is the previous scrape's counter for one unit.
type cpuBaseline struct {
	cpuSec float64
	key    string
	at     time.Time
}

var (
	svcCPUMu   sync.Mutex
	svcCPUPrev map[string]cpuBaseline

	// Unit → DisplayName from the latest inventory. The Windows service-log
	// reader matches Service Control Manager entries by display name (that is
	// what SCM writes into param1), and the log loop only knows the pinned
	// short names.
	svcNamesMu      sync.RWMutex
	svcDisplayNames map[string]string
)

// applyServiceCPURates sets each row's CpuPct to the mean CPU over the span
// since the previous scrape — an interval mean, never a point sample, so a
// service that bursts between scrapes is still counted. 100 = one core, the
// convention the process rows in the same table use. A row with no baseline
// (first scrape, newly started, or restarted — cpuKey changed) and a counter
// that went backwards both stay nil. Returns the baselines for the next scrape.
// Pure given its inputs.
func applyServiceCPURates(rows []serviceRaw, prev map[string]cpuBaseline, now time.Time) map[string]cpuBaseline {
	next := make(map[string]cpuBaseline, len(rows))
	for _, r := range rows {
		if !r.hasCPU {
			continue
		}
		unit := r.sample.Unit
		next[unit] = cpuBaseline{cpuSec: r.cpuSec, key: r.cpuKey, at: now}
		if pct, ok := intervalCPUPct(prev, unit, r.cpuKey, r.cpuSec, now); ok {
			r.sample.CpuPct = &pct
		}
	}
	return next
}

// intervalCPUPct is the rate rule the service AND process inventories share:
// the CPU seconds spent since id's previous baseline over the wall time between
// them, ×100 (100 = one core). false when there is no baseline, it measured a
// different process (key changed — a restart or a reused PID), or the counter
// went backwards. Pure.
func intervalCPUPct(prev map[string]cpuBaseline, id, key string, cpuSec float64, now time.Time) (float64, bool) {
	p, ok := prev[id]
	if !ok || p.key != key {
		return 0, false
	}
	wall := now.Sub(p.at).Seconds()
	d := cpuSec - p.cpuSec
	if wall <= 0 || d < 0 {
		return 0, false
	}
	return d / wall * 100, true
}

// pidStat is what the service collectors read from one PID: its program name,
// resident memory (the working set on Windows) and cumulative CPU seconds.
type pidStat struct {
	name   string
	rss    uint64
	hasRSS bool
	cpuSec float64
	cpuKey string // "pid:<pid>:<start ms>" — a reused PID reads as a new process
	hasCPU bool
}

// readPidStat reads one PID via gopsutil. Each field is best-effort: a PID the
// agent may not open (a protected process) yields an empty stat, never an error.
func readPidStat(pid int32) pidStat {
	var st pidStat
	p, err := process.NewProcess(pid)
	if err != nil {
		return st
	}
	if n, err := p.Name(); err == nil {
		st.name = n
	}
	if mi, err := p.MemoryInfo(); err == nil && mi != nil {
		st.rss, st.hasRSS = mi.RSS, true
	}
	if t, err := p.Times(); err == nil && t != nil {
		ct, _ := p.CreateTime()
		st.cpuSec = t.User + t.System
		st.cpuKey = "pid:" + strconv.Itoa(int(pid)) + ":" + strconv.FormatInt(ct, 10)
		st.hasCPU = true
	}
	return st
}

// pidCPUSeconds is readPidStat's CPU half, for the systemd fallback when the
// unit's cgroup is not CPU-accounted.
func pidCPUSeconds(pid int32) (float64, string, bool) {
	st := readPidStat(pid)
	return st.cpuSec, st.cpuKey, st.hasCPU
}

// rememberServiceDisplayNames records unit → DisplayName for serviceDisplayName.
func rememberServiceDisplayNames(rows []*transport.ServiceSample) {
	m := make(map[string]string, len(rows))
	for _, s := range rows {
		if s.DisplayName != nil && *s.DisplayName != "" {
			m[s.Unit] = *s.DisplayName
		}
	}
	svcNamesMu.Lock()
	svcDisplayNames = m
	svcNamesMu.Unlock()
}

// serviceDisplayName returns the unit's display name from the latest inventory
// ("" before the first scrape or for an unknown unit).
func serviceDisplayName(unit string) string {
	svcNamesMu.RLock()
	defer svcNamesMu.RUnlock()
	return svcDisplayNames[unit]
}

// sysdUnit is the load/active/sub/description tuple parsed from a
// `systemctl list-units` row. Untagged (like unitDetail) so its parser is
// unit-testable on any OS.
type sysdUnit struct {
	Load        string
	Active      string
	Sub         string
	Description string
}

// parseListUnits parses the PLAIN columnar output of
// `systemctl list-units --type=service --all --plain --no-legend`, one unit
// per line:
//
//	<unit> <load> <active> <sub> <description...>
//
// The first four columns are whitespace-free tokens; the description is the
// remainder of the line (may contain spaces). We deliberately parse the table
// form rather than `-o json`: systemctl only emits JSON for these list verbs
// from an interactive session — under a systemd service (how the agent runs)
// it silently falls back to this table format, so JSON parsing returns nothing.
// A leading status glyph ("●", printed for failed/degraded units when --plain
// is not honored) is tolerated. Only *.service rows are kept. Pure (no exec).
func parseListUnits(out string) map[string]sysdUnit {
	m := map[string]sysdUnit{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		// Drop a leading bullet ("●") that older/TTY output prefixes onto
		// failed-unit rows, so the column offsets line up regardless.
		if fields[0] == "●" {
			fields = fields[1:]
		}
		if len(fields) < 4 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		desc := ""
		if len(fields) > 4 {
			desc = strings.Join(fields[4:], " ")
		}
		m[fields[0]] = sysdUnit{Load: fields[1], Active: fields[2], Sub: fields[3], Description: desc}
	}
	return m
}

// parseListUnitFiles parses the PLAIN columnar output of
// `systemctl list-unit-files --type=service --no-legend`, one unit per line:
//
//	<unit-file> <state> [<preset>]
//
// Same rationale as parseListUnits (table form, not JSON). Returns unit → state.
func parseListUnitFiles(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		m[fields[0]] = fields[1]
	}
	return m
}

// parseShowUnits parses `systemctl show` output — blank-line-separated blocks of
// Key=Value lines, keyed by the Id property. Pure (unit-testable without exec).
// MainPID 0 → no main pid; MemoryCurrent / CPUUsageNSec uint64-max or
// non-numeric ("[not set]", accounting off) → unaccounted.
func parseShowUnits(out string) map[string]unitDetail {
	res := map[string]unitDetail{}
	for _, block := range strings.Split(out, "\n\n") {
		var id string
		var d unitDetail
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			switch k {
			case "Id":
				id = strings.TrimSpace(v)
			case "MainPID":
				if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
					d.mainPid = n
				}
			case "MemoryCurrent":
				// systemd reports uint64-max / "[not set]" when unaccounted.
				if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil && n != ^uint64(0) {
					d.memBytes = n
					d.hasMem = true
				}
			case "CPUUsageNSec":
				if n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64); err == nil && n != ^uint64(0) {
					d.cpuNsec = n
					d.hasCPU = true
				}
			}
		}
		if id != "" {
			res[id] = d
		}
	}
	return res
}

// ServiceInventoryOnce enumerates all loaded services/units and returns one
// sample per unit, sorted deterministically (by unit name) so a full-replace
// push is stable across scrapes. Returns nil when the platform has no service
// manager or enumeration fails (a nil push is a deliberate no-op server-side;
// an empty non-nil slice is a valid delete-only scrape).
//
// CPU is derived here, not per platform: each platform reports a cumulative
// counter and the rate is the difference against the previous scrape, so the
// first scrape after the agent starts carries no cpuPct.
func ServiceInventoryOnce() []*transport.ServiceSample {
	raws := serviceInventoryOnce()
	if raws == nil {
		return nil
	}
	now := time.Now()
	svcCPUMu.Lock()
	svcCPUPrev = applyServiceCPURates(raws, svcCPUPrev, now)
	svcCPUMu.Unlock()
	out := make([]*transport.ServiceSample, 0, len(raws))
	for _, r := range raws {
		out = append(out, r.sample)
	}
	rememberServiceDisplayNames(out)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Unit < out[j].Unit })
	return out
}
