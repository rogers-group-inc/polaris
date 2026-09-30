//go:build windows

package collectors

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// readPlatformDMI reads vendor / model / serial / BIOS version on Windows.
//
// SMBIOS FIRST, REGISTRY AS FALLBACK
// The raw SMBIOS table (smbios.go + smbios_windows.go) is the only place
// Windows exposes the SERIAL NUMBER. The registry keys below carry the other
// three fields and no serial:
//
//	HKLM\HARDWARE\DESCRIPTION\System\BIOS → SystemManufacturer,
//	    SystemProductName, SystemFamily, SystemSKU, BIOSVersion, BIOSVendor
//	HKLM\SYSTEM\HardwareConfig\Current    → the same set, plus
//	    SystemBiosVersion as REG_MULTI_SZ
//
// Neither holds a serial under any name, on any supported release — verified
// against Windows 11 26200 and consistent with every documented value list.
// This collector used to fall back to SystemSKU when it couldn't find one,
// which meant it reported a MODEL string as the serial ("LENOVO_MT_83DG_BU_
// idea_FM_Legion 5 16IRX9"; a PowerEdge reports "SKU=NotProvided;ModelName=
// PowerEdge R740" — the same value on every R740 in a fleet). That fallback
// is gone: no serial is a legitimate answer, a wrong one is not.
//
// The registry still answers for manufacturer / model / BIOS version when the
// firmware table can't be read (a hypervisor that doesn't present SMBIOS, an
// OS older than the GetSystemFirmwareTable API), and fills any single field
// SMBIOS left blank.
//
// Read-only access — registry.QUERY_VALUE is the minimum permission. HARDWARE
// keys are world-readable on all supported Windows versions so the agent's
// service user can open them without elevation.
func readPlatformDMI() *platformDMI {
	d := readSMBIOSDMI()
	if d == nil {
		d = &platformDMI{}
	}

	// Registry fills whatever SMBIOS didn't answer. Never the serial — the
	// registry has none, and the SKU is not one.
	if d.Manufacturer == "" || d.Model == "" || d.BiosVersion == "" {
		if k, err := registry.OpenKey(registry.LOCAL_MACHINE,
			`HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE); err == nil {
			defer k.Close()
			if d.Manufacturer == "" {
				d.Manufacturer = stringFromReg(k, "SystemManufacturer")
			}
			if d.Model == "" {
				d.Model = stringFromReg(k, "SystemProductName")
			}
			if d.BiosVersion == "" {
				d.BiosVersion = stringFromReg(k, "BIOSVersion")
			}
		}
	}

	return d
}

func stringFromReg(k registry.Key, name string) string {
	s, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}
