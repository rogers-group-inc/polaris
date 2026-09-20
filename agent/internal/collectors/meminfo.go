// meminfo.go — the memory BREAKDOWN, reconciled into four bands that always
// sum to the physical total, plus swap / page file.
//
// Why the agent does the reconciling and not the chart: every OS counts
// memory differently, and the differences are not cosmetic.
//
//	Linux    /proc/meminfo gives Buffers and Cached directly, and gopsutil's
//	         Used is already Total-Free-Buffers-Cached — i.e. the resident
//	         process figure we want. Cached has SReclaimable folded in by
//	         gopsutil, which is the reading `free -h` shows too.
//	Windows  GlobalMemoryStatusEx has no notion of cache at all: its
//	         Available is free + standby, so gopsutil's Used (Total-Available)
//	         is a process figure, but the cache inside Available is invisible.
//	         The standby/system-cache size only comes from GetPerformanceInfo
//	         (SystemCache), which gopsutil reads for SwapMemory and then
//	         throws away — hence meminfo_windows.go.
//	macOS    No cache figure; Inactive is the closest analogue and is what
//	         Activity Monitor rolls into "cached files".
//
// If the chart tried to absorb that, every band would need a per-OS branch in
// the browser and a Windows host would quietly plot a cache band of zero
// while a third of its RAM sat in standby. So the contract is settled here:
//
//	Used + Buffers + Cached + Free == Total, exactly, always.
//
// `Ok` is false when the platform could not produce a breakdown at all; the
// caller then sends the plain used/total pair it always sent and the chart
// falls back to a single line.
package collectors

import "github.com/shirou/gopsutil/v3/mem"

// MemBreakdown is the four-band physical split plus backing store. All values
// are bytes. Swap is NOT part of the four-band sum — it is a separate device.
type MemBreakdown struct {
	Ok        bool
	Total     uint64
	Used      uint64 // resident in processes
	Buffers   uint64 // Linux block-layer buffers; 0 elsewhere
	Cached    uint64 // page cache (Linux) / system cache (Windows) / inactive (macOS)
	Free      uint64 // the remainder, derived so the four bands close on Total
	SwapOk    bool
	SwapUsed  uint64
	SwapTotal uint64
}

// memBreakdownFrom folds a gopsutil VirtualMemoryStat plus a
// platform-supplied cache figure into the four bands.
//
// `cacheOverride` is the platform's own cache reading when gopsutil does not
// fill Cached (Windows); pass 0 to keep whatever gopsutil reported. The
// clamping below is not defensive noise — the readings come from separate
// syscalls taken microseconds apart on a live system, so Used+Buffers+Cached
// genuinely can exceed Total by a page or two, and an unclamped subtraction
// would underflow uint64 into a ~16-exabyte Free band.
func memBreakdownFrom(vm *mem.VirtualMemoryStat, cacheOverride uint64) MemBreakdown {
	if vm == nil || vm.Total == 0 {
		return MemBreakdown{}
	}
	b := MemBreakdown{Ok: true, Total: vm.Total}

	b.Buffers = vm.Buffers
	b.Cached = vm.Cached
	if cacheOverride > 0 {
		b.Cached = cacheOverride
	}
	b.Used = vm.Used

	// Trim from the outside in so the bands close on Total. Used is trimmed
	// last: an over-reported cache should never inflate the process band,
	// which is the number an operator acts on.
	if b.Used > b.Total {
		b.Used = b.Total
	}
	remaining := b.Total - b.Used
	if b.Buffers > remaining {
		b.Buffers = remaining
	}
	remaining -= b.Buffers
	if b.Cached > remaining {
		b.Cached = remaining
	}
	remaining -= b.Cached
	b.Free = remaining

	return b
}

// MemBreakdownOnce takes one reading. Best-effort throughout: a platform that
// cannot answer returns Ok=false rather than a half-filled struct, because a
// cache band of zero is indistinguishable from "this host caches nothing" on
// the chart and the second reading is a lie.
func MemBreakdownOnce() MemBreakdown {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return MemBreakdown{}
	}
	b := memBreakdownFrom(vm, platformCacheBytes())

	// Swap / page file. Independent of the physical breakdown — a host with
	// no swap configured reports a total of 0, which is a fact worth sending
	// (the chart draws no swap line rather than an empty one).
	if su, st, ok := platformSwapBytes(); ok {
		b.SwapOk, b.SwapUsed, b.SwapTotal = true, su, st
	}
	return b
}
