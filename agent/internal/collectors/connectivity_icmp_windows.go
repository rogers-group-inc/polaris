//go:build windows

package collectors

import (
	"context"
	"fmt"
	"net"
	"time"
)

// platformICMPEcho sends one echo at TTL 128 through the ICMP API.
func platformICMPEcho(ctx context.Context, dst net.IP, timeout time.Duration) (time.Duration, error) {
	if d, ok := ctx.Deadline(); ok {
		if left := time.Until(d); left < timeout {
			timeout = left
		}
	}
	if timeout <= 0 {
		return 0, ErrICMPTimeout
	}
	h, err := openICMP()
	if err != nil {
		return 0, err
	}
	defer h.Close()
	_, status, rtt, err := h.echo(dst, 128, []byte("polaris-connectivity"), timeout)
	if err != nil {
		return 0, err
	}
	switch status {
	case ipSuccess:
		return rtt, nil
	case ipReqTimedOut:
		return 0, ErrICMPTimeout
	case ipDestHostUnreachable, ipDestNetUnreachable:
		return 0, fmt.Errorf("destination unreachable (status %d)", status)
	default:
		return 0, fmt.Errorf("echo failed (status %d)", status)
	}
}
