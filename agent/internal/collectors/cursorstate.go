// cursorstate.go — the shared local-state helpers behind the three log tails
// (eventlog.go, processlog.go, servicelog.go): the atomic file write, the
// cursor-file codec and load/save, the journald JSON field reader and the
// `journalctl --show-cursor` output parser. No build tag: every OS build sees
// these, and they are pure file IO / parsing, so they are unit-tested on any
// host. The journalctl invocation itself stays Linux-only (journalTailCursor in
// eventlog_linux.go).
package collectors

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// cursorFile is the per-channel resume state, stored as JSON next to agent.conf.
// One shape for all three cursor files (eventlog-, processlog-, servicelog-
// cursors.json).
type cursorFile struct {
	Version  int               `json:"version"`
	Channels map[string]string `json:"channels"`
}

// loadCursorFile reads a cursor map. Missing/unreadable/corrupt file → empty
// (non-nil) map: every channel then first-run-seeds as if never read.
func loadCursorFile(path string) map[string]string {
	b, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	return parseCursors(b)
}

// saveCursorFile atomically writes a cursor map at 0600 (matches config.Save's
// posture even though a cursor holds no secret).
func saveCursorFile(path string, cursors map[string]string) error {
	b, err := marshalCursors(cursors)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, b, 0o600)
}

// parseCursors is the pure decode half of loadCursorFile (unit-tested).
func parseCursors(b []byte) map[string]string {
	var cf cursorFile
	if err := json.Unmarshal(b, &cf); err != nil || cf.Channels == nil {
		return map[string]string{}
	}
	return cf.Channels
}

// marshalCursors is the pure encode half of saveCursorFile (unit-tested).
func marshalCursors(cursors map[string]string) ([]byte, error) {
	return json.Marshal(cursorFile{Version: 1, Channels: cursors})
}

// writeFileAtomic replaces path with data via a uniquely named tempfile in the
// same directory + rename, the pattern config.Save uses: a crash mid-write
// leaves the old file intact, two writers never share a tempfile name, and a
// failed write removes its tempfile. The tempfile is chmod'ed to perm before
// the rename. Errors are returned unwrapped (os.PathError / os.LinkError
// already name the path).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename has moved it
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), perm); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// jsonLineField pulls a string field from a journald -o json object, tolerating
// the array-of-bytes form journald uses for non-UTF8 values (→ ""). A missing
// key, an empty value and JSON null are all "".
func jsonLineField(m map[string]json.RawMessage, key string) string {
	raw, ok := m[key]
	if !ok || len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return ""
}

// cursorLineTrim is the cutset parseShowCursor trims: ASCII space, tab, CR and
// LF only. Deliberately NOT strings.TrimSpace, which also strips \v, \f, U+0085,
// U+00A0 and the other Unicode spaces — this keeps the behaviour of the
// hand-rolled trimSpace it replaces byte-for-byte.
const cursorLineTrim = " \t\r\n"

// parseShowCursor extracts the cursor from `journalctl -n 0 --show-cursor`
// output, which prints it on a trailing line as "-- cursor: s=abc...". The
// LAST line containing "cursor:" wins; "" when there is none.
func parseShowCursor(out []byte) string {
	sc := bufio.NewScanner(bytes.NewReader(out))
	cursor := ""
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "cursor:"); i >= 0 {
			cursor = strings.Trim(line[i+len("cursor:"):], cursorLineTrim)
		}
	}
	return cursor
}
