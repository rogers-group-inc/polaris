// servicelog.go — tail the log of each operator-pinned UNIT (Phase 2, service
// dimension; Asset.monitoredServices). The service-tab counterpart of
// processlog.go. The platform reader (readServiceUnitLog) decides what a
// unit's log is:
//   - Linux: the unit's journal (journalctl -u <unit>). First run seeds at the
//     tail cursor — no historical dump.
//   - Windows: the Event Log entries about the service — Service Control
//     Manager entries naming it in System, plus whatever it wrote under its own
//     event source in System or Application. First run backfills the most
//     recent few (winServiceLogBackfill): SCM entries are sparse, so seeding at
//     the tail would leave a healthy service's panel empty for weeks.
//
// Cursors live in servicelog-cursors.json next to agent.conf — a SEPARATE file
// from processlog-cursors.json so the two loops (different goroutines) never
// race on a shared read-modify-write.
package collectors

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/polaris/agent/internal/transport"
)

// winServiceLogBackfill is how many recent Event Log entries per channel a
// newly pinned Windows service starts with.
const winServiceLogBackfill = 50

// xpathLiteral quotes s for an Event Log XPath predicate. XPath 1.0 has no
// escape inside a literal, so a value holding both quote kinds cannot be
// expressed — ok=false and the caller drops that name.
func xpathLiteral(s string) (string, bool) {
	if !strings.Contains(s, "'") {
		return "'" + s + "'", true
	}
	if !strings.Contains(s, `"`) {
		return `"` + s + `"`, true
	}
	return "", false
}

// winServiceLogQuery builds the Event Log XPath for one service on one channel,
// newer than afterRecord. names are the service's short name and display name:
// SCM writes the display name into param1 for most entries (7036 state change,
// 7031/7034 crash, 7040 start-type change, 7000/7009/7023 failed start) and the
// short name into a few (7045 install); a service's own event source is
// usually one of the two. System gets both halves; other channels only the
// provider half (SCM writes to System alone). "" when no name is quotable.
// Pure.
func winServiceLogQuery(channel string, names []string, afterRecord int64) string {
	var lits []string
	for _, n := range names {
		if n == "" {
			continue
		}
		if l, ok := xpathLiteral(n); ok {
			lits = append(lits, l)
		}
	}
	if len(lits) == 0 {
		return ""
	}
	join := func(lhs string) string {
		parts := make([]string, len(lits))
		for i, l := range lits {
			parts[i] = lhs + "=" + l
		}
		return strings.Join(parts, " or ")
	}
	provider := "System[Provider[" + join("@Name") + "]]"
	match := provider
	if channel == "System" {
		match = "(System[Provider[@Name='Service Control Manager']] and EventData[" + join("Data") + "]) or " + provider
	}
	return "*[System[EventRecordID>" + strconv.FormatInt(afterRecord, 10) + "] and (" + match + ")]"
}

func serviceLogCursorPath(stateDir string) string {
	return filepath.Join(stateDir, "servicelog-cursors.json")
}

func loadServiceLogCursors(stateDir string) map[string]string {
	b, err := os.ReadFile(serviceLogCursorPath(stateDir))
	if err != nil {
		return map[string]string{}
	}
	return parseCursors(b) // reuse eventlog.go's tolerant codec
}

func saveServiceLogCursors(stateDir string, cursors map[string]string) error {
	b, err := marshalCursors(cursors)
	if err != nil {
		return err
	}
	tmp := serviceLogCursorPath(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, serviceLogCursorPath(stateDir))
}

// ServiceLogOnce tails every pinned unit's log since its cursor and returns
// the new lines as wire samples. Mutates + persists the cursor map. Best-effort:
// a per-unit failure is skipped, not fatal. Returns nil when nothing is pinned.
func ServiceLogOnce(stateDir string, units []string, maxPerUnit int) []*transport.ServiceLogSample {
	if len(units) == 0 {
		return nil
	}
	if maxPerUnit <= 0 {
		maxPerUnit = defaultMaxLogLinesPerProcess
	}
	cursors := loadServiceLogCursors(stateDir)
	var out []*transport.ServiceLogSample
	for _, unit := range units {
		lines, src := readServiceUnitLog(unit, cursors, maxPerUnit)
		for _, l := range lines {
			s := src
			sample := &transport.ServiceLogSample{Timestamp: l.Timestamp, Unit: unit, Message: l.Message, Source: &s}
			if l.Level != "" {
				lvl := l.Level
				sample.Level = &lvl
			}
			out = append(out, sample)
		}
	}
	_ = saveServiceLogCursors(stateDir, cursors)
	return out
}
