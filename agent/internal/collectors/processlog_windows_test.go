//go:build windows

package collectors

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// Junctions need no privilege on Windows, so they cover the reparse-point arm
// of business rule 119 (re-scan F68) where os.Symlink is refused.

func junctionOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("mklink /J failed: %v %s", err, out)
	}
}

func TestFileLogJunctionInWildcardDirectorySkipped(t *testing.T) {
	root := t.TempDir()
	secretDir := t.TempDir()
	secret := filepath.Join(secretDir, "app.log")
	writeLog(t, secret, "secret\n")
	junctionOrSkip(t, secretDir, filepath.Join(root, "evil"))
	glob := filepath.Join(root, "*", "app.log")
	cursors := map[string]string{}

	messages(t, "app", glob, cursors)
	appendLog(t, secret, "more secret\n")
	if got := messages(t, "app", glob, cursors); len(got) != 0 {
		t.Fatalf("a junction in a wildcard directory component must be refused, got %v", got)
	}
}

func TestFileLogJunctionedGlobDirectoryAllowed(t *testing.T) {
	real := t.TempDir()
	p := filepath.Join(real, "app.log")
	writeLog(t, p, "seed\n")
	linkDir := filepath.Join(t.TempDir(), "logs")
	junctionOrSkip(t, real, linkDir)
	glob := filepath.Join(linkDir, "*.log")
	cursors := map[string]string{}

	messages(t, "app", glob, cursors) // seed
	appendLog(t, p, "via junction\n")
	if got := messages(t, "app", glob, cursors); len(got) != 1 || got[0] != "via junction" {
		t.Fatalf("a junction in the literal glob prefix must be followed, got %v", got)
	}
}

func TestOpenLogNoFollowRefusesDirectory(t *testing.T) {
	if f, _, _, _, err := openLogNoFollow(t.TempDir()); err == nil {
		f.Close()
		t.Fatal("opened a directory as a log file")
	}
}
