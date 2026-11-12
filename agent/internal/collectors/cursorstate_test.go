package collectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWriteFileAtomicCreatesAndReplaces(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if err := writeFileAtomic(p, []byte("first"), 0o600); err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := writeFileAtomic(p, []byte("second"), 0o600); err != nil {
		t.Fatalf("replace: %v", err)
	}
	b, err := os.ReadFile(p)
	if err != nil || string(b) != "second" {
		t.Fatalf("content = %q, %v; want second", b, err)
	}
	// No tempfile left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("dir holds %v, want only state.json", names)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(p)
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, want 0600", fi.Mode().Perm())
		}
	}
}

func TestWriteFileAtomicMissingDirFailsCleanly(t *testing.T) {
	p := filepath.Join(t.TempDir(), "no-such-dir", "state.json")
	if err := writeFileAtomic(p, []byte("x"), 0o600); err == nil {
		t.Fatal("want an error writing into a missing directory")
	}
}

func TestWriteFileAtomicFailedRenameLeavesOldFileAndNoTemp(t *testing.T) {
	dir := t.TempDir()
	// The target is a non-empty DIRECTORY, so the rename fails on every OS.
	p := filepath.Join(dir, "target")
	if err := os.MkdirAll(filepath.Join(p, "child"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(p, []byte("x"), 0o600); err == nil {
		t.Fatal("want an error renaming over a non-empty directory")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("tempfile %s left behind after a failed rename", e.Name())
		}
	}
}

func TestCursorFileRoundTripAndMissingCorrupt(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "x-cursors.json")

	// Missing file → empty, non-nil map.
	if got := loadCursorFile(p); got == nil || len(got) != 0 {
		t.Fatalf("missing file: got %v, want empty non-nil map", got)
	}

	in := map[string]string{"journald": "s=abc;i=1", "journald-unit:sshd.service": "s=def"}
	if err := saveCursorFile(p, in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out := loadCursorFile(p)
	if len(out) != len(in) {
		t.Fatalf("round trip: got %v, want %v", out, in)
	}
	for k, v := range in {
		if out[k] != v {
			t.Fatalf("round trip %q: got %q, want %q", k, out[k], v)
		}
	}
	// On-disk shape is unchanged: {"version":1,"channels":{...}}.
	b, _ := os.ReadFile(p)
	var cf cursorFile
	if err := json.Unmarshal(b, &cf); err != nil || cf.Version != 1 {
		t.Fatalf("on-disk shape: %s (%v)", b, err)
	}

	// Corrupt file → empty, non-nil map.
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadCursorFile(p); got == nil || len(got) != 0 {
		t.Fatalf("corrupt file: got %v, want empty non-nil map", got)
	}
	// Valid JSON with no channels → empty, non-nil map.
	if err := os.WriteFile(p, []byte(`{"version":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadCursorFile(p); got == nil || len(got) != 0 {
		t.Fatalf("no channels: got %v, want empty non-nil map", got)
	}
}

func TestSaveCursorFileMissingDirReturnsError(t *testing.T) {
	p := filepath.Join(t.TempDir(), "gone", "x-cursors.json")
	if err := saveCursorFile(p, map[string]string{"a": "b"}); err == nil {
		t.Fatal("want an error when the state dir is missing")
	}
}

func TestJSONLineField(t *testing.T) {
	var m map[string]json.RawMessage
	line := `{"MESSAGE":"hello","PRIORITY":"3","BLOB":[104,105],"NUL":null,"NUM":7}`
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatal(err)
	}
	m["EMPTY"] = json.RawMessage{}
	cases := map[string]string{
		"MESSAGE":  "hello",
		"PRIORITY": "3",
		"BLOB":     "", // journald's array-of-bytes form for non-UTF8 data
		"NUL":      "",
		"NUM":      "", // not a string
		"EMPTY":    "",
		"MISSING":  "",
	}
	for key, want := range cases {
		if got := jsonLineField(m, key); got != want {
			t.Errorf("jsonLineField(%q) = %q, want %q", key, got, want)
		}
	}
	if got := jsonLineField(nil, "MESSAGE"); got != "" {
		t.Errorf("nil map: got %q", got)
	}
}

func TestParseShowCursor(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"journalctl output", "-- cursor: s=abc;i=1f;b=00;m=2;t=5;x=9\n", "s=abc;i=1f;b=00;m=2;t=5;x=9"},
		{"CRLF and tabs", "-- cursor:\t s=abc \r\n", "s=abc"},
		{"no trailing newline", "-- cursor: s=abc", "s=abc"},
		{"last cursor line wins", "-- cursor: s=old\nnoise\n-- cursor: s=new\n", "s=new"},
		{"no cursor line", "-- No entries --\n", ""},
		{"empty", "", ""},
		// Same cutset as the hand-rolled trimSpace it replaced: a vertical
		// tab or NBSP is NOT trimmed (strings.TrimSpace would trim both).
		{"vertical tab kept", "-- cursor: s=abc\v\n", "s=abc\v"},
		{"nbsp kept", "-- cursor:  s=abc\n", " s=abc"},
	}
	for _, c := range cases {
		if got := parseShowCursor([]byte(c.in)); got != c.want {
			t.Errorf("%s: parseShowCursor(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}
