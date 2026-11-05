package collectors

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateUTF8KeepsShortValidText(t *testing.T) {
	if got := truncateUTF8("hello", 10); got != "hello" {
		t.Fatalf("got %q", got)
	}
}

func TestTruncateUTF8NeverSplitsACharacter(t *testing.T) {
	s := strings.Repeat("é", 10) // 2 bytes each
	got := truncateUTF8(s, 5)
	if !utf8.ValidString(got) || len(got) > 5 || got != "éé" {
		t.Fatalf("got %q (%d bytes)", got, len(got))
	}
}

// The bug it replaced: one invalid byte near the start used to empty the result.
func TestTruncateUTF8KeepsTextAroundAnInvalidByte(t *testing.T) {
	s := "ok\xffthen a long tail " + strings.Repeat("x", 100)
	got := truncateUTF8(s, 20)
	if got == "" || !utf8.ValidString(got) || len(got) > 20 || !strings.HasPrefix(got, "ok�") {
		t.Fatalf("got %q (%d bytes)", got, len(got))
	}
}

func TestTruncateUTF8ReplacementNeverPushesPastMax(t *testing.T) {
	s := strings.Repeat("\xff", 50) // each byte becomes 3 bytes of U+FFFD
	got := truncateUTF8(s, 10)
	if len(got) > 10 || !utf8.ValidString(got) {
		t.Fatalf("got %q (%d bytes)", got, len(got))
	}
}

func TestBodyExcerptSurvivesABinaryBody(t *testing.T) {
	body := append([]byte{0x89, 'P', 'N', 'G', 0xff, 0xfe}, []byte(strings.Repeat("a", 8000))...)
	got := bodyExcerpt(body)
	if got == "" || !utf8.ValidString(got) || len(got) > pathCheckMaxExcerptBytes {
		t.Fatalf("excerpt %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestTruncateErrorStaysWithinTheWireLimit(t *testing.T) {
	err := errors.New("\xff" + strings.Repeat("é", pathCheckMaxErrorLen))
	got := truncateError(err)
	if got == "" || !utf8.ValidString(got) || len(got) > pathCheckMaxErrorLen {
		t.Fatalf("got %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}

func TestTruncateNoteIsCharacterSafe(t *testing.T) {
	got := truncateNote(strings.Repeat("ü", 200)) // 400 bytes
	if len(got) > 256 || !utf8.ValidString(got) {
		t.Fatalf("got %d bytes, valid=%v", len(got), utf8.ValidString(got))
	}
}
