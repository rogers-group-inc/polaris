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

func net4(a [4]byte) string {
	return net.IPv4(a[0], a[1], a[2], a[3]).String()
}
