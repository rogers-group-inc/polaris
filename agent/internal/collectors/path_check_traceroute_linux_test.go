//go:build linux

package collectors

import (
	"encoding/binary"
	"testing"

	"golang.org/x/sys/unix"
)

func recvErrMsg(origin, typ, code uint8, offender [4]byte) []byte {
	b := make([]byte, 32)
	binary.NativeEndian.PutUint32(b[0:4], uint32(unix.EHOSTUNREACH))
	b[4], b[5], b[6] = origin, typ, code
	binary.NativeEndian.PutUint16(b[16:18], unix.AF_INET)
	copy(b[20:24], offender[:])
	return b
}

func TestParseRecvErr(t *testing.T) {
	typ, code, off, ok := parseRecvErr(recvErrMsg(soEEOriginICMP, 11, 0, [4]byte{10, 0, 0, 1}))
	if !ok || typ != 11 || code != 0 || off.String() != "10.0.0.1" {
		t.Fatalf("time exceeded: %v %d %d %v", ok, typ, code, off)
	}
	typ, code, off, ok = parseRecvErr(recvErrMsg(soEEOriginICMP, 3, 3, [4]byte{8, 8, 8, 8}))
	if !ok || typ != 3 || code != 3 || off.String() != "8.8.8.8" {
		t.Fatalf("port unreachable: %v %d %d %v", ok, typ, code, off)
	}
	if _, _, _, ok := parseRecvErr(recvErrMsg(1 /* local */, 11, 0, [4]byte{1, 2, 3, 4})); ok {
		t.Error("a non-ICMP origin must be ignored")
	}
	if _, _, _, ok := parseRecvErr([]byte{1, 2, 3}); ok {
		t.Error("a short buffer must be ignored")
	}
}

func TestProbePortRoundTrips(t *testing.T) {
	for ttl := 1; ttl <= 30; ttl++ {
		for idx := 0; idx < 3; idx++ {
			if probeIndex(ttl, probePort(ttl, idx, 3), 3) != idx {
				t.Fatalf("ttl %d idx %d", ttl, idx)
			}
		}
	}
}
