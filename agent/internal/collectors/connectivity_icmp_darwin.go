//go:build darwin

package collectors

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

// newICMPDgramSocket opens a datagram ICMP socket. macOS supports these
// unprivileged, but has no SOCK_NONBLOCK / SOCK_CLOEXEC socket flags, so both
// are set after the fact. Replies arrive with their IPv4 header attached —
// parseEchoReply skips it.
func newICMPDgramSocket() (int, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, unix.IPPROTO_ICMP)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return -1, ErrICMPUnsupported
		}
		return -1, fmt.Errorf("icmp socket: %w", err)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return -1, fmt.Errorf("icmp socket: %w", err)
	}
	unix.CloseOnExec(fd)
	return fd, nil
}
