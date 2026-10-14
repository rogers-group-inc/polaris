// processlog.go — tail logs for operator-pinned programs (Feature C).
//
// Two sources, chosen per pinned program from its server-delivered log config:
//   - file-glob: tail files matching a wildcard path, tracking a per-file byte
//     offset cursor (cross-platform).
//   - journald: read the program's journal by _COMM=<name> with a journald
//     cursor (Linux only; readJournaldComm is build-tagged, a stub elsewhere).
//   - auto: Linux → journald-by-_COMM, then file-glob if a glob is also set;
//     other OSes → file-glob when a glob is set, else nothing.
//
// Cursors live in processlog-cursors.json next to agent.conf. First run seeds
// each source at its tail (file: current size; journald: tail cursor) so we
// never dump historical logs.
package collectors

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// rawLogLine is one parsed log entry before wire shaping.
type rawLogLine struct {
	Timestamp string // RFC3339Nano, "" → server stamps receipt time
	Level     string // best-effort; "" when unknown
	Message   string
}

const defaultMaxLogLinesPerProcess = 500

func processLogCursorPath(stateDir string) string {
	return filepath.Join(stateDir, "processlog-cursors.json")
}

func loadProcessLogCursors(stateDir string) map[string]string {
	b, err := os.ReadFile(processLogCursorPath(stateDir))
	if err != nil {
		return map[string]string{}
	}
	return parseCursors(b) // reuse eventlog.go's tolerant codec (same shape)
}

func saveProcessLogCursors(stateDir string, cursors map[string]string) error {
	b, err := marshalCursors(cursors)
	if err != nil {
		return err
	}
	tmp := processLogCursorPath(stateDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, processLogCursorPath(stateDir))
}

// ProcessLogOnce tails every pinned program's log since its cursor and returns
// the new lines as wire samples. Mutates + persists the cursor map. Best-effort:
// a per-program failure is skipped, not fatal.
func ProcessLogOnce(stateDir string, pinned []transport.PinnedProcess, maxPerProcess int) []*transport.ProcessLogSample {
	if len(pinned) == 0 {
		return nil
	}
	if maxPerProcess <= 0 {
		maxPerProcess = defaultMaxLogLinesPerProcess
	}
	cursors := loadProcessLogCursors(stateDir)
	var out []*transport.ProcessLogSample
	for _, p := range pinned {
		out = append(out, collectOneProcessLog(p, cursors, maxPerProcess)...)
	}
	_ = saveProcessLogCursors(stateDir, cursors)
	return out
}

func collectOneProcessLog(p transport.PinnedProcess, cursors map[string]string, maxLines int) []*transport.ProcessLogSample {
	useJournald := false
	useFile := false
	switch p.LogSource {
	case "journald-unit":
		useJournald = runtime.GOOS == "linux"
	case "file-glob":
		useFile = p.LogPathGlob != ""
	default: // "auto" / unset
		if runtime.GOOS == "linux" {
			useJournald = true
		}
		useFile = p.LogPathGlob != ""
	}

	var out []*transport.ProcessLogSample
	if useJournald {
		out = append(out, journaldLogSamples(p.Name, cursors, maxLines)...)
	}
	if useFile && len(out) < maxLines {
		out = append(out, fileLogSamples(p.Name, p.LogPathGlob, cursors, maxLines-len(out))...)
	}
	return out
}

// journaldLogSamples reads the program's journal by _COMM and advances the
// per-name journald cursor. readJournaldComm is Linux-only (stub elsewhere).
func journaldLogSamples(name string, cursors map[string]string, maxLines int) []*transport.ProcessLogSample {
	key := "journald:" + name
	lines, newCursor := readJournaldComm(name, cursors[key], maxLines, cursors[key] == "")
	if newCursor != "" {
		cursors[key] = newCursor
	}
	src := "journald:_COMM=" + name
	return toLogSamples(name, lines, src)
}

// fileLogSamples tails every file matching glob from its saved byte offset.
//
// Business rule 119 (re-scan F68): the agent reads with more privilege than
// whoever writes the log directory, so a matched FILE that is a symlink /
// junction / reparse point is skipped (Lstat, then a no-follow open that
// fstats the handle), as is a match reached through a link in a WILDCARD
// directory component, and a matched file with more than one hard link.
// Links in the glob's literal directory prefix — the part the operator typed
// — are allowed. Each path's identity is kept beside its offset: a different
// file at the same path is a rotation and is read from 0.
func fileLogSamples(name, glob string, cursors map[string]string, maxLines int) []*transport.ProcessLogSample {
	matches, err := filepath.Glob(glob)
	if err != nil || len(matches) == 0 {
		return nil
	}
	prefix := globLiteralDir(glob)
	var out []*transport.ProcessLogSample
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, path := range matches {
		if len(out) >= maxLines {
			break
		}
		if reason := logMatchLinkReason(prefix, path); reason != "" {
			if reason != "directory" {
				noteSkippedLog(name, path, reason)
			}
			continue
		}
		f, size, id, nlink, err := openLogNoFollow(path)
		if err != nil {
			if !os.IsNotExist(err) {
				noteSkippedLog(name, path, err.Error())
			}
			continue
		}
		if nlink > 1 {
			// With symlinks refused at open, a HARD link is the remaining way
			// to put a file the directory's writer cannot read at a tailed
			// path — skip it outright: never seeded, never tailed, on every
			// poll. Business rule 119 (re-scan F68).
			f.Close()
			noteSkippedLog(name, path, "hard link ("+strconv.FormatUint(nlink, 10)+" links)")
			continue
		}
		clearSkippedLog(path)
		key := "file:" + path
		idKey := "fileid:" + path
		if _, seeded := cursors[key]; !seeded {
			// First run for this file — seed at EOF, emit nothing.
			cursors[key] = strconv.FormatInt(size, 10)
			cursors[idKey] = id
			f.Close()
			continue
		}
		off, _ := strconv.ParseInt(cursors[key], 10, 64)
		savedID := cursors[idKey]
		switch {
		case savedID == "":
			// A cursor saved before identities were tracked (the upgrade
			// case): adopt this identity and keep the stored offset.
			cursors[idKey] = id
			if off > size {
				off = 0 // truncated/rotated — re-read from the new start
			}
		case savedID != id:
			// A different, singly-linked file now sits at this path
			// (rotation) — read it from the start as a rotated log always
			// was; links were refused above. Business rule 119 (re-scan F68).
			cursors[idKey] = id
			off = 0
		case off > size:
			off = 0 // same file truncated in place — re-read from the new start
		}
		if off == size {
			f.Close()
			continue
		}
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			f.Close()
			continue
		}
		r := bufio.NewReader(f)
		var consumed int64
		src := "file:" + path
		for len(out) < maxLines {
			b, rerr := r.ReadBytes('\n')
			if len(b) > 0 && (rerr == nil || b[len(b)-1] == '\n') {
				// A complete line (terminated by \n). Count + emit.
				consumed += int64(len(b))
				line := strings.TrimRight(string(b), "\r\n")
				if line != "" {
					s := src
					out = append(out, &transport.ProcessLogSample{Timestamp: now, Name: name, Message: line, Source: &s})
				}
			}
			if rerr != nil {
				break // EOF (partial trailing line left for the next poll) or error
			}
		}
		f.Close()
		cursors[key] = strconv.FormatInt(off+consumed, 10)
	}
	return out
}

// globLiteralDir returns the directory part of glob that holds no pattern
// metacharacter — the prefix the operator typed literally. Links inside it
// are trusted; components below it were chosen by a wildcard.
func globLiteralDir(glob string) string {
	i := strings.IndexAny(glob, "*?[")
	if i < 0 {
		return filepath.Dir(glob)
	}
	j := strings.LastIndexAny(glob[:i], `/`+string(filepath.Separator))
	if j < 0 {
		return ""
	}
	return filepath.Clean(glob[:j+1]) // keeps a root ("/", `C:\`) intact
}

// logMatchLinkReason returns why a glob match must not be read ("" = fine):
// the matched file itself is a link / reparse point or not a regular file, or
// a directory component between the literal prefix and the file is a link.
func logMatchLinkReason(prefix, path string) string {
	info, err := os.Lstat(path)
	if err != nil {
		return "" // vanished — the open reports it
	}
	if isLinkInfo(info) {
		return "symbolic link"
	}
	if info.IsDir() {
		return "directory" // a glob that also matches subdirectories — not news
	}
	if !info.Mode().IsRegular() {
		return "not a regular file"
	}
	rel := filepath.Dir(path) // relative glob, wildcard in its first component
	if prefix != "" {
		r, err := filepath.Rel(prefix, rel)
		if err != nil || strings.HasPrefix(r, "..") {
			return ""
		}
		rel = r
	}
	if rel == "." {
		return "" // the file sits directly in the literal prefix
	}
	dir := prefix
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		if dir == "" {
			dir = part
		} else {
			dir = filepath.Join(dir, part)
		}
		if di, err := os.Lstat(dir); err == nil && isLinkInfo(di) {
			return "symbolic link in directory " + dir
		}
	}
	return ""
}

// skippedLogNotes remembers which paths have already been logged as skipped,
// so a refused match is reported once, not every poll. There is no per-program
// status channel to the server for processLog, so the note goes to the agent's
// own log. A path that later reads cleanly is forgotten again.
var (
	skippedLogMu    sync.Mutex
	skippedLogNotes = map[string]string{}
)

func noteSkippedLog(name, path, reason string) {
	skippedLogMu.Lock()
	defer skippedLogMu.Unlock()
	if skippedLogNotes[path] == reason {
		return
	}
	skippedLogNotes[path] = reason
	log.Printf("processLog %s: skipped %s: %s", name, path, reason)
}

func clearSkippedLog(path string) {
	skippedLogMu.Lock()
	delete(skippedLogNotes, path)
	skippedLogMu.Unlock()
}

func toLogSamples(name string, lines []rawLogLine, source string) []*transport.ProcessLogSample {
	if len(lines) == 0 {
		return nil
	}
	out := make([]*transport.ProcessLogSample, 0, len(lines))
	for _, l := range lines {
		s := source
		sample := &transport.ProcessLogSample{Timestamp: l.Timestamp, Name: name, Message: l.Message, Source: &s}
		if l.Level != "" {
			lvl := l.Level
			sample.Level = &lvl
		}
		out = append(out, sample)
	}
	return out
}

// jsonLineField pulls a string field from a journald -o json object, tolerating
// the array-of-bytes form journald uses for non-UTF8 values (→ "").
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
