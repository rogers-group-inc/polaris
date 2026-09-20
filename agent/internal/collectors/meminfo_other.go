//go:build !windows

package collectors

import "github.com/shirou/gopsutil/v3/mem"

// platformCacheBytes: on Linux gopsutil already fills VirtualMemoryStat.Cached
// from /proc/meminfo (with SReclaimable folded in, matching `free -h`), and on
// macOS there is no cache counter to substitute — Inactive is the nearest
// analogue and gopsutil reports it in the same struct. Either way there is
// nothing for this hook to override, so it returns 0 and memBreakdownFrom
// keeps gopsutil's own figure.
func platformCacheBytes() uint64 { return 0 }

// platformSwapBytes: mem.SwapMemory() means what it says off Windows —
// /proc/meminfo SwapTotal/SwapFree on Linux, sysctl vm.swapusage on macOS.
// A host with swap off reports a total of 0, which is a real answer.
func platformSwapBytes() (used uint64, total uint64, ok bool) {
	sm, err := mem.SwapMemory()
	if err != nil {
		return 0, 0, false
	}
	return sm.Used, sm.Total, true
}
