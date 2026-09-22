package collectors

import "testing"

func TestUsableSerialAcceptsRealSerials(t *testing.T) {
	for _, s := range []string{
		"MP12AB92",         // Lenovo
		"7XQ4P42",          // Dell service tag
		"FGT60FTK21000123", // Fortinet
		"VMware-56 4d 2a",  // hypervisor-assigned
		"A1B2",             // short but at the floor
	} {
		if got := usableSerial(s); got != s {
			t.Errorf("usableSerial(%q) = %q, want it kept", s, got)
		}
	}
}

func TestUsableSerialTrims(t *testing.T) {
	if got := usableSerial("  MP12AB92\n"); got != "MP12AB92" {
		t.Errorf("usableSerial = %q, want the trimmed MP12AB92", got)
	}
}

func TestUsableSerialRejectsPlaceholders(t *testing.T) {
	for _, s := range []string{
		"To Be Filled By O.E.M.",
		"to be filled by o.e.m.",
		"  Default string  ",
		"System Serial Number",
		"Not Specified",
		"Not Applicable",
		"None",
		"none",
		"Unknown",
		"N/A",
		"INVALID",
		"0123456789",
		"null",
	} {
		if got := usableSerial(s); got != "" {
			t.Errorf("usableSerial(%q) = %q, want empty", s, got)
		}
	}
}

func TestUsableSerialRejectsRepeatedCharacters(t *testing.T) {
	for _, s := range []string{"0000000", "XXXXXXXX", "....", "11111111111111"} {
		if got := usableSerial(s); got != "" {
			t.Errorf("usableSerial(%q) = %q, want empty", s, got)
		}
	}
}

func TestUsableSerialRejectsTooShort(t *testing.T) {
	for _, s := range []string{"", " ", "1", "AB", "ABC"} {
		if got := usableSerial(s); got != "" {
			t.Errorf("usableSerial(%q) = %q, want empty", s, got)
		}
	}
}
