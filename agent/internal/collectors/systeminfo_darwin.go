//go:build darwin

package collectors

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// readPlatformDMI reads vendor / model / serial from ioreg (in-kernel
// IORegistry), which is the macOS analogue of /sys/class/dmi.
// ioreg ships in /usr/sbin on every Mac and is callable without sudo.
//
// We parse the line-oriented output rather than the XML form because
// (a) the XML form is huge and (b) we only need three fields. Bash
// equivalent: `ioreg -rd1 -c IOPlatformExpertDevice` → look for
// "manufacturer" / "model" / "IOPlatformSerialNumber" lines.
//
// IOPlatformExpertDevice always exists; ioreg failure / missing fields
// just leaves empty strings (projection falls through).
//
// BIOS version on macOS is "boot ROM" version — exposed via system_profiler
// SPHardwareDataType. Skip for now; if operators need it later add a
// dedicated call.
func readPlatformDMI() *platformDMI {
	// Bounded like every other collector exec (CQ-G012): a wedged ioreg must
	// not hold the system-info pass forever.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output()
	if err != nil {
		return &platformDMI{}
	}
	d := &platformDMI{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		// Lines look like:  "manufacturer" = <"Apple Inc.">
		// or:              "IOPlatformSerialNumber" = "C02XL0AAJG5J"
		// We extract the value between the angle-quotes or quotes.
		switch {
		case strings.HasPrefix(line, `"manufacturer" =`):
			d.Manufacturer = extractIoregValue(line)
		case strings.HasPrefix(line, `"model" =`):
			d.Model = extractIoregValue(line)
		case strings.HasPrefix(line, `"IOPlatformSerialNumber" =`):
			d.Serial = extractIoregValue(line)
		}
	}
	return d
}

// extractIoregValue pulls the value half of a ioreg line. The value is
// either: `<"text">` (angled-quoted) or `"text"` (plain). We strip
// surrounding `<`/`>` and quotes uniformly.
func extractIoregValue(line string) string {
	eq := strings.Index(line, "=")
	if eq < 0 {
		return ""
	}
	v := strings.TrimSpace(line[eq+1:])
	v = strings.TrimPrefix(v, "<")
	v = strings.TrimSuffix(v, ">")
	v = strings.TrimPrefix(v, `"`)
	v = strings.TrimSuffix(v, `"`)
	return v
}
