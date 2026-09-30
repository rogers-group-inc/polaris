// systeminfo.go — host identity payload (hostname / OS / DMI).
//
// One push channel separate from the four sample streams. The agent's
// observation of the host is authoritative for hostname / OS / vendor /
// model / serial — beats AD / Entra / Intune in the projection priority
// because those infer from inventory enrollment and can drift from what
// the host actually answers to right now.
//
// Cross-platform pieces (hostname, kernel, gopsutil host.Info) live in
// this file. Vendor / model / serial are read per-OS in companion files
// systeminfo_linux.go / _darwin.go / _windows.go since DMI/SMBIOS access
// is platform-specific (no portable gopsutil helper exposes them).
package collectors

import (
	"net"
	"os"
	"strings"
	"time"

	pshost "github.com/shirou/gopsutil/v3/host"
)

// SystemInfo is the wire shape sent to POST /api/v1/agents/system-info.
// Empty strings stripped by the caller before send (matches what the
// server's SystemInfoSchema and projection's truthy-check expect).
type SystemInfo struct {
	Hostname      string `json:"hostname,omitempty"`
	OS            string `json:"os,omitempty"`             // human-readable: "Red Hat Enterprise Linux 8.10"
	OSVersion     string `json:"osVersion,omitempty"`      // bare version: "8.10"
	KernelVersion string `json:"kernelVersion,omitempty"`  // "4.18.0-553.el8"
	KernelArch    string `json:"kernelArch,omitempty"`     // "x86_64"
	Manufacturer  string `json:"manufacturer,omitempty"`   // DMI sys_vendor
	Model         string `json:"model,omitempty"`          // DMI product_name
	SerialNumber  string `json:"serialNumber,omitempty"`   // DMI product_serial
	BiosVersion   string `json:"biosVersion,omitempty"`    // DMI bios_version
	PrimaryMAC    string `json:"primaryMac,omitempty"`
	PrimaryIP     string `json:"primaryIp,omitempty"`
	AgentVersion  string `json:"agentVersion,omitempty"`   // stamped by caller from main.version
}

// SystemInfoOnce snapshots the host's identity right now. agentVersion
// is passed in by the caller (main package owns the ldflag-stamped
// `version` var; collectors package doesn't import main).
func SystemInfoOnce(agentVersion string) *SystemInfo {
	info := &SystemInfo{
		AgentVersion: agentVersion,
	}

	if h, err := os.Hostname(); err == nil {
		info.Hostname = h
	}

	// gopsutil/host returns PlatformFamily ("rhel"), Platform ("redhat"),
	// PlatformVersion ("8.10"), KernelVersion, KernelArch in one call.
	// We craft the human-readable os string from these so the projection
	// can write something meaningful into Asset.os ("Red Hat Enterprise
	// Linux 8.10" beats the AD-stamped "redhat-linux-gnu").
	if h, err := pshost.Info(); err == nil {
		info.OS = formatHumanOS(h)
		info.OSVersion = h.PlatformVersion
		info.KernelVersion = h.KernelVersion
		info.KernelArch = h.KernelArch
	}

	// Vendor / model / serial / BIOS — per-OS implementation.
	if dmi := readPlatformDMI(); dmi != nil {
		info.Manufacturer = dmi.Manufacturer
		info.Model = dmi.Model
		// A vendor placeholder ("To Be Filled By O.E.M.", "Default string")
		// is reported as no serial at all, on every platform — /sys/class/dmi
		// hands these back as readily as SMBIOS does. See serialnumber.go for
		// why sending one is worse than sending nothing.
		info.SerialNumber = usableSerial(dmi.Serial)
		info.BiosVersion = dmi.BiosVersion
	}

	// Primary NIC (first non-loopback up interface with an IPv4).
	if mac, ip, ok := findPrimaryInterface(); ok {
		info.PrimaryMAC = mac
		info.PrimaryIP = ip
	}

	return info
}

// formatHumanOS converts gopsutil host.InfoStat into the readable string
// operators want to see in the Asset.os field. Each OS family has its
// own conventions:
//   - Linux distros expose /etc/os-release whose PRETTY_NAME we'd
//     prefer, but gopsutil collapses that to Platform + PlatformVersion.
//     Reconstruct: "Red Hat Enterprise Linux" + " 8.10" — close enough.
//   - macOS: Platform = "darwin", PlatformVersion = "14.4.1" → "macOS 14.4.1"
//   - Windows: Platform = "Microsoft Windows 11 Pro" already, version is
//     the build number; keep just the platform name.
func formatHumanOS(h *pshost.InfoStat) string {
	if h == nil {
		return ""
	}
	switch h.OS {
	case "darwin":
		if h.PlatformVersion != "" {
			return "macOS " + h.PlatformVersion
		}
		return "macOS"
	case "windows":
		// gopsutil on Windows fills Platform with the full edition string
		// already; fall through to the default branch.
	}
	// Linux + Windows + others: prefer Platform (capitalized + spaced)
	// joined with PlatformVersion.
	plat := h.Platform
	switch strings.ToLower(plat) {
	case "redhat", "rhel":
		plat = "Red Hat Enterprise Linux"
	case "centos":
		plat = "CentOS"
	case "fedora":
		plat = "Fedora"
	case "ubuntu":
		plat = "Ubuntu"
	case "debian":
		plat = "Debian"
	case "rocky":
		plat = "Rocky Linux"
	case "almalinux", "alma":
		plat = "AlmaLinux"
	case "opensuse", "opensuse-leap":
		plat = "openSUSE"
	case "sles", "suse":
		plat = "SUSE Linux Enterprise Server"
	case "arch":
		plat = "Arch Linux"
	case "alpine":
		plat = "Alpine Linux"
	}
	if plat == "" {
		plat = h.PlatformFamily
	}
	if plat == "" {
		return ""
	}
	if h.PlatformVersion != "" {
		return plat + " " + h.PlatformVersion
	}
	return plat
}

// findPrimaryInterface returns the MAC + IPv4 of the most likely
// "primary" NIC: first interface that's up, non-loopback, has a
// hardware address, and holds at least one non-link-local IPv4.
// Operators on hosts with multiple NICs (servers, hypervisors) get
// whichever the kernel enumerates first — same answer the agent's
// existing per-NIC sample list shows under "primary."
func findPrimaryInterface() (mac string, ip string, ok bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", "", false
	}
	for _, ifc := range ifaces {
		if (ifc.Flags & net.FlagUp) == 0 {
			continue
		}
		if (ifc.Flags & net.FlagLoopback) != 0 {
			continue
		}
		hwa := ifc.HardwareAddr.String()
		if hwa == "" {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipStr := a.String()
			if i := strings.IndexByte(ipStr, '/'); i >= 0 {
				ipStr = ipStr[:i]
			}
			parsed := net.ParseIP(ipStr)
			if parsed == nil {
				continue
			}
			if parsed.To4() == nil {
				continue // skip IPv6 for primary
			}
			if parsed.IsLinkLocalUnicast() || parsed.IsLoopback() {
				continue
			}
			return hwa, ipStr, true
		}
	}
	return "", "", false
}

// platformDMI is the shape readPlatformDMI returns — populated by the
// per-OS file (systeminfo_linux.go, etc.).
type platformDMI struct {
	Manufacturer string
	Model        string
	Serial       string
	BiosVersion  string
}

// ts is unused right now but kept for symmetry with other collectors
// in case we add a Timestamp field to SystemInfo later.
var _ = time.Now
