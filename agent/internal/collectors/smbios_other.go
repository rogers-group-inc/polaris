//go:build !windows

package collectors

import "errors"

// readRawSMBIOS is Windows-only. Linux exposes the same firmware values
// through /sys/class/dmi/id and macOS through ioreg, both of which the
// per-OS readPlatformDMI already reads — no raw table parsing needed there.
// The parser in smbios.go stays platform-neutral so it builds and tests
// everywhere; this stub is what keeps the link satisfied.
func readRawSMBIOS() ([]byte, error) {
	return nil, errors.New("smbios: raw firmware table is only read on Windows")
}
