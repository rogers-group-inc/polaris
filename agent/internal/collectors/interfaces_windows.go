//go:build windows

package collectors

import (
	"github.com/yusufpapurcu/wmi"
	"golang.org/x/sys/windows"
)

// msftNetAdapter is the slice of root\StandardCimv2 MSFT_NetAdapter we
// read. FullDuplex is a pointer because WMI returns NULL for adapters that
// don't report it (virtual switches, some Wi-Fi drivers).
type msftNetAdapter struct {
	InterfaceIndex uint32
	FullDuplex     *bool
}

// readLinkInfo reads oper status and negotiated speed per interface index
// from the IP Helper API (GetIfEntry2Ex — one cheap syscall per NIC), and
// duplex for all of them from ONE MSFT_NetAdapter WMI query, because the
// IP Helper row carries no duplex. A failed WMI query only loses duplex.
func readLinkInfo(indexes []int) linkTable {
	t := linkTable{byIndex: map[int]linkInfo{}}
	for _, idx := range indexes {
		if idx <= 0 {
			continue
		}
		row := windows.MibIfRow2{InterfaceIndex: uint32(idx)}
		if err := windows.GetIfEntry2Ex(windows.MibIfEntryNormalWithoutStatistics, &row); err != nil {
			continue
		}
		t.byIndex[idx] = linkInfo{
			oper:     windowsOperStatus(row.OperStatus),
			speedBps: windowsLinkSpeed(row.TransmitLinkSpeed),
		}
	}

	var adapters []msftNetAdapter
	q := "SELECT InterfaceIndex, FullDuplex FROM MSFT_NetAdapter"
	if err := wmi.QueryNamespace(q, &adapters, `root\StandardCimv2`); err == nil {
		for _, a := range adapters {
			li, ok := t.byIndex[int(a.InterfaceIndex)]
			if !ok || a.FullDuplex == nil {
				continue
			}
			if *a.FullDuplex {
				li.duplex = "full"
			} else {
				li.duplex = "half"
			}
			t.byIndex[int(a.InterfaceIndex)] = li
		}
	}
	return t
}

// windowsOperStatus maps IF_OPER_STATUS (the same RFC 2863 numbering as
// IF-MIB ifOperStatus) onto the strings the server stores.
func windowsOperStatus(s uint32) string {
	switch s {
	case windows.IfOperStatusUp:
		return "up"
	case windows.IfOperStatusDown:
		return "down"
	case windows.IfOperStatusTesting:
		return "testing"
	case windows.IfOperStatusDormant:
		return "dormant"
	case windows.IfOperStatusNotPresent:
		return "notPresent"
	case windows.IfOperStatusLowerLayerDown:
		return "lowerLayerDown"
	default:
		return "" // unknown — keep the heuristic
	}
}

// windowsLinkSpeed drops the "unknown" sentinels: 0 and all-ones (the
// documented NDIS_LINK_SPEED_UNKNOWN).
func windowsLinkSpeed(bps uint64) uint64 {
	if bps == ^uint64(0) {
		return 0
	}
	return bps
}
