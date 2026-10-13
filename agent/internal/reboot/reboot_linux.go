//go:build linux

package reboot

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Written as root by Polaris's "enable reboots" step
// (src/utils/agentRebootPermission.ts → LINUX_REBOOT_MARKER).
const markerPath = "/etc/polaris-agent-reboot.enabled"

func markerPresent() bool {
	st, err := os.Stat(markerPath)
	return err == nil && st.Mode().IsRegular()
}

// busctl talks to logind over the system bus as the agent's own user, so the
// answer is polkit's verdict for THIS process — "yes" only when the rule the
// opt-in installed applies to it.
func busctl(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "busctl", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func capable() bool {
	if !markerPresent() {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := busctl(ctx, "call", "org.freedesktop.login1", "/org/freedesktop/login1",
		"org.freedesktop.login1.Manager", "CanReboot")
	if err != nil {
		return false
	}
	// `s "yes"` — anything else ("challenge", "no", "na") means logind would
	// refuse a non-interactive request from this process.
	return parseCanReboot(out) == "yes"
}

// parseCanReboot reads busctl's `s "<answer>"` reply.
func parseCanReboot(out string) string {
	out = strings.TrimSpace(out)
	if !strings.HasPrefix(out, "s ") {
		return ""
	}
	return strings.Trim(strings.TrimSpace(strings.TrimPrefix(out, "s ")), `"`)
}

func reboot(delay time.Duration, _ string) error {
	if !markerPresent() {
		return fmt.Errorf("reboots are not enabled on this host (no %s)", markerPath)
	}
	time.Sleep(delay)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Reboot(interactive=false): polkit decides without prompting anyone.
	if out, err := busctl(ctx, "call", "org.freedesktop.login1", "/org/freedesktop/login1",
		"org.freedesktop.login1.Manager", "Reboot", "b", "false"); err != nil {
		return fmt.Errorf("logind refused the reboot: %v: %s", err, out)
	}
	return nil
}
