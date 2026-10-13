// interfaces.go — per-NIC counters + link state, one row per interface.
//
// Counters come from gopsutil/net (/proc/net/dev on Linux, the IP Helper
// API on Windows). The IP/MAC association comes from net.Interfaces (Go
// stdlib) since gopsutil's IOCounters list doesn't carry it. Link state,
// negotiated speed and duplex come from readLinkInfo, which is per-OS:
// /sys/class/net/<ifname> on Linux, GetIfEntry2Ex + MSFT_NetAdapter on
// Windows (interfaces_linux.go / interfaces_windows.go). Elsewhere it
// reports nothing and the admin-status heuristic below stands.
//
// Loopback + down-administratively interfaces are still emitted —
// operators want to see them in the System tab table, and the
// "Poll 1m" pinning feature relies on the row existing.
package collectors

import (
	"net"
	"strings"
	"time"

	psnet "github.com/shirou/gopsutil/v3/net"

	"github.com/polaris/agent/internal/transport"
)

// InterfacesOnce enumerates every NIC and emits one sample row per
// interface. ifType heuristic is "loopback" for lo / Loopback*, else
// "physical" — gopsutil doesn't distinguish virtual from physical
// without an OS-specific probe, and the System tab UI groups by
// adminStatus/operStatus more than by ifType.
func InterfacesOnce() []*transport.InterfaceSample {
	ts := time.Now().UTC().Format(time.RFC3339Nano)

	// Counters keyed by ifName.
	counters, err := psnet.IOCounters(true) // perNic=true → one row per NIC
	if err != nil {
		return nil
	}

	// IP+MAC map keyed by ifName (Go stdlib net.Interfaces gives us
	// these; gopsutil's IOCounters does not).
	type ifMeta struct {
		mac   string
		ip    string
		admin string
		index int
		flags net.Flags
	}
	meta := make(map[string]ifMeta)
	var indexes []int
	if ifaces, err := net.Interfaces(); err == nil {
		for _, ifc := range ifaces {
			m := ifMeta{flags: ifc.Flags, index: ifc.Index}
			indexes = append(indexes, ifc.Index)
			if hwa := ifc.HardwareAddr.String(); hwa != "" {
				m.mac = hwa
			}
			if (ifc.Flags & net.FlagUp) != 0 {
				m.admin = "up"
			} else {
				m.admin = "down"
			}
			// First non-loopback IPv4, fall back to first IPv6.
			if addrs, err := ifc.Addrs(); err == nil {
				var fallback string
				for _, a := range addrs {
					ipStr := stripCIDR(a.String())
					ip := net.ParseIP(ipStr)
					if ip == nil {
						continue
					}
					if ip.To4() != nil && !ip.IsLoopback() {
						m.ip = ipStr
						break
					}
					if fallback == "" {
						fallback = ipStr
					}
				}
				if m.ip == "" {
					m.ip = fallback
				}
			}
			meta[ifc.Name] = m
		}
	}

	// One batched read of link state for every NIC (Windows needs a single
	// WMI query for duplex rather than one per interface).
	links := readLinkInfo(indexes)

	out := make([]*transport.InterfaceSample, 0, len(counters))
	for _, c := range counters {
		in := c.BytesRecv
		on := c.BytesSent
		ie := c.Errin
		oe := c.Errout
		s := &transport.InterfaceSample{
			Timestamp: ts,
			IfName:    c.Name,
			InOctets:  &in,
			OutOctets: &on,
			InErrors:  &ie,
			OutErrors: &oe,
		}
		if m, ok := meta[c.Name]; ok {
			if m.mac != "" {
				mac := m.mac
				s.MACAddress = &mac
			}
			if m.ip != "" {
				ip := m.ip
				s.IPAddress = &ip
			}
			admin := m.admin
			s.AdminStatus = &admin
			// operStatus fallback heuristic: admin=up ≈ operational, used
			// where readLinkInfo has no carrier reading for this NIC.
			oper := "down"
			if admin == "up" {
				oper = "up"
			}
			if li, ok := links.lookup(c.Name, m.index); ok {
				if li.oper != "" {
					oper = li.oper
				}
				// Speed and duplex only describe a link that is up: a
				// disconnected NIC reports its last or maximum rate.
				if oper == "up" {
					if li.speedBps > 0 {
						sp := li.speedBps
						s.SpeedBps = &sp
					}
					if li.duplex == "full" || li.duplex == "half" {
						d := li.duplex
						s.Duplex = &d
					}
				}
			}
			s.OperStatus = &oper
		}
		t := classifyIfType(c.Name)
		s.IfType = &t
		out = append(out, s)
	}
	return out
}

// linkInfo is one NIC's OS-reported link state. Empty oper means "no
// carrier reading" (keep the heuristic); zero speedBps and empty duplex
// mean unknown.
type linkInfo struct {
	oper     string // IF-MIB vocabulary: "up" | "down" | "lowerLayerDown" | ...
	speedBps uint64
	duplex   string // "full" | "half" | ""
}

// linkTable holds readLinkInfo's answer, keyed whichever way the OS
// identifies a NIC: Linux by name, Windows by interface index.
type linkTable struct {
	byName  map[string]linkInfo
	byIndex map[int]linkInfo
}

func (t linkTable) lookup(name string, index int) (linkInfo, bool) {
	if li, ok := t.byName[name]; ok {
		return li, true
	}
	if index > 0 {
		if li, ok := t.byIndex[index]; ok {
			return li, true
		}
	}
	return linkInfo{}, false
}

func classifyIfType(name string) string {
	n := strings.ToLower(name)
	if n == "lo" || strings.HasPrefix(n, "loopback") || strings.HasPrefix(n, "lo0") {
		return "loopback"
	}
	if strings.HasPrefix(n, "tun") || strings.HasPrefix(n, "tap") ||
		strings.HasPrefix(n, "wg") || strings.HasPrefix(n, "utun") {
		return "tunnel"
	}
	return "physical"
}

// stripCIDR turns "192.0.2.1/24" or "fe80::1/64" into the address half.
// net.Addr.String() formats are predictable enough that a simple split
// suffices; IPv6 zones ("fe80::1%eth0") are stripped too.
func stripCIDR(s string) string {
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '%'); i >= 0 {
		s = s[:i]
	}
	return s
}
