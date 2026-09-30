// smbios.go — the SMBIOS/DMI table parser, platform-neutral half.
//
// WHY THIS EXISTS
// Windows does not publish the SMBIOS serial number in the registry. The
// HARDWARE\DESCRIPTION\System\BIOS and SYSTEM\HardwareConfig\Current keys
// carry manufacturer, product name, family, SKU and BIOS version — and no
// serial of any name, on any supported release. The collector used to fall
// back to SystemSKU, which is a MODEL string ("LENOVO_MT_83DG_BU_idea_FM_
// Legion 5 16IRX9", "SKU=NotProvided;ModelName=PowerEdge R740") and is the
// same on every unit of a model, so every Windows host reported a wrong
// serial and whole fleets reported the SAME wrong serial.
//
// The real table is available to any user through kernel32's
// GetSystemFirmwareTable('RSMB') — one syscall, no COM, no WMI service, no
// elevation, no external process. WMI's Win32_BIOS.SerialNumber reads the
// same field via a much heavier path that also hangs when the WMI repository
// is unhealthy, which on long-lived Windows servers is not rare.
//
// The byte parsing lives here, untagged, so it compiles and is tested on
// every platform the agent builds for; only readRawSMBIOS() is per-OS
// (smbios_windows.go; smbios_other.go returns "unsupported" everywhere else,
// where /sys/class/dmi and ioreg already answer).
//
// Layout (DMTF SMBIOS spec, section 6.1). Each structure is:
//
//	byte 0      type
//	byte 1      length of the FORMATTED area, including these 4 header bytes
//	bytes 2-3   handle
//	bytes 4..n  formatted area — fixed fields, where a "string" field holds a
//	            1-based INDEX into the string set that follows (0 = unset)
//	then        the string set: NUL-terminated strings, ended by an extra NUL.
//	            A structure with no strings is terminated by two NULs.
package collectors

import (
	"encoding/binary"
	"errors"
	"strings"
)

// SMBIOS structure types we read.
const (
	smbiosTypeBIOS       = 0 // BIOS Information
	smbiosTypeSystem     = 1 // System Information
	smbiosTypeEnclosure  = 3 // System Enclosure / Chassis
	smbiosTypeEndOfTable = 127
)

// Field offsets within each structure's formatted area (DMTF spec).
const (
	biosVendorOffset  = 0x04
	biosVersionOffset = 0x05

	systemManufacturerOffset = 0x04
	systemProductNameOffset  = 0x05
	systemSerialOffset       = 0x07

	enclosureSerialOffset = 0x07
)

// rawSMBIOSHeaderLen is the size of the RawSMBIOSData header that the RSMB
// provider prepends: Used20CallingMethod, SMBIOSMajorVersion,
// SMBIOSMinorVersion, DmiRevision (1 byte each) + Length (DWORD).
const rawSMBIOSHeaderLen = 8

var errSMBIOSMalformed = errors.New("smbios: malformed table")

// smbiosStructure is one parsed entry: its formatted area plus the string set
// its string-index fields point into.
type smbiosStructure struct {
	Type      byte
	formatted []byte
	strings   []string
}

// str resolves a string-index field at the given offset in the formatted area.
// Returns "" for an out-of-range offset, an unset index (0), or an index the
// string set doesn't have — all of which are normal on real firmware and none
// of which are worth an error.
func (s smbiosStructure) str(offset int) string {
	if offset < 0 || offset >= len(s.formatted) {
		return ""
	}
	idx := int(s.formatted[offset])
	if idx < 1 || idx > len(s.strings) {
		return ""
	}
	return strings.TrimSpace(s.strings[idx-1])
}

// stripRawSMBIOSHeader drops the RawSMBIOSData header the RSMB provider adds
// and returns just the table data, honouring the header's own Length field
// (the buffer the caller sized may be longer than the table).
func stripRawSMBIOSHeader(buf []byte) ([]byte, error) {
	if len(buf) < rawSMBIOSHeaderLen {
		return nil, errSMBIOSMalformed
	}
	length := int(binary.LittleEndian.Uint32(buf[4:8]))
	data := buf[rawSMBIOSHeaderLen:]
	if length > 0 && length <= len(data) {
		data = data[:length]
	}
	return data, nil
}

// parseSMBIOSStructures walks the table data. A structure that doesn't fit in
// what's left ends the walk rather than failing the whole read: firmware
// truncation is real and the structures already parsed are still good.
func parseSMBIOSStructures(data []byte) []smbiosStructure {
	var out []smbiosStructure
	for i := 0; i+4 <= len(data); {
		typ := data[i]
		length := int(data[i+1])
		// A formatted area is at least the 4 header bytes; anything less is a
		// corrupt length that would make the walk loop forever.
		if length < 4 || i+length > len(data) {
			break
		}
		s := smbiosStructure{Type: typ, formatted: data[i : i+length]}

		// String set: NUL-terminated strings from the end of the formatted
		// area up to a double NUL.
		j := i + length
		if j+1 < len(data) && data[j] == 0 && data[j+1] == 0 {
			j += 2 // no strings
		} else {
			start := j
			for j < len(data) {
				if data[j] != 0 {
					j++
					continue
				}
				if j > start {
					s.strings = append(s.strings, string(data[start:j]))
				}
				j++
				// Second NUL in a row ends the set.
				if j < len(data) && data[j] == 0 {
					j++
					break
				}
				start = j
			}
		}

		out = append(out, s)
		if typ == smbiosTypeEndOfTable {
			break
		}
		i = j
	}
	return out
}

// dmiFromSMBIOS pulls the identity fields out of a parsed table.
//
// Serial comes from Type 1 (System Information) — the device serial, which on
// a Dell PowerEdge is the service tag and on a VM is the hypervisor-assigned
// instance serial. Type 3 (Chassis) is the fallback for boards that leave
// Type 1 blank; it's the same field WMI's Win32_SystemEnclosure exposes.
// Both go through usableSerial, so a vendor placeholder reads as absent.
//
// Only the FIRST structure of each type is read: multi-socket machines repeat
// some types, and for Types 0/1/3 the first is the system-level one.
func dmiFromSMBIOS(structs []smbiosStructure) *platformDMI {
	d := &platformDMI{}
	var chassisSerial string

	for _, s := range structs {
		switch s.Type {
		case smbiosTypeBIOS:
			if d.BiosVersion == "" {
				d.BiosVersion = s.str(biosVersionOffset)
			}
			// Vendor is only a fallback for manufacturer — the BIOS vendor and
			// the system manufacturer differ on whiteboxes (AMI vs. the board
			// maker), so Type 1 wins whenever it has one.
			if d.Manufacturer == "" {
				d.Manufacturer = s.str(biosVendorOffset)
			}
		case smbiosTypeSystem:
			if m := s.str(systemManufacturerOffset); m != "" {
				d.Manufacturer = m
			}
			if p := s.str(systemProductNameOffset); p != "" && d.Model == "" {
				d.Model = p
			}
			if serial := usableSerial(s.str(systemSerialOffset)); serial != "" && d.Serial == "" {
				d.Serial = serial
			}
		case smbiosTypeEnclosure:
			if chassisSerial == "" {
				chassisSerial = usableSerial(s.str(enclosureSerialOffset))
			}
		}
	}

	if d.Serial == "" {
		d.Serial = chassisSerial
	}
	return d
}

// readSMBIOSDMI is the whole read: raw table → structures → identity fields.
// Every failure returns nil so the caller can fall back.
func readSMBIOSDMI() *platformDMI {
	buf, err := readRawSMBIOS()
	if err != nil || len(buf) == 0 {
		return nil
	}
	data, err := stripRawSMBIOSHeader(buf)
	if err != nil {
		return nil
	}
	structs := parseSMBIOSStructures(data)
	if len(structs) == 0 {
		return nil
	}
	return dmiFromSMBIOS(structs)
}
