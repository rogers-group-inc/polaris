package collectors

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// ErrICMPUnsupported is reported VERBATIM when the host will not let an
// unprivileged process open a datagram ICMP socket (Linux: the service's GID
// is outside net.ipv4.ping_group_range). It is a distinct string on purpose:
// the server and UI read it as "this host cannot run ICMP checks", not as
// "the target is down" (business rule 71 — a measurement whose mechanism
// broke says so instead of reading as a failure of the thing measured).
var ErrICMPUnsupported = errors.New("icmp unsupported on this host (ping_group_range)")

// ErrICMPUnsupportedPlatform is reported on an OS with no ICMP path at all.
var ErrICMPUnsupportedPlatform = errors.New("icmp unsupported on this platform")

// ErrICMPTimeout is a probe that got no reply inside its deadline.
var ErrICMPTimeout = errors.New("no echo reply before the timeout")

const (
	icmpTypeEchoReply   = 0
	icmpTypeDestUnreach = 3
	icmpTypeEchoRequest = 8
	icmpTypeTimeExceed  = 11
)

// icmpChecksum is the RFC 1071 ones'-complement sum.
func icmpChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// buildEchoRequest is the 8-byte ICMP echo header + payload, checksummed.
// Hand-rolled — golang.org/x/net/icmp is not a dependency, and this is the
// whole of what it would be used for.
func buildEchoRequest(id, seq uint16, payload []byte) []byte {
	b := make([]byte, 8+len(payload))
	b[0] = icmpTypeEchoRequest
	b[1] = 0
	binary.BigEndian.PutUint16(b[4:], id)
	binary.BigEndian.PutUint16(b[6:], seq)
	copy(b[8:], payload)
	binary.BigEndian.PutUint16(b[2:], icmpChecksum(b))
	return b
}

// parseEchoReply accepts a bare ICMP message (a Linux datagram socket) or one
// behind an IPv4 header (darwin's datagram socket), detected by the version
// nibble and skipped by IHL.
func parseEchoReply(b []byte) (typ, code uint8, id, seq uint16, payload []byte, ok bool) {
	if len(b) >= 20 && b[0]>>4 == 4 {
		ihl := int(b[0]&0x0f) * 4
		if ihl < 20 || len(b) < ihl+8 {
			return 0, 0, 0, 0, nil, false
		}
		b = b[ihl:]
	}
	if len(b) < 8 {
		return 0, 0, 0, 0, nil, false
	}
	return b[0], b[1], binary.BigEndian.Uint16(b[4:]), binary.BigEndian.Uint16(b[6:]), b[8:], true
}

// runICMP sends one echo and waits for its reply.
func runICMP(ctx context.Context, ip net.IP, timeout time.Duration, s *transport.ConnectivitySample) {
	rtt, err := platformICMPEcho(ctx, ip, timeout)
	if err != nil {
		s.Error = truncateError(err)
		return
	}
	ms := float64(rtt.Microseconds()) / 1000
	s.LatencyMs = fptr(ms)
	s.OK = true
}
