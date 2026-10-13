//go:build !linux && !windows

package collectors

// readLinkInfo has no portable carrier/speed/duplex source on this OS, so
// it reports nothing and InterfacesOnce keeps its admin-status heuristic.
func readLinkInfo(_ []int) linkTable {
	return linkTable{}
}
