//go:build windows

package reboot

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Written by Polaris's "enable reboots" step (src/utils/agentRebootPermission.ts
// → WINDOWS_REBOOT_MARKER_REL), inside the agent's conf directory so an
// uninstall removes it with everything else.
func markerPath() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "Polaris", "agent", "reboot.enabled")
}

func markerPresent() bool {
	st, err := os.Stat(markerPath())
	return err == nil && st.Mode().IsRegular()
}

// The service runs as LocalSystem, which holds SeShutdownPrivilege: the
// marker is the whole of the opt-in here.
func capable() bool { return markerPresent() }

func reboot(delay time.Duration, comment string) error {
	if !markerPresent() {
		return fmt.Errorf("reboots are not enabled on this host (no %s)", markerPath())
	}
	secs := int(delay / time.Second)
	if secs < 1 {
		secs = 1
	}
	// /f closes applications that would otherwise hold the restart (no one is
	// at a service's desktop to answer them); /d p:0:0 records it as planned.
	c := strings.ReplaceAll(comment, `"`, "'")
	if len(c) > 500 {
		c = c[:500]
	}
	args := []string{"/r", "/f", "/t", strconv.Itoa(secs), "/d", "p:0:0", "/c", c}
	if out, err := exec.Command("shutdown.exe", args...).CombinedOutput(); err != nil {
		return fmt.Errorf("shutdown.exe refused the reboot: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
