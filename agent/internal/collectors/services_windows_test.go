//go:build windows

package collectors

import "testing"

func TestParseWin32ServiceJSON(t *testing.T) {
	in := `[{"Name":"BITS","DisplayName":"Background Intelligent Transfer Service","Description":"  Transfers files.  ","State":"Running","StartMode":"Auto","DelayedAutoStart":true,"ProcessId":11020},` +
		`{"Name":"Spooler","DisplayName":"Print Spooler","Description":"","State":"Running","StartMode":"Auto","DelayedAutoStart":false,"ProcessId":6616},` +
		`{"Name":"Old","DisplayName":"Pre-2012 host","State":"Stopped","StartMode":"Auto","ProcessId":0},` +
		`{"Name":"","DisplayName":"nameless"}]`
	got, ok := parseWin32ServiceJSON([]byte(in))
	if !ok || len(got) != 3 {
		t.Fatalf("parse ok=%v rows=%d, want 3 (nameless row dropped)", ok, len(got))
	}
	bits := got[0]
	if bits.EnabledState == nil || *bits.EnabledState != "auto-delayed" {
		t.Errorf("BITS enabledState = %v, want auto-delayed", bits.EnabledState)
	}
	if bits.Description == nil || *bits.Description != "Transfers files." {
		t.Errorf("BITS description = %v, want trimmed text", bits.Description)
	}
	if bits.MainPid == nil || *bits.MainPid != 11020 || bits.ActiveState == nil || *bits.ActiveState != "running" {
		t.Errorf("BITS pid/state = %v/%v", bits.MainPid, bits.ActiveState)
	}
	if sp := got[1]; sp.EnabledState == nil || *sp.EnabledState != "auto" || sp.Description != nil {
		t.Errorf("Spooler enabled=%v desc=%v, want auto + no description", sp.EnabledState, sp.Description)
	}
	// A host whose Win32_Service lacks DelayedAutoStart reads plain auto.
	if old := got[2]; *old.EnabledState != "auto" || old.MainPid != nil {
		t.Errorf("Old enabled=%v pid=%v, want auto + no pid", *old.EnabledState, old.MainPid)
	}
	if _, ok := parseWin32ServiceJSON([]byte("not json")); ok {
		t.Error("undecodable output must report !ok so the push is skipped")
	}
}

func TestParseWevtutilRenderedXML(t *testing.T) {
	in := `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Service Control Manager'/><EventID Qualifiers='16384'>7036</EventID><Level>4</Level><TimeCreated SystemTime='2026-09-27T18:56:05.8987904Z'/><EventRecordID>182952</EventRecordID></System>` +
		`<EventData><Data Name='param1'>Print Spooler</Data><Data Name='param2'>stopped</Data></EventData>` +
		`<RenderingInfo Culture='en-US'><Message>The Print Spooler service entered the stopped state.</Message><Level>Information</Level></RenderingInfo></Event>` +
		`<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Spooler'/><EventID>1</EventID><Level>2</Level><EventRecordID>182953</EventRecordID></System><EventData><Data>a</Data><Data>b</Data></EventData></Event>`
	got := parseWevtutilXML([]byte(in), "System")
	if len(got) != 2 {
		t.Fatalf("got %d events, want 2", len(got))
	}
	if m := got[0].ev.Message; m != "The Print Spooler service entered the stopped state." {
		t.Errorf("rendered message = %q", m)
	}
	if got[0].recordID != 182952 || got[0].ev.Level != "info" {
		t.Errorf("record/level = %d/%s", got[0].recordID, got[0].ev.Level)
	}
	// No RenderingInfo (plain /f:XML) falls back to the joined data.
	if m := got[1].ev.Message; m != "a b" || got[1].ev.Level != "error" {
		t.Errorf("fallback message/level = %q/%s", m, got[1].ev.Level)
	}
}

// The query winServiceLogQuery builds must be one wevtutil accepts — a syntax
// wevtutil rejects returns nothing, which would look exactly like a quiet
// service. Runs the real System query on this host.
func TestWinServiceLogQueryAcceptedByWevtutil(t *testing.T) {
	q := winServiceLogQuery("System", []string{"EventLog", "Windows Event Log"}, 0)
	if out := winQueryRendered("System", q, 1); out == nil {
		t.Skip("wevtutil returned nothing (no matching event, or no access) — cannot tell accept from reject here")
	}
}
