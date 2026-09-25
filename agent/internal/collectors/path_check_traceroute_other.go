//go:build !linux && !windows

package collectors

import (
	"context"
	"net"
)

// No unprivileged traceroute path outside Linux and Windows in v1. The check
// itself still runs; its traceroute row carries this note and no hops.
func platformTraceroute(_ context.Context, _ net.IP, _ tracerouteOpts) ([]probeResult, error) {
	return nil, ErrTracerouteUnsupported
}
