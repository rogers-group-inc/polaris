package collectors

import (
	"strings"
	"testing"
	"time"

	"github.com/polaris/agent/internal/transport"
)

func TestParseShowUnits(t *testing.T) {
	out := "Id=truckscale-central.service\nMainPID=2589126\nMemoryCurrent=925368320\n\n" +
		"Id=oneshot.service\nMainPID=0\nMemoryCurrent=[not set]\n\n" +
		"Id=unaccounted.service\nMainPID=42\nMemoryCurrent=18446744073709551615\n"
	got := parseShowUnits(out)

	if len(got) != 3 {
		t.Fatalf("expected 3 units, got %d: %+v", len(got), got)
	}

	ts := got["truckscale-central.service"]
	if ts.mainPid != 2589126 {
		t.Errorf("truckscale mainPid = %d, want 2589126", ts.mainPid)
	}
	if !ts.hasMem || ts.memBytes != 925368320 {
		t.Errorf("truckscale mem = (%d, has=%v), want 925368320", ts.memBytes, ts.hasMem)
	}

	one := got["oneshot.service"]
	if one.mainPid != 0 {
		t.Errorf("oneshot mainPid = %d, want 0", one.mainPid)
	}
	if one.hasMem {
		t.Errorf("oneshot should have no accounted memory, got %d", one.memBytes)
	}

	// uint64-max MemoryCurrent is the "unaccounted" sentinel → not reported.
	un := got["unaccounted.service"]
	if un.mainPid != 42 {
		t.Errorf("unaccounted mainPid = %d, want 42", un.mainPid)
	}
	if un.hasMem {
		t.Errorf("uint64-max MemoryCurrent must be treated as unaccounted, got %d", un.memBytes)
	}
}

func TestParseShowUnitsEmpty(t *testing.T) {
	if got := parseShowUnits(""); len(got) != 0 {
		t.Errorf("empty input should yield no units, got %+v", got)
	}
}

func TestParseListUnits(t *testing.T) {
	// The plain (`--plain --no-legend`) table form the agent actually sees under
	// systemd — description carries embedded spaces; a failed unit may keep a
	// leading "●"; a non-.service row (belt-and-suspenders) is ignored.
	out := "" +
		"accounts-daemon.service   loaded active   running Accounts Service\n" +
		"truckscale-central.service loaded active  running Truck Scale Central Daemon\n" +
		"● oops.service             loaded failed  failed  Something Broke Badly\n" +
		"oneshot.service            loaded inactive dead    One Shot Setup\n" +
		"dbus.socket                loaded active   running D-Bus Socket\n"
	got := parseListUnits(out)

	if len(got) != 4 {
		t.Fatalf("expected 4 service units, got %d: %+v", len(got), got)
	}
	ts := got["truckscale-central.service"]
	if ts.Load != "loaded" || ts.Active != "active" || ts.Sub != "running" {
		t.Errorf("truckscale states = %+v, want loaded/active/running", ts)
	}
	if ts.Description != "Truck Scale Central Daemon" {
		t.Errorf("truckscale description = %q, want multi-word description", ts.Description)
	}
	// Leading bullet must be stripped so the unit name lands in column 0.
	oops, ok := got["oops.service"]
	if !ok {
		t.Fatalf("failed-unit row with leading ● was not parsed: %+v", got)
	}
	if oops.Active != "failed" || oops.Description != "Something Broke Badly" {
		t.Errorf("oops row = %+v, want active=failed, full description", oops)
	}
	if _, ok := got["dbus.socket"]; ok {
		t.Errorf("non-.service row should be ignored, got %+v", got["dbus.socket"])
	}
}

func TestParseListUnitsEmpty(t *testing.T) {
	if got := parseListUnits(""); len(got) != 0 {
		t.Errorf("empty input should yield no units, got %+v", got)
	}
	// A JSON blob (the interactive-session output the agent must NOT rely on)
	// has no whitespace-columned service rows, so it parses to nothing.
	if got := parseListUnits(`[{"unit":"x.service","load":"loaded"}]`); len(got) != 0 {
		t.Errorf("JSON input should not yield table rows, got %+v", got)
	}
}

func TestParseListUnitFiles(t *testing.T) {
	out := "" +
		"truckscale-central.service enabled  enabled\n" +
		"sshd.service               enabled\n" + // preset column optional
		"getty@.service             static\n" +
		"dbus.socket                enabled  enabled\n" // non-service ignored
	got := parseListUnitFiles(out)

	if len(got) != 3 {
		t.Fatalf("expected 3 service unit-files, got %d: %+v", len(got), got)
	}
	if got["truckscale-central.service"] != "enabled" {
		t.Errorf("truckscale state = %q, want enabled", got["truckscale-central.service"])
	}
	if got["getty@.service"] != "static" {
		t.Errorf("getty state = %q, want static", got["getty@.service"])
	}
	if _, ok := got["dbus.socket"]; ok {
		t.Errorf("non-.service unit-file should be ignored")
	}
}

func TestParseShowUnitsCPU(t *testing.T) {
	out := "Id=a.service\nMainPID=10\nCPUUsageNSec=2500000000\n\n" +
		"Id=b.service\nMainPID=11\nCPUUsageNSec=[not set]\n\n" +
		"Id=c.service\nMainPID=12\nCPUUsageNSec=18446744073709551615\n"
	got := parseShowUnits(out)
	if a := got["a.service"]; !a.hasCPU || a.cpuNsec != 2500000000 {
		t.Errorf("a cpu = (%d, has=%v), want 2500000000", a.cpuNsec, a.hasCPU)
	}
	if got["b.service"].hasCPU {
		t.Error("[not set] CPUUsageNSec (accounting off) must be unaccounted")
	}
	if got["c.service"].hasCPU {
		t.Error("uint64-max CPUUsageNSec must be unaccounted")
	}
}

func svcRaw(unit string, cpuSec float64, key string) serviceRaw {
	return serviceRaw{sample: &transport.ServiceSample{Unit: unit}, cpuSec: cpuSec, hasCPU: true, cpuKey: key}
}

func TestApplyServiceCPURates(t *testing.T) {
	t0 := time.Unix(1_000_000, 0)
	t1 := t0.Add(300 * time.Second)

	// First scrape: no baseline, so no rate — never a guess.
	first := []serviceRaw{svcRaw("steady", 100, "pid:1:5"), svcRaw("restarts", 50, "pid:2:5")}
	prev := applyServiceCPURates(first, nil, t0)
	for _, r := range first {
		if r.sample.CpuPct != nil {
			t.Errorf("%s: first scrape must carry no cpuPct, got %v", r.sample.Unit, *r.sample.CpuPct)
		}
	}

	second := []serviceRaw{
		svcRaw("steady", 130, "pid:1:5"),   // 30 s of CPU over 300 s = 10 %
		svcRaw("restarts", 60, "pid:9:77"), // new process: baseline dropped
		svcRaw("new", 5, "pid:3:5"),        // no prior row
		{sample: &transport.ServiceSample{Unit: "stopped"}},
	}
	next := applyServiceCPURates(second, prev, t1)
	if p := second[0].sample.CpuPct; p == nil || *p < 9.999 || *p > 10.001 {
		t.Errorf("steady cpuPct = %v, want 10", p)
	}
	if second[1].sample.CpuPct != nil || second[2].sample.CpuPct != nil || second[3].sample.CpuPct != nil {
		t.Error("restarted / new / CPU-less rows must carry no cpuPct")
	}
	if _, ok := next["stopped"]; ok {
		t.Error("a row with no CPU counter must not leave a baseline")
	}
	if next["restarts"].key != "pid:9:77" {
		t.Error("the restarted service must be re-baselined on its new process")
	}

	// A counter that went backwards (same key) is dropped, not reported negative.
	third := []serviceRaw{svcRaw("steady", 120, "pid:1:5")}
	applyServiceCPURates(third, next, t1.Add(300*time.Second))
	if third[0].sample.CpuPct != nil {
		t.Errorf("backwards counter must yield no cpuPct, got %v", *third[0].sample.CpuPct)
	}
}

func TestXpathLiteral(t *testing.T) {
	if l, ok := xpathLiteral("Spooler"); !ok || l != "'Spooler'" {
		t.Errorf("plain = %q %v", l, ok)
	}
	if l, ok := xpathLiteral("O'Brien Svc"); !ok || l != `"O'Brien Svc"` {
		t.Errorf("apostrophe = %q %v", l, ok)
	}
	if _, ok := xpathLiteral(`a'b"c`); ok {
		t.Error("both quote kinds cannot be expressed in XPath 1.0")
	}
}

func TestWinServiceLogQuery(t *testing.T) {
	sys := winServiceLogQuery("System", []string{"Spooler", "Print Spooler"}, 42)
	want := "*[System[EventRecordID>42] and ((System[Provider[@Name='Service Control Manager']] and EventData[Data='Spooler' or Data='Print Spooler']) or System[Provider[@Name='Spooler' or @Name='Print Spooler']])]"
	if sys != want {
		t.Errorf("System query:\n got %s\nwant %s", sys, want)
	}
	app := winServiceLogQuery("Application", []string{"Spooler"}, 0)
	if app != "*[System[EventRecordID>0] and (System[Provider[@Name='Spooler']])]" {
		t.Errorf("Application query = %s", app)
	}
	if strings.Contains(app, "Service Control Manager") {
		t.Error("SCM writes only to System; the Application query must not look for it")
	}
	if q := winServiceLogQuery("System", []string{"", `a'b"c`}, 0); q != "" {
		t.Errorf("no quotable name must yield no query, got %s", q)
	}
}
