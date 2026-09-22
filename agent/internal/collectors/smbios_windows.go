//go:build windows

package collectors

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// rsmbProvider is the 'RSMB' firmware-table provider signature — the raw
// SMBIOS table. Built from the four characters in the order they're written,
// matching the multi-character literal the Win32 docs use.
const rsmbProvider = uint32('R')<<24 | uint32('S')<<16 | uint32('M')<<8 | uint32('B')

var (
	modkernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemFirmwareTbl = modkernel32.NewProc("GetSystemFirmwareTable")
)

// readRawSMBIOS returns the RawSMBIOSData blob (8-byte header + table data).
//
// Two calls: the first with a nil buffer asks the required size, the second
// fills it. No privileges are needed — the API is callable by any token,
// which is what lets the agent read it as an unprivileged service user.
// Available since Windows Vista / Server 2008; the LazyDLL Find() makes an
// older host a clean fallback rather than a load-time crash.
func readRawSMBIOS() ([]byte, error) {
	if err := procGetSystemFirmwareTbl.Find(); err != nil {
		return nil, fmt.Errorf("GetSystemFirmwareTable unavailable: %w", err)
	}

	size, _, err := procGetSystemFirmwareTbl.Call(
		uintptr(rsmbProvider),
		0, // FirmwareTableID — unused for RSMB
		0, // pFirmwareTableBuffer — nil to query the size
		0, // BufferSize
	)
	if size == 0 {
		return nil, fmt.Errorf("GetSystemFirmwareTable size query failed: %w", err)
	}

	buf := make([]byte, size)
	written, _, err := procGetSystemFirmwareTbl.Call(
		uintptr(rsmbProvider),
		0,
		uintptr(unsafe.Pointer(&buf[0])),
		size,
	)
	if written == 0 {
		return nil, fmt.Errorf("GetSystemFirmwareTable read failed: %w", err)
	}
	if written < size {
		buf = buf[:written]
	}
	return buf, nil
}
