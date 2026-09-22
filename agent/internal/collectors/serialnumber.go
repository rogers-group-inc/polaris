// serialnumber.go — is this string actually a serial number?
//
// Business rule 84 (the server half is src/utils/serialNumber.ts): a value that
// cannot identify a device is refused where it would be WRITTEN — here, before
// it ever goes on the wire.
//
// SMBIOS serial fields are free text that the board vendor is supposed to
// program at manufacture and frequently doesn't. What comes back instead is a
// placeholder ("To Be Filled By O.E.M.", "Default string", "System Serial
// Number") or a repeated character — values that are IDENTICAL on every unit
// of that model. Sending one is worse than sending nothing:
//
//   - the projection ranks polaris-agent ABOVE arc and intune for serial
//     (utils/assetProjection.ts), so a placeholder OVERWRITES a real serial
//     that a cloud inventory source already had; and
//   - business rule 83's duplicate-serial sweep treats two assets sharing a
//     serial as one device recorded twice, so a fleet-wide placeholder is a
//     fleet-wide pile of false conflict cards.
//
// Reporting an empty serial lets the projection fall through to the next
// source, which is the honest answer. The server rejects these values too
// (src/utils/serialNumber.ts — same list, same rules) because agents in the
// field upgrade on their own schedule and the other sources feed junk of
// their own; this copy stops it at the wire instead of at the projection.
package collectors

import "strings"

// placeholderSerials are the vendor defaults, matched case-insensitively
// after trimming. Keep in sync with PLACEHOLDER_SERIALS in
// src/utils/serialNumber.ts.
var placeholderSerials = map[string]struct{}{
	"0":                        {},
	"00000000":                 {},
	"0123456789":               {},
	"123456789":                {},
	"1234567890":               {},
	"base board serial number": {},
	"chassis serial number":    {},
	"default string":           {},
	"invalid":                  {},
	"n/a":                      {},
	"na":                       {},
	"no asset tag":             {},
	"none":                     {},
	"not applicable":           {},
	"not available":            {},
	"not specified":            {},
	"null":                     {},
	"o.e.m.":                   {},
	"oem":                      {},
	"system serial number":     {},
	"to be filled by o.e.m.":   {},
	"to be filled by oem":      {},
	"tobefilledbyoem":          {},
	"unknown":                  {},
	"unspecified":              {},
	"x":                        {},
	"xxxxxxx":                  {},
}

// minSerialLength — a serial too short to be one. Real Dell/HP/Lenovo/Fortinet
// serials are 7+; the floor is deliberately lower than that so an unusual
// short-but-real serial survives.
const minSerialLength = 4

// usableSerial returns the trimmed serial, or "" when the value is a
// placeholder rather than an identity. Mirrors isUsableSerial + the trim in
// src/utils/serialNumber.ts so both ends agree on what counts.
func usableSerial(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) < minSerialLength {
		return ""
	}
	if _, bad := placeholderSerials[strings.ToLower(trimmed)]; bad {
		return ""
	}
	// A single repeated character, whatever it is: "0000000", "XXXXXXXX".
	if isRepeatedChar(trimmed) {
		return ""
	}
	return trimmed
}

func isRepeatedChar(s string) bool {
	if s == "" {
		return false
	}
	first := s[0]
	for i := 1; i < len(s); i++ {
		if s[i] != first {
			return false
		}
	}
	return true
}
