// eventlog.go — OS event-log collector (cross-platform shell + pure helpers).
//
// Reads NEW host event-log entries since a persisted per-channel cursor and
// returns them as transport.EventLogSample rows for the server to curate into
// the audit Event table. Platform readers live in eventlog_windows.go
// (wevtutil) / eventlog_linux.go (journalctl); darwin + other are stubs.
//
// First run seeds the cursor at "now" so we never dump the entire historical
// log — only entries that arrive after the agent starts collecting are shipped.
// The cursor is local-only state (eventlog-cursors.json next to agent.conf),
// never sent on the wire.
package collectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/polaris/agent/internal/transport"
)

// EventLogFilter is resolved from the server /config eventLog block + defaults
// and passed into the per-OS reader so platform code stays filter-aware.
type EventLogFilter struct {
	MinLevel         string   // "critical" | "error" | "warning" | "info"
	Channels         []string // Windows channel names; ignored on Linux
	LinuxMinPriority int      // journald priority ceiling (0 emerg .. 7 debug)
	MaxPerPush       int      // cap on emitted rows; default applied if <= 0
}

// rawEvent is the per-OS reader's output before filter/dedupe/cap. Platform
// files populate these; eventlog.go runs the shared post-processing.
type rawEvent struct {
	Timestamp string
	Channel   string
	Provider  string
	EventID   *int64
	Level     string // normalized via normalizeLevel
	Message   string
}

const defaultMaxPerPush = 100

// cursorFile is the per-channel resume state, stored as JSON next to agent.conf.
type cursorFile struct {
	Version  int               `json:"version"`
	Channels map[string]string `json:"channels"`
}

func cursorPath(stateDir string) string {
	return filepath.Join(stateDir, "eventlog-cursors.json")
}

// loadCursors reads the per-channel cursor map. Missing/corrupt file → empty
// map (every channel then first-run-seeds at "now").
func loadCursors(stateDir string) map[string]string {
	b, err := os.ReadFile(cursorPath(stateDir))
	if err != nil {
		return map[string]string{}
	}
	return parseCursors(b)
}

// parseCursors is the pure decode half of loadCursors (unit-tested).
func parseCursors(b []byte) map[string]string {
	var cf cursorFile
	if err := json.Unmarshal(b, &cf); err != nil || cf.Channels == nil {
		return map[string]string{}
	}
	return cf.Channels
}

// saveCursors atomically writes the cursor map (temp + rename, 0600 — matches
// config.Save's posture even though the cursor holds no secret).
func saveCursors(stateDir string, cursors map[string]string) error {
	b, err := marshalCursors(cursors)
	if err != nil {
		return err
	}
	tmp := cursorPath(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, cursorPath(stateDir))
}

// marshalCursors is the pure encode half of saveCursors (unit-tested).
func marshalCursors(cursors map[string]string) ([]byte, error) {
	return json.Marshal(cursorFile{Version: 1, Channels: cursors})
}

// normalizeLevel maps OS-native level strings/integers to the wire vocabulary
// the server expects: "critical" | "error" | "warning" | "info". Accepts both
// Windows rendered level names and journald numeric priorities (as strings).
func normalizeLevel(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "critical", "crit", "0", "emerg", "emergency", "2", "alert":
		// Windows Level 1 = Critical; journald 0 emerg / 1 alert / 2 crit.
		return "critical"
	case "3", "error", "err":
		return "error"
	case "4", "warning", "warn":
		return "warning"
	default:
		// Windows Level 0 (LogAlways) / 4 (Information) / 5 (Verbose);
		// journald 5 notice / 6 info / 7 debug; anything unknown.
		return "info"
	}
}

// winLevelName maps a Windows event Level number (the System/Level element) to
// its name. The number cannot go to normalizeLevel as-is: bare digits there are
// journald priorities, where 2 is crit and 4 is warning — but Windows 2 is
// Error, 3 Warning and 4 Information, so every level would read one step too
// severe. 0 (LogAlways), 5 (Verbose) and anything unknown are informational.
// Pure.
func winLevelName(n string) string {
	switch strings.TrimSpace(n) {
	case "1":
		return "critical"
	case "2":
		return "error"
	case "3":
		return "warning"
	default:
		return "info"
	}
}

var levelRank = map[string]int{"info": 0, "warning": 1, "error": 2, "critical": 3}

// meetsMinLevel reports whether `level` is at least `min` in severity. Pure.
func meetsMinLevel(level, min string) bool {
	return levelRank[level] >= levelRank[min]
}

// dedupeEvents collapses identical (channel, eventId, level, message) entries
// into one carrying a Count, preserving first-seen order + earliest timestamp.
// Pure — the highest-value test target.
func dedupeEvents(events []rawEvent) []*transport.EventLogSample {
	type acc struct {
		sample *transport.EventLogSample
	}
	order := make([]string, 0, len(events))
	byKey := make(map[string]*transport.EventLogSample, len(events))
	for i := range events {
		e := events[i]
		idPart := ""
		if e.EventID != nil {
			idPart = itoa64(*e.EventID)
		}
		key := e.Channel + "\x00" + idPart + "\x00" + e.Level + "\x00" + e.Message
		if s, ok := byKey[key]; ok {
			s.Count++
			continue
		}
		s := &transport.EventLogSample{
			Timestamp: e.Timestamp,
			Channel:   e.Channel,
			Level:     e.Level,
			Message:   e.Message,
			Count:     1,
		}
		if e.Provider != "" {
			p := e.Provider
			s.Provider = &p
		}
		if e.EventID != nil {
			id := *e.EventID
			s.EventID = &id
		}
		byKey[key] = s
		order = append(order, key)
	}
	out := make([]*transport.EventLogSample, 0, len(order))
	for _, k := range order {
		out = append(out, byKey[k])
	}
	return out
}

// capEvents trims to at most max rows. Keeps the OLDEST max (the slice is in
// read order, oldest first) so the cursor advances monotonically and the next
// poll catches the remainder rather than permanently skipping a noisy burst.
func capEvents(samples []*transport.EventLogSample, max int) []*transport.EventLogSample {
	if max <= 0 {
		max = defaultMaxPerPush
	}
	if len(samples) <= max {
		return samples
	}
	return samples[:max]
}

// itoa64 avoids pulling strconv into the dedupe hot path's key building for a
// single use; trivial base-10.
func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// EventLogOnce is the stream entry point (matches the XxxOnce convention). It
// loads cursors, reads new entries per the platform reader, persists the
// advanced cursors, then runs the shared filter → dedupe → cap pipeline.
// Returns nil on an unsupported platform or any reader error (best-effort, like
// the other collectors).
func EventLogOnce(stateDir string, filter EventLogFilter) []*transport.EventLogSample {
	cursors := loadCursors(stateDir)
	events, newCursors, err := readPlatformEvents(cursors, filter)
	// Persist whatever cursor progress the reader made even if it also
	// returned an error mid-stream — avoids re-reading the same entries.
	if newCursors != nil {
		_ = saveCursors(stateDir, newCursors)
	}
	if err != nil || len(events) == 0 {
		return nil
	}
	min := filter.MinLevel
	if min == "" {
		min = "error"
	}
	filtered := events[:0]
	for _, e := range events {
		e.Level = normalizeLevel(e.Level)
		if meetsMinLevel(e.Level, min) {
			filtered = append(filtered, e)
		}
	}
	deduped := dedupeEvents(filtered)
	// Stable order by timestamp so the cap keeps the oldest deterministically.
	sort.SliceStable(deduped, func(i, j int) bool { return deduped[i].Timestamp < deduped[j].Timestamp })
	return capEvents(deduped, filter.MaxPerPush)
}
