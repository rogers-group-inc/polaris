// telemetry.go — CPU% (aggregate AND per-core) + memory bytes per sample.
//
// Cross-platform via gopsutil: works the same on Linux (/proc/stat +
// /proc/meminfo), macOS (host_statistics + sysctl), and Windows
// (GetSystemTimes + GlobalMemoryStatusEx). Memory and temperatures are read
// instantaneously; CPU covers the span since the previous pass (below). The
// server stores each row in a time-series and the System tab renders the
// chart.
//
// CPU% is measured across the WHOLE cadence — the delta of the kernel's
// cumulative per-core counters since the previous pass — and reported TWICE:
// the cross-core aggregate (cpuPct, which every other transport also reports
// and which every threshold and automation reads) and the per-logical-core
// vector (cpuCorePcts, agent-only). One counter read produces both, so the
// aggregate a threshold fires on always describes the same span as the cores
// drawn beside it. The span, the fallbacks and why this is NOT a 1-second
// blocking window any more are in cputimes.go — the short version is that a
// 1 s slice of every 60 measured the agent's own collectors rather than the
// host whenever one of them overran into it, which on a single-vCPU VM is
// the difference between 3% and 100%.
//
// Memory: the plain used/total pair every source sends, PLUS the four-band
// breakdown (process / buffers / cache / free) and swap. The per-OS
// reconciliation lives in meminfo.go — see the header there for why it is
// the agent's job and not the chart's.
//
// Temperatures: gopsutil.host.SensorsTemperatures works on Linux
// (thermal_zone* + hwmon), macOS (smc, when accessible), and is a
// no-op on Windows (returns ErrNotImplementedError) — we treat the
// no-op the same as "no sensors available" and emit no temperature
// rows in that case.
package collectors

import (
	"math"
	"time"

	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"

	"github.com/polaris/agent/internal/transport"
)

// maxReportedCores caps the per-core vector. The server's Zod schema refuses
// anything longer, and a host with more logical CPUs than this is far past
// the point where 512 coloured lines say anything a chart can be read for —
// the aggregate is still reported in full, so nothing is lost but the
// per-core detail that was already unreadable.
const maxReportedCores = 512

// round1 keeps one decimal. A CPU percentage carries no meaningful precision
// past that, and at 64 cores a minute the difference between 1 and 14
// significant digits is most of the row's stored size.
func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}

// TelemetryOnce takes one CPU+memory snapshot plus available
// temperatures and shapes it for the server. Returns a single sample
// row; the caller wraps it in a SamplesBody and pushes.
func TelemetryOnce() *transport.TelemetrySample {
	sample := &transport.TelemetrySample{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}

	// CPU% — one non-blocking counter read covering everything since the
	// previous pass. The aggregate comes back computed over EVERY core,
	// including any past the report cap, so it keeps meaning "this host's
	// CPU" no matter how the vector below is truncated.
	if per, agg, ok := hostCPUPercents(); ok && len(per) > 0 {
		cores := make([]float64, 0, len(per))
		for i, v := range per {
			if i >= maxReportedCores {
				break
			}
			cores = append(cores, round1(v))
		}
		a := round1(agg)
		sample.CPUPct = &a
		sample.CPUCorePcts = cores
	}

	// Memory bytes. We send both pct AND used/total — the server
	// schema accepts either form, and the System tab chart prefers
	// pct when both are present.
	if vm, err := mem.VirtualMemory(); err == nil {
		p := round1(vm.UsedPercent)
		sample.MemPct = &p
		used := vm.Used
		total := vm.Total
		sample.MemUsedBytes = &used
		sample.MemTotalBytes = &total
	}

	// Memory breakdown + swap. Independent of the block above: a platform
	// that can report used/total but not the bands sends the pair alone and
	// the chart draws one line, exactly as it did before this existed.
	if b := MemBreakdownOnce(); b.Ok {
		// Re-send used/total from the breakdown so the four bands the chart
		// stacks are guaranteed to close on the total it scales the axis to.
		// Taking them from the VirtualMemory() call above instead would mix
		// two readings and leave a visible sliver of unaccounted memory.
		used, total := b.Used, b.Total
		buffers, cached, free := b.Buffers, b.Cached, b.Free
		sample.MemUsedBytes = &used
		sample.MemTotalBytes = &total
		sample.MemBuffersBytes = &buffers
		sample.MemCachedBytes = &cached
		sample.MemFreeBytes = &free
		if b.SwapOk {
			su, st := b.SwapUsed, b.SwapTotal
			sample.SwapUsedBytes = &su
			sample.SwapTotalBytes = &st
		}
	}

	// Temperatures. Best-effort — many hosts don't expose sensors
	// (cloud VMs, containers, hardened bare-metal). Errors and
	// empty arrays both land as "no temperatures" silently.
	if temps, err := host.SensorsTemperatures(); err == nil {
		for _, t := range temps {
			if t.SensorKey == "" || t.Temperature == 0 {
				continue
			}
			c := t.Temperature
			sample.Temperatures = append(sample.Temperatures, transport.TelemetryTemperature{
				SensorName: t.SensorKey,
				Celsius:    &c,
			})
		}
	}

	return sample
}
