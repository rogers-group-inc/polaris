//go:build darwin

package reboot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Written by Polaris's "enable reboots" step
// (src/utils/agentRebootPermission.ts → DARWIN_REBOOT_MARKER). The
// LaunchDaemon runs as root, so the marker is the whole of the opt-in.
const markerPath = "/etc/polaris-agent/reboot.enabled"

func markerPresent() bool {
	st, err := os.Stat(markerPath)
	return err == nil && st.Mode().IsRegular()
}

func capable() bool { return markerPresent() }

// shutdownCommandTimeout bounds the shutdown call itself, not the reboot.
const shutdownCommandTimeout = 30 * time.Second

func reboot(delay time.Duration, _ string) error {
	if !markerPresent() {
		return fmt.Errorf("reboots are not enabled on this host (no %s)", markerPath)
	}
	time.Sleep(delay)
	// shutdown returns once the reboot is scheduled; bound it (CQ-G012) so a
	// wedged one is reported instead of holding the command forever.
	ctx, cancel := context.WithTimeout(context.Background(), shutdownCommandTimeout)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "/sbin/shutdown", "-r", "now").CombinedOutput(); err != nil {
		return fmt.Errorf("shutdown refused the reboot: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
