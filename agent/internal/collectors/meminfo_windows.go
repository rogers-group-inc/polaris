//go:build windows

package collectors

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows has no /proc/meminfo, and the API gopsutil uses for VirtualMemory
// (GlobalMemoryStatusEx) reports no cache figure at all — its ullAvailPhys
// folds free and standby together, so the standby cache is invisible. The
// cache size lives in PERFORMANCE_INFORMATION.SystemCache, which gopsutil
// reads inside SwapMemory and then discards, so we call GetPerformanceInfo
// ourselves.
//
// Note SystemCache is in PAGES, like every other count in this struct, and
// PageSize is the multiplier. Treating it as bytes reports a ~4096x cache
// and clamps the whole breakdown to "all cache" on the chart.
var (
	modpsapi                  = windows.NewLazySystemDLL("psapi.dll")
	procGetPerformanceInfoLoc = modpsapi.NewProc("GetPerformanceInfo")
)

// performanceInformation mirrors PERFORMANCE_INFORMATION. Field order and
// widths are load-bearing — the struct is filled by the kernel and `cb` must
// equal its exact size or the call fails.
type performanceInformation struct {
	cb                uint32
	commitTotal       uint64
	commitLimit       uint64
	commitPeak        uint64
	physicalTotal     uint64
	physicalAvailable uint64
	systemCache       uint64
	kernelTotal       uint64
	kernelPaged       uint64
	kernelNonpaged    uint64
	pageSize          uint64
	handleCount       uint32
	processCount      uint32
	threadCount       uint32
}

func perfInfo() (*performanceInformation, bool) {
	var pi performanceInformation
	pi.cb = uint32(unsafe.Sizeof(pi))
	r, _, _ := procGetPerformanceInfoLoc.Call(uintptr(unsafe.Pointer(&pi)), uintptr(pi.cb))
	if r == 0 || pi.pageSize == 0 {
		return nil, false
	}
	return &pi, true
}

// platformCacheBytes returns the Windows system (standby) cache in bytes.
func platformCacheBytes() uint64 {
	pi, ok := perfInfo()
	if !ok {
		return 0
	}
	return pi.systemCache * pi.pageSize
}

// platformSwapBytes returns PAGE FILE usage — deliberately not gopsutil's
// mem.SwapMemory(), which on Windows returns the COMMIT CHARGE (commitTotal
// against commitLimit). Commit charge counts every private committed page
// whether or not it was ever written to disk, so on a healthy host with a
// small page file it routinely reads several GB "swapped" while the page
// file is nearly empty. An operator reading a page-file line wants the file.
//
// EnumPageFiles walks the actual page files; a host configured with none
// returns an empty list, which is a real answer (total 0), not a failure.
func platformSwapBytes() (used uint64, total uint64, ok bool) {
	devs, err := swapDevices()
	if err != nil {
		return 0, 0, false
	}
	for _, d := range devs {
		used += d.used
		total += d.used + d.free
	}
	return used, total, true
}

type pageFile struct{ used, free uint64 }

type enumPageFileInformation struct {
	cb         uint32
	reserved   uint32
	totalSize  uint64
	totalInUse uint64
	peakUsage  uint64
}

var procEnumPageFilesW = modpsapi.NewProc("EnumPageFilesW")

func swapDevices() ([]pageFile, error) {
	pi, ok := perfInfo()
	if !ok {
		return nil, windows.GetLastError()
	}
	pageSize := pi.pageSize

	var out []pageFile
	// EnumPageFilesW invokes the callback once per page file before
	// returning, so `out` is fully populated by the time Call returns and
	// needs no synchronisation.
	cb := windows.NewCallback(func(ctx *[]pageFile, info *enumPageFileInformation, _ uintptr) uintptr {
		*ctx = append(*ctx, pageFile{
			used: info.totalInUse * pageSize,
			free: (info.totalSize - info.totalInUse) * pageSize,
		})
		return 1 // keep enumerating
	})
	r, _, _ := procEnumPageFilesW.Call(cb, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, windows.GetLastError()
	}
	return out, nil
}
