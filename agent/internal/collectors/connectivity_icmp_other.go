//go:build !linux && !darwin && !windows

package collectors

import (
	"context"
	"net"
	"time"
)

func platformICMPEcho(_ context.Context, _ net.IP, _ time.Duration) (time.Duration, error) {
	return 0, ErrICMPUnsupportedPlatform
}
