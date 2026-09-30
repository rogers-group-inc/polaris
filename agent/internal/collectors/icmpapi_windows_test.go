//go:build windows

package collectors

import (
	"encoding/binary"
	"net"
	"testing"
)

func echoReplyBuf(addr [4]byte, status, rtt uint32, ttl uint8) []byte {
	b := make([]byte, icmpEchoReplySize)
	copy(b[0:4], addr[:])
	binary.LittleEndian.PutUint32(b[4:8], status)
	binary.LittleEndian.PutUint32(b[8:12], rtt)
	b[24] = ttl
	return b
}

func TestParseIcmpEchoReply(t *testing.T) {
	cases := []struct {
		addr   [4]byte
		status uint32
	}{
		{[4]byte{8, 8, 8, 8}, ipSuccess},
		{[4]byte{10, 0, 0, 1}, ipTTLExpiredTransit},
		{[4]byte{0, 0, 0, 0}, ipReqTimedOut},
	}
	for _, c := range cases {
		addr, status, rtt, ttl, ok := parseIcmpEchoReply(echoReplyBuf(c.addr, c.status, 12, 54))
		if !ok || status != c.status || rtt != 12 || ttl != 54 || addr.String() != net4(c.addr) {
			t.Errorf("%v: got %v %d %d %d %v", c, addr, status, rtt, ttl, ok)
		}
	}
	if _, _, _, _, ok := parseIcmpEchoReply(make([]byte, 10)); ok {
		t.Error("a short buffer must be refused")
	}
}

// An MPLS router's RFC 4884 / 4950 Time Exceeded: 8-byte ICMP header, a
// 128-byte quote padded to 128, a 4-byte extension header and an 8-byte
// label-stack object. Headroom, not the traceroute fix (that is one probe at
// a time) — the buffer must simply never be the reason a reply is lost.
const mplsTimeExceededBytes = 8 + 128 + 4 + 8

func TestIcmpReplyBufSizeHasRoomForExtendedICMPErrors(t *testing.T) {
	payload := len("polaris-path-check-trace")
	got := icmpReplyBufSize(payload)
	minimum := icmpEchoReplySize + payload + 8 + 16
	if got < icmpEchoReplySize+payload+mplsTimeExceededBytes+16 {
		t.Fatalf("buffer %d cannot hold an MPLS Time Exceeded", got)
	}
	if got <= minimum {
		t.Fatalf("buffer %d is no bigger than the MSDN minimum %d", got, minimum)
	}
	// Room for the largest ICMP error a router sends (RFC 1812 caps it at 576).
	if got < icmpEchoReplySize+576+16 {
		t.Fatalf("buffer %d cannot hold a 576-byte ICMP error", got)
	}
	if icmpReplyBufRetry <= got {
		t.Fatalf("the retry buffer %d must be bigger than the first %d", icmpReplyBufRetry, got)
	}
}

func TestReplyDidNotFit(t *testing.T) {
	if !replyDidNotFit(ipBufTooSmall) || !replyDidNotFit(122) { // 122 = ERROR_INSUFFICIENT_BUFFER
		t.Error("both too-small signals must trigger the retry")
	}
	for _, s := range []uint32{ipSuccess, ipTTLExpiredTransit, ipReqTimedOut, ipDestHostUnreachable} {
		if replyDidNotFit(s) {
			t.Errorf("status %d is not a too-small buffer", s)
		}
	}
}

func net4(a [4]byte) string {
	return net.IPv4(a[0], a[1], a[2], a[3]).String()
}
