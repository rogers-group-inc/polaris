package collectors

import (
	"encoding/binary"
	"testing"
)

// buildStruct assembles one SMBIOS structure. `formatted` is the bytes that
// follow the 4-byte header (i.e. what the spec calls offset 0x04 onward), so
// a string-index field at spec offset 0x07 is formatted[3].
func buildStruct(typ byte, handle uint16, formatted []byte, strs []string) []byte {
	out := []byte{typ, byte(4 + len(formatted)), 0, 0}
	binary.LittleEndian.PutUint16(out[2:4], handle)
	out = append(out, formatted...)
	if len(strs) == 0 {
		return append(out, 0, 0)
	}
	for _, s := range strs {
		out = append(out, []byte(s)...)
		out = append(out, 0)
	}
	return append(out, 0)
}

// buildRaw wraps table data in the RawSMBIOSData header the RSMB provider
// returns.
func buildRaw(data []byte) []byte {
	hdr := make([]byte, rawSMBIOSHeaderLen)
	hdr[1], hdr[2], hdr[3] = 3, 4, 0 // SMBIOS 3.4
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(data)))
	return append(hdr, data...)
}

// type1 builds a System Information structure with the given string indices.
// Formatted area is 23 bytes (spec offsets 0x04..0x1A for SMBIOS 2.4+).
func type1(manufacturer, product, version, serial byte, strs []string) []byte {
	f := make([]byte, 23)
	f[0] = manufacturer // 0x04
	f[1] = product      // 0x05
	f[2] = version      // 0x06
	f[3] = serial       // 0x07
	return buildStruct(smbiosTypeSystem, 0x0001, f, strs)
}

// type3 builds a System Enclosure structure. Serial is spec offset 0x07.
func type3(manufacturer, serial byte, strs []string) []byte {
	f := make([]byte, 18)
	f[0] = manufacturer
	f[3] = serial
	return buildStruct(smbiosTypeEnclosure, 0x0003, f, strs)
}

// type0 builds a BIOS Information structure: vendor 0x04, version 0x05.
func type0(vendor, version byte, strs []string) []byte {
	f := make([]byte, 20)
	f[0] = vendor
	f[1] = version
	return buildStruct(smbiosTypeBIOS, 0x0000, f, strs)
}

func endOfTable() []byte {
	return buildStruct(smbiosTypeEndOfTable, 0x7f00, nil, nil)
}

func TestStripRawSMBIOSHeader(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5}
	raw := buildRaw(data)
	got, err := stripRawSMBIOSHeader(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != string(data) {
		t.Errorf("got % x, want % x", got, data)
	}
}

func TestStripRawSMBIOSHeaderTrimsOversizedBuffer(t *testing.T) {
	// GetSystemFirmwareTable can hand back a buffer longer than the table.
	raw := append(buildRaw([]byte{9, 9, 9}), 0xAA, 0xBB, 0xCC)
	got, err := stripRawSMBIOSHeader(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("got %d bytes, want the 3 the header declares", len(got))
	}
}

func TestStripRawSMBIOSHeaderTooShort(t *testing.T) {
	if _, err := stripRawSMBIOSHeader([]byte{0, 1, 2}); err == nil {
		t.Error("expected an error for a buffer shorter than the header")
	}
}

func TestParseAndExtractSerial(t *testing.T) {
	var data []byte
	data = append(data, type0(1, 2, []string{"INSYDE Corp.", "NMCN35WW"})...)
	data = append(data, type1(1, 2, 3, 4, []string{"LENOVO", "83DG", "Legion 5", "MP12AB92"})...)
	data = append(data, endOfTable()...)

	structs := parseSMBIOSStructures(data)
	if len(structs) != 3 {
		t.Fatalf("parsed %d structures, want 3", len(structs))
	}

	d := dmiFromSMBIOS(structs)
	if d.Serial != "MP12AB92" {
		t.Errorf("serial = %q, want the Type 1 serial MP12AB92", d.Serial)
	}
	if d.Manufacturer != "LENOVO" {
		t.Errorf("manufacturer = %q, want LENOVO", d.Manufacturer)
	}
	if d.Model != "83DG" {
		t.Errorf("model = %q, want 83DG", d.Model)
	}
	if d.BiosVersion != "NMCN35WW" {
		t.Errorf("biosVersion = %q, want NMCN35WW", d.BiosVersion)
	}
}

// The SKU is at spec offset 0x19 and must never be read as the serial — the
// regression this whole change exists for.
func TestSKUIsNeverTheSerial(t *testing.T) {
	f := make([]byte, 23)
	f[0] = 1  // manufacturer
	f[1] = 2  // product
	f[3] = 0  // serial: UNSET
	f[21] = 3 // 0x19 SKU
	data := append(buildStruct(smbiosTypeSystem, 1, f,
		[]string{"LENOVO", "83DG", "LENOVO_MT_83DG_BU_idea_FM_Legion 5 16IRX9"}), endOfTable()...)

	d := dmiFromSMBIOS(parseSMBIOSStructures(data))
	if d.Serial != "" {
		t.Errorf("serial = %q, want empty — an unset serial must stay unset, not borrow the SKU", d.Serial)
	}
}

func TestChassisSerialIsTheFallback(t *testing.T) {
	var data []byte
	// Type 1 serial unset (index 0).
	data = append(data, type1(1, 2, 0, 0, []string{"Dell Inc.", "PowerEdge R740"})...)
	data = append(data, type3(1, 2, []string{"Dell Inc.", "7XQ4P42"})...)
	data = append(data, endOfTable()...)

	d := dmiFromSMBIOS(parseSMBIOSStructures(data))
	if d.Serial != "7XQ4P42" {
		t.Errorf("serial = %q, want the chassis serial 7XQ4P42", d.Serial)
	}
}

func TestSystemSerialBeatsChassisSerial(t *testing.T) {
	var data []byte
	data = append(data, type1(1, 2, 0, 3, []string{"Dell Inc.", "PowerEdge R740", "SYSTEM01"})...)
	data = append(data, type3(1, 2, []string{"Dell Inc.", "CHASSIS9"})...)
	data = append(data, endOfTable()...)

	d := dmiFromSMBIOS(parseSMBIOSStructures(data))
	if d.Serial != "SYSTEM01" {
		t.Errorf("serial = %q, want the Type 1 serial SYSTEM01", d.Serial)
	}
}

func TestPlaceholderSerialsAreRejectedAtParse(t *testing.T) {
	for _, placeholder := range []string{
		"To Be Filled By O.E.M.",
		"Default string",
		"System Serial Number",
		"0000000000",
		"None",
		"   ",
	} {
		data := append(type1(1, 2, 0, 3,
			[]string{"ASUSTeK", "All Series", placeholder}), endOfTable()...)
		d := dmiFromSMBIOS(parseSMBIOSStructures(data))
		if d.Serial != "" {
			t.Errorf("serial for placeholder %q = %q, want empty", placeholder, d.Serial)
		}
	}
}

func TestChassisPlaceholderDoesNotBecomeTheFallback(t *testing.T) {
	var data []byte
	data = append(data, type1(1, 2, 0, 0, []string{"ASUSTeK", "All Series"})...)
	data = append(data, type3(1, 2, []string{"ASUSTeK", "To Be Filled By O.E.M."})...)
	data = append(data, endOfTable()...)

	d := dmiFromSMBIOS(parseSMBIOSStructures(data))
	if d.Serial != "" {
		t.Errorf("serial = %q, want empty — a placeholder chassis serial is not a fallback", d.Serial)
	}
}

func TestStructureWithNoStrings(t *testing.T) {
	var data []byte
	data = append(data, type1(0, 0, 0, 0, nil)...)
	data = append(data, type3(1, 2, []string{"Supermicro", "S123456"})...)
	data = append(data, endOfTable()...)

	structs := parseSMBIOSStructures(data)
	if len(structs) != 3 {
		t.Fatalf("parsed %d structures, want 3 — a no-string structure must not desync the walk", len(structs))
	}
	if d := dmiFromSMBIOS(structs); d.Serial != "S123456" {
		t.Errorf("serial = %q, want S123456", d.Serial)
	}
}

func TestOutOfRangeStringIndexIsEmpty(t *testing.T) {
	// Serial points at string 9; only 2 exist.
	data := append(type1(1, 2, 0, 9, []string{"HP", "ProLiant DL380"}), endOfTable()...)
	if d := dmiFromSMBIOS(parseSMBIOSStructures(data)); d.Serial != "" {
		t.Errorf("serial = %q, want empty for an out-of-range string index", d.Serial)
	}
}

func TestMalformedTablesTerminate(t *testing.T) {
	cases := map[string][]byte{
		"empty":               {},
		"shorter than header": {1, 2},
		"zero length field":   {1, 0, 0, 0, 0, 0},
		"length past the end": {1, 200, 0, 0, 1, 2, 3},
		"all zeroes":          make([]byte, 64),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			// The assertion is that these return rather than loop or panic.
			structs := parseSMBIOSStructures(data)
			_ = dmiFromSMBIOS(structs)
		})
	}
}

func TestBiosVendorOnlyFillsAnAbsentManufacturer(t *testing.T) {
	var data []byte
	data = append(data, type0(1, 2, []string{"American Megatrends Inc.", "3.2"})...)
	data = append(data, type1(1, 2, 0, 3, []string{"Supermicro", "X11DPi-N", "A123456789"})...)
	data = append(data, endOfTable()...)

	d := dmiFromSMBIOS(parseSMBIOSStructures(data))
	if d.Manufacturer != "Supermicro" {
		t.Errorf("manufacturer = %q, want the Type 1 value Supermicro, not the BIOS vendor", d.Manufacturer)
	}
}

func TestReadSMBIOSDMIHandlesUnavailableTable(t *testing.T) {
	// On non-Windows readRawSMBIOS always errors; on Windows this exercises a
	// real read. Either way the contract is the same: never panic, and never
	// return a half-built value that lies.
	if d := readSMBIOSDMI(); d != nil && d.Serial != "" && usableSerial(d.Serial) == "" {
		t.Errorf("readSMBIOSDMI returned an unusable serial %q", d.Serial)
	}
}
