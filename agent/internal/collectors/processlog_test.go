package collectors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Business rule 119 (re-scan F68): file-glob tailing must never read through a
// link an unprivileged account planted in the log directory.

func writeLog(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendLog(t *testing.T, path, body string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(body); err != nil {
		t.Fatal(err)
	}
}

func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symlink here (needs privilege / developer mode?): %v", err)
	}
}

func messages(t *testing.T, name, glob string, cursors map[string]string) []string {
	t.Helper()
	var out []string
	for _, s := range fileLogSamples(name, glob, cursors, 100) {
		out = append(out, s.Message)
	}
	return out
}

func TestFileLogRegularFileTailed(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, "old line\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}

	if got := messages(t, "app", glob, cursors); len(got) != 0 {
		t.Fatalf("first poll should seed at EOF, got %v", got)
	}
	appendLog(t, p, "new one\nnew two\npartial")
	got := messages(t, "app", glob, cursors)
	if strings.Join(got, "|") != "new one|new two" {
		t.Fatalf("got %v", got)
	}
	if got := messages(t, "app", glob, cursors); len(got) != 0 {
		t.Fatalf("no new complete lines, got %v", got)
	}
}

func TestFileLogTruncateInPlaceRereads(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}
	messages(t, "app", glob, cursors) // seed

	// Same file (same identity), truncated then rewritten shorter.
	if err := os.Truncate(p, 0); err != nil {
		t.Fatal(err)
	}
	appendLog(t, p, "fresh\n")
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "fresh" {
		t.Fatalf("truncate-in-place should re-read from 0, got %v", got)
	}
}

func TestFileLogSymlinkMatchSkipped(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(t.TempDir(), "shadow")
	writeLog(t, secret, "root:secret-hash\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}
	symlinkOrSkip(t, secret, filepath.Join(dir, "evil.log"))

	for i := 0; i < 3; i++ {
		if got := messages(t, "app", glob, cursors); len(got) != 0 {
			t.Fatalf("poll %d read through a symlink: %v", i, got)
		}
		appendLog(t, secret, "more secret\n")
	}
	if _, ok := cursors["file:"+filepath.Join(dir, "evil.log")]; ok {
		t.Fatalf("a skipped link should not get a cursor")
	}
}

func TestFileLogRotationToNewFileReadsFromZero(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, "short\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}
	messages(t, "app", glob, cursors) // seed at a small offset

	// Rotate: the old file moves aside, a new (singly-linked) file takes the
	// path — LONGER than the old offset, so only the identity says it is new.
	if err := os.Rename(p, filepath.Join(dir, "app.log.1")); err != nil {
		t.Fatal(err)
	}
	writeLog(t, p, "rotated one\nrotated two\n")
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "rotated one|rotated two" {
		t.Fatalf("a rotated-in file must be read from its start, got %v", got)
	}
	appendLog(t, p, "after rotation\n")
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "after rotation" {
		t.Fatalf("tailing should resume on the new file, got %v", got)
	}
}

func TestFileLogHardLinkSwapSkipped(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, strings.Repeat("x", 4096)+"\n")
	// A file the writer of the log directory cannot read, on the same volume.
	secret := filepath.Join(t.TempDir(), "shadow")
	writeLog(t, secret, "root:secret-hash\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}
	messages(t, "app", glob, cursors) // seed
	seeded := cursors["file:"+p]

	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, p); err != nil {
		t.Skipf("cannot create a hard link here: %v", err)
	}
	for i := 0; i < 3; i++ {
		if got := messages(t, "app", glob, cursors); len(got) != 0 {
			t.Fatalf("poll %d read a hard-linked file: %v", i, got)
		}
		appendLog(t, secret, "more secret\n")
	}
	if cursors["file:"+p] != seeded {
		t.Fatalf("a skipped hard link must not move the cursor: %q → %q", seeded, cursors["file:"+p])
	}
}

func TestFileLogHardLinkFirstSightingSkipped(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(t.TempDir(), "shadow")
	writeLog(t, secret, "root:secret-hash\n")
	p := filepath.Join(dir, "evil.log")
	if err := os.Link(secret, p); err != nil {
		t.Skipf("cannot create a hard link here: %v", err)
	}
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{}
	for i := 0; i < 2; i++ {
		if got := messages(t, "app", glob, cursors); len(got) != 0 {
			t.Fatalf("poll %d read a hard-linked file: %v", i, got)
		}
		appendLog(t, secret, "more secret\n")
	}
	if _, ok := cursors["file:"+p]; ok {
		t.Fatal("a hard-linked file must never be seeded")
	}
}

func TestFileLogLegacyCursorKeepsOffset(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, "line one\nline two\n")
	glob := filepath.Join(dir, "*.log")
	// A cursor saved by an agent before identities were tracked.
	cursors := map[string]string{"file:" + p: "9"}
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "line two" {
		t.Fatalf("a cursor with no identity must keep its offset, got %v", got)
	}
	if cursors["fileid:"+p] == "" {
		t.Fatal("the current identity should be adopted")
	}
}

func TestFileLogLegacyCursorPastEOFRereads(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "app.log")
	writeLog(t, p, "line one\n")
	glob := filepath.Join(dir, "*.log")
	cursors := map[string]string{"file:" + p: "99999"}
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "line one" {
		t.Fatalf("the truncation rule still applies to a legacy cursor, got %v", got)
	}
}

func TestFileLogSymlinkedGlobDirectoryAllowed(t *testing.T) {
	real := t.TempDir()
	p := filepath.Join(real, "app.log")
	writeLog(t, p, "seed\n")
	linkDir := filepath.Join(t.TempDir(), "logs")
	symlinkOrSkip(t, real, linkDir)
	glob := filepath.Join(linkDir, "*.log")
	cursors := map[string]string{}

	messages(t, "app", glob, cursors) // seed
	appendLog(t, p, "via linked dir\n")
	if got := messages(t, "app", glob, cursors); strings.Join(got, "|") != "via linked dir" {
		t.Fatalf("a link in the literal glob prefix must be followed, got %v", got)
	}
}

func TestFileLogSymlinkInWildcardDirectorySkipped(t *testing.T) {
	root := t.TempDir()
	secretDir := t.TempDir()
	writeLog(t, filepath.Join(secretDir, "app.log"), "secret\n")
	symlinkOrSkip(t, secretDir, filepath.Join(root, "evil"))
	glob := filepath.Join(root, "*", "app.log")
	cursors := map[string]string{}

	messages(t, "app", glob, cursors)
	appendLog(t, filepath.Join(secretDir, "app.log"), "more secret\n")
	if got := messages(t, "app", glob, cursors); len(got) != 0 {
		t.Fatalf("a link in a wildcard directory component must be refused, got %v", got)
	}
}

func TestGlobLiteralDir(t *testing.T) {
	sep := string(filepath.Separator)
	cases := map[string]string{
		filepath.Join("a", "b", "*.log"):     filepath.Join("a", "b"),
		filepath.Join("a", "*", "x.log"):     "a",
		filepath.Join("a", "b", "c.log"):     filepath.Join("a", "b"),
		"*.log":                              "",
		sep + "*.log":                        sep,
		filepath.Join("a", "b[12]", "c.log"): "a",
	}
	for in, want := range cases {
		if got := globLiteralDir(in); got != want {
			t.Errorf("globLiteralDir(%q) = %q, want %q", in, got, want)
		}
	}
}

// The Lstat check can be raced; the open itself must refuse a link too.
func TestOpenLogNoFollowRefusesSymlink(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "shadow")
	writeLog(t, secret, "root:secret-hash\n")
	link := filepath.Join(t.TempDir(), "app.log")
	symlinkOrSkip(t, secret, link)
	if f, _, _, _, err := openLogNoFollow(link); err == nil {
		f.Close()
		t.Fatal("openLogNoFollow followed a symlink")
	}
}
