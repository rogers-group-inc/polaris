//go:build linux

package collectors

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"time"
)

// journaldCursorKey is the single cursor map key for the unified journald
// stream (unlike Windows, journald is one log; per-unit channels are a filter,
// not separate cursors).
const journaldCursorKey = "journald"

// readPlatformEvents (Linux) shells out to journalctl. cgo-free path — the
// sdjournal binding needs libsystemd at build time and would break the static
// cross-compile matrix (CGO_ENABLED=0). Non-systemd hosts (no journalctl) →
// nil, nil, nil (best-effort no-op).
//
// First run (no saved cursor): capture the tail cursor WITHOUT emitting history.
// Steady state: read entries strictly after the saved cursor, priority-filtered.
func readPlatformEvents(cursors map[string]string, filter EventLogFilter) ([]rawEvent, map[string]string, error) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, nil, nil // non-systemd host
	}
	out := map[string]string{}
	for k, v := range cursors {
		out[k] = v
	}

	prio := filter.LinuxMinPriority
	if prio < 0 || prio > 7 {
		prio = 3
	}
	maxN := filter.MaxPerPush
	if maxN <= 0 {
		maxN = defaultMaxPerPush
	}

	saved := cursors[journaldCursorKey]
	if saved == "" {
		// First run — seed the cursor at the current tail, emit nothing.
		cur := journalTailCursor()
		if cur != "" {
			out[journaldCursorKey] = cur
		}
		return nil, out, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	args := []string{
		"--after-cursor=" + saved,
		"-p", strconv.Itoa(prio),
		"-o", "json",
		"--no-pager",
		"-n", strconv.Itoa(maxN),
	}
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	stdout, err := cmd.Output()
	if err != nil {
		// Cursor may have aged out of the journal (rotation) — reseed at tail
		// so the next poll resumes cleanly instead of erroring forever.
		if cur := journalTailCursor(); cur != "" {
			out[journaldCursorKey] = cur
		}
		return nil, out, nil
	}

	events, lastCursor := parseJournalJSON(stdout)
	if lastCursor != "" {
		out[journaldCursorKey] = lastCursor
	}
	return events, out, nil
}

// journalTailCursor returns the cursor of the most recent journal entry
// matching `match` (journalctl match args placed before the fixed flags: none
// for the whole journal, "_COMM=<name>" for a program, "-u", "<unit>" for a
// unit) without emitting any entries (`-n 0 --show-cursor`). Empty on any
// failure. Shared by the event-log, process-log and service-log tails.
func journalTailCursor(match ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	args := append(append([]string{}, match...), "-n", "0", "--show-cursor", "--no-pager", "-o", "cat")
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	outb, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	return parseShowCursor(outb)
}

// parseJournalJSON parses one-JSON-object-per-line journalctl output into
// rawEvents (oldest-first as journalctl emits) and returns the last entry's
// __CURSOR. Pure given its input bytes — exercised indirectly; the field
// extraction is also covered by the shared helper tests.
func parseJournalJSON(b []byte) ([]rawEvent, string) {
	var events []rawEvent
	lastCursor := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // journal lines can be large
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(line, &m); err != nil {
			continue
		}
		msg := jsonLineField(m, "MESSAGE")
		if msg == "" {
			continue // binary/blob message — skip
		}
		channel := jsonLineField(m, "_SYSTEMD_UNIT")
		if channel == "" {
			channel = jsonLineField(m, "SYSLOG_IDENTIFIER")
		}
		if channel == "" {
			channel = "journald"
		}
		var idPtr *int64 // journald has no stable numeric event id
		ev := rawEvent{
			Timestamp: realtimeToRFC3339(jsonLineField(m, "__REALTIME_TIMESTAMP")),
			Channel:   channel,
			Provider:  jsonLineField(m, "SYSLOG_IDENTIFIER"),
			EventID:   idPtr,
			Level:     jsonLineField(m, "PRIORITY"),
			Message:   msg,
		}
		events = append(events, ev)
		if c := jsonLineField(m, "__CURSOR"); c != "" {
			lastCursor = c
		}
	}
	return events, lastCursor
}

// realtimeToRFC3339 converts journald __REALTIME_TIMESTAMP (microseconds since
// the Unix epoch, as a string) to RFC3339Nano UTC. Empty/garbage → "".
func realtimeToRFC3339(micros string) string {
	if micros == "" {
		return ""
	}
	us, err := strconv.ParseInt(micros, 10, 64)
	if err != nil {
		return ""
	}
	return time.Unix(us/1_000_000, (us%1_000_000)*1000).UTC().Format(time.RFC3339Nano)
}
