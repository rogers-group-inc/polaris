package collectors

import (
	"testing"
)

func TestNormalizeLevel(t *testing.T) {
	cases := map[string]string{
		"1": "critical", "Critical": "critical", "crit": "critical",
		"0": "critical", "emerg": "critical", "2": "critical", "alert": "critical",
		"3": "error", "Error": "error", "err": "error",
		"4": "warning", "Warning": "warning", "warn": "warning",
		"5": "info", "6": "info", "7": "info", "Information": "info", "verbose": "info", "": "info", "weird": "info",
	}
	for in, want := range cases {
		if got := normalizeLevel(in); got != want {
			t.Errorf("normalizeLevel(%q) = %q, want %q", in, got, want)
		}
	}
}

// Windows Level numbers are NOT journald priorities: 2 is Error (journald
// crit), 4 is Information (journald warning). Each must survive normalizeLevel
// as its own severity, which is how EventLogOnce consumes the parsed level.
func TestWinLevelName(t *testing.T) {
	cases := map[string]string{
		"1": "critical", "2": "error", "3": "warning", "4": "info",
		"0": "info", "5": "info", " 2 ": "error", "": "info",
	}
	for in, want := range cases {
		if got := normalizeLevel(winLevelName(in)); got != want {
			t.Errorf("normalizeLevel(winLevelName(%q)) = %q, want %q", in, got, want)
		}
	}
}

func TestMeetsMinLevel(t *testing.T) {
	if !meetsMinLevel("critical", "error") {
		t.Error("critical should meet error")
	}
	if meetsMinLevel("warning", "error") {
		t.Error("warning should not meet error")
	}
	if !meetsMinLevel("error", "error") {
		t.Error("error should meet error")
	}
	if !meetsMinLevel("info", "info") {
		t.Error("info should meet info")
	}
}

func TestDedupeEvents(t *testing.T) {
	id := int64(7034)
	events := []rawEvent{
		{Channel: "System", EventID: &id, Level: "error", Message: "svc crashed", Provider: "SCM", Timestamp: "t1"},
		{Channel: "System", EventID: &id, Level: "error", Message: "svc crashed", Provider: "SCM", Timestamp: "t2"},
		{Channel: "Application", Level: "warning", Message: "slow", Timestamp: "t3"},
	}
	out := dedupeEvents(events)
	if len(out) != 2 {
		t.Fatalf("expected 2 deduped, got %d", len(out))
	}
	if out[0].Count != 2 {
		t.Errorf("first entry count = %d, want 2", out[0].Count)
	}
	if out[0].Timestamp != "t1" {
		t.Errorf("dedupe should keep earliest timestamp, got %q", out[0].Timestamp)
	}
	if out[0].EventID == nil || *out[0].EventID != 7034 {
		t.Error("eventId not preserved")
	}
	if out[0].Provider == nil || *out[0].Provider != "SCM" {
		t.Error("provider not preserved")
	}
	if out[1].Count != 1 {
		t.Errorf("second entry count = %d, want 1", out[1].Count)
	}
}

func TestDedupeDistinctKeys(t *testing.T) {
	a, b := int64(1), int64(2)
	events := []rawEvent{
		{Channel: "System", EventID: &a, Level: "error", Message: "x"},
		{Channel: "System", EventID: &b, Level: "error", Message: "x"}, // different id
		{Channel: "System", EventID: &a, Level: "error", Message: "y"}, // different message
	}
	if got := len(dedupeEvents(events)); got != 3 {
		t.Errorf("expected 3 distinct, got %d", got)
	}
}

func TestCapEvents(t *testing.T) {
	// Build 5 distinct deduped samples so we exercise the real transport type.
	var events []rawEvent
	for i := 0; i < 5; i++ {
		events = append(events, rawEvent{Channel: "System", Level: "error", Message: string(rune('a' + i))})
	}
	deduped := dedupeEvents(events)
	capped := capEvents(deduped, 3)
	if len(capped) != 3 {
		t.Fatalf("capEvents(.,3) returned %d", len(capped))
	}
	// Keeps the OLDEST (first) three so the cursor advances monotonically.
	if capped[0].Message != "a" || capped[2].Message != "c" {
		t.Errorf("capEvents should keep oldest N; got %q..%q", capped[0].Message, capped[2].Message)
	}
	if got := len(capEvents(deduped, 0)); got != 5 {
		t.Errorf("cap of 0 should fall back to default (>=5 kept here), got %d", got)
	}
}

func TestCursorCodecRoundTrip(t *testing.T) {
	in := map[string]string{"System": "1234", "Application": "9999", "journald": "s=abc"}
	b, err := marshalCursors(in)
	if err != nil {
		t.Fatalf("marshalCursors: %v", err)
	}
	out := parseCursors(b)
	if len(out) != 3 || out["System"] != "1234" || out["journald"] != "s=abc" {
		t.Errorf("round-trip mismatch: %v", out)
	}
	// Corrupt / empty input → empty map, never nil-panic.
	if got := parseCursors([]byte("not json")); got == nil || len(got) != 0 {
		t.Errorf("bad JSON should yield empty map, got %v", got)
	}
	if got := parseCursors(nil); got == nil || len(got) != 0 {
		t.Errorf("nil should yield empty map, got %v", got)
	}
}
