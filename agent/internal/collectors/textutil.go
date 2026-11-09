package collectors

import (
	"strings"
	"unicode/utf8"
)

// truncateUTF8 returns s as valid UTF-8 of at most max bytes: invalid bytes
// become U+FFFD FIRST, then the cut backs off to the start of the character
// it would split (at most utf8.UTFMax-1 bytes, since s is valid by then).
//
// It replaced three hand-rolled cuts. Two of them trimmed one byte at a time
// until the WHOLE prefix was valid, so a single invalid byte early in a
// binary HTTP body or an error message emptied the result; the third cut at
// a byte count and could split a character in half.
func truncateUTF8(s string, max int) string {
	s = strings.ToValidUTF8(s, "�")
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
