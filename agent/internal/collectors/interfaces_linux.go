//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const sysClassNet = "/sys/class/net"

// readLinkInfo reads carrier state, negotiated speed and duplex for every
// NIC under /sys/class/net. The index list is unused: sysfs is keyed by
// name. Unreadable attributes are simply left unknown — the kernel returns
// EINVAL for speed/duplex on a link that is down, and virtual devices
// (bridges, tun, veth) often don't implement them at all.
func readLinkInfo(_ []int) linkTable {
	t := linkTable{byName: map[string]linkInfo{}}
	entries, err := os.ReadDir(sysClassNet)
	if err != nil {
		return t
	}
	for _, e := range entries {
		t.byName[e.Name()] = readSysfsLink(filepath.Join(sysClassNet, e.Name()))
	}
	return t
}

func readSysfsLink(dir string) linkInfo {
	return parseSysfsLink(
		readSysfsAttr(filepath.Join(dir, "operstate")),
		readSysfsAttr(filepath.Join(dir, "carrier")),
		readSysfsAttr(filepath.Join(dir, "speed")),
		readSysfsAttr(filepath.Join(dir, "duplex")),
	)
}

func readSysfsAttr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// parseSysfsLink turns the raw sysfs attribute strings into a linkInfo.
// Pure so it can be tested without a /sys tree.
//
// operstate follows RFC 2863 in lower case. "unknown" is what loopback,
// tun and many virtual drivers report permanently, so it falls through to
// the carrier file; with no carrier reading either, oper stays empty and
// the caller keeps its admin-status heuristic. speed is in Mb/s and is -1
// (or absent) when the driver doesn't know.
func parseSysfsLink(operstate, carrier, speed, duplex string) linkInfo {
	var li linkInfo
	switch strings.ToLower(operstate) {
	case "up":
		li.oper = "up"
	case "down":
		li.oper = "down"
	case "lowerlayerdown":
		li.oper = "lowerLayerDown"
	case "notpresent":
		li.oper = "notPresent"
	case "dormant":
		li.oper = "dormant"
	case "testing":
		li.oper = "testing"
	default:
		switch carrier {
		case "1":
			li.oper = "up"
		case "0":
			li.oper = "down"
		}
	}
	if mbps, err := strconv.ParseInt(speed, 10, 64); err == nil && mbps > 0 {
		li.speedBps = uint64(mbps) * 1_000_000
	}
	switch strings.ToLower(duplex) {
	case "full":
		li.duplex = "full"
	case "half":
		li.duplex = "half"
	}
	return li
}
