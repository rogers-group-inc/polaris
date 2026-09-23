//go:build linux

package collectors

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

// newICMPDgramSocket opens an unprivileged ICMP "ping" socket. Allowed when the
// process's GID is inside net.ipv4.ping_group_range — systemd ≥ 243 ships
// 0..2147483647 (RHEL 9, Ubuntu 22.04+), RHEL 8 does not. EACCES / EPERM is
// reported as ErrICMPUnsupported so it reads as "cannot measure", never "down".
func newICMPDgramSocket() (int, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, unix.IPPROTO_ICMP)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) || errors.Is(err, unix.EPROTONOSUPPORT) {
			return -1, ErrICMPUnsupported
		}
		return -1, fmt.Errorf("icmp socket: %w", err)
	}
	return fd, nil
}
