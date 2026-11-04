//go:build linux

package collectors

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// readJournaldComm reads journal entries for a program (matched by _COMM) since
// `afterCursor`, returning the new lines + the advanced cursor. On firstRun it
// seeds the cursor at the tail and emits nothing (no historical dump).
// cgo-free — shells out to journalctl (the sdjournal binding needs cgo).
func readJournaldComm(name, afterCursor string, maxLines int, firstRun bool) ([]rawLogLine, string) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, "" // non-systemd host
	}
	if firstRun {
		return nil, journaldCommTailCursor(name)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl",
		"_COMM="+name,
		"--after-cursor="+afterCursor,
		"-o", "json", "--no-pager", "-n", strconv.Itoa(maxLines),
	)
	out, err := cmd.Output()
	if err != nil {
		// Cursor may have aged out (rotation) — reseed at tail so we resume.
		return nil, journaldCommTailCursor(name)
	}
	return parseJournaldLogLines(out)
}

// journaldCommTailCursor returns the newest cursor for the program's journal
// without emitting entries. Empty on failure.
func journaldCommTailCursor(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl", "_COMM="+name, "-n", "0", "--show-cursor", "--no-pager", "-o", "cat")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	cursor := ""
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "cursor:"); i >= 0 {
			cursor = trimSpace(line[i+len("cursor:"):])
		}
	}
	return cursor
}

// readJournaldUnit reads journal entries for a systemd UNIT (journalctl -u
// <unit>) since afterCursor — the service-dimension counterpart of
// readJournaldComm. Same cursor + first-run-seeds-at-tail semantics.
func readJournaldUnit(unit, afterCursor string, maxLines int, firstRun bool) ([]rawLogLine, string) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, "" // non-systemd host
	}
	if firstRun {
		return nil, journaldUnitTailCursor(unit)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl",
		"-u", unit,
		"--after-cursor="+afterCursor,
		"-o", "json", "--no-pager", "-n", strconv.Itoa(maxLines),
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, journaldUnitTailCursor(unit) // cursor aged out — reseed at tail
	}
	return parseJournaldLogLines(out)
}

// journaldUnitTailCursor returns the newest cursor for a unit's journal without
// emitting entries. Empty on failure.
func journaldUnitTailCursor(unit string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "journalctl", "-u", unit, "-n", "0", "--show-cursor", "--no-pager", "-o", "cat")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	sc := bufio.NewScanner(bytes.NewReader(out))
	cursor := ""
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "cursor:"); i >= 0 {
			cursor = trimSpace(line[i+len("cursor:"):])
		}
	}
	return cursor
}

// parseJournaldLogLines parses one-JSON-object-per-line output into rawLogLines
// (oldest-first) + the last entry's __CURSOR.
func parseJournaldLogLines(b []byte) ([]rawLogLine, string) {
	var lines []rawLogLine
	lastCursor := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		raw := sc.Bytes()
		if len(raw) == 0 {
			continue
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		msg := jsonLineField(m, "MESSAGE")
		if msg == "" {
			continue
		}
		lines = append(lines, rawLogLine{
			Timestamp: realtimeToRFC3339(jsonLineField(m, "__REALTIME_TIMESTAMP")),
			Level:     normalizeLevel(jsonLineField(m, "PRIORITY")),
			Message:   msg,
		})
		if c := jsonLineField(m, "__CURSOR"); c != "" {
			lastCursor = c
		}
	}
	return lines, lastCursor
}
