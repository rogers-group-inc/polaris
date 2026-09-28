//go:build linux

package collectors

// readServiceUnitLog (Linux) reads the unit's journal since its cursor
// (journalctl -u <unit>); the first run seeds at the tail and emits nothing.
// Advances cursors in place and returns the lines with their source label.
func readServiceUnitLog(unit string, cursors map[string]string, maxLines int) ([]rawLogLine, string) {
	key := "journald-unit:" + unit
	lines, newCursor := readJournaldUnit(unit, cursors[key], maxLines, cursors[key] == "")
	if newCursor != "" {
		cursors[key] = newCursor
	}
	return lines, "journald:-u " + unit
}
