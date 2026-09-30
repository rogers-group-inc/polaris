//go:build windows

package collectors

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// iphlpapi's ICMP API — what ping.exe and tracert.exe call. It needs no
// privilege (and the service runs as LocalSystem anyway) and goes through the
// OS's own ICMP stack, so Windows Firewall treats it like ping. x/sys/windows
// has no binding for these, hence the LazyDLL pattern smbios_windows.go uses.
var (
	modiphlpapi         = windows.NewLazySystemDLL("iphlpapi.dll")
	procIcmpCreateFile  = modiphlpapi.NewProc("IcmpCreateFile")
	procIcmpCloseHandle = modiphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho2   = modiphlpapi.NewProc("IcmpSendEcho2")
)

// ipOptionInformation is IP_OPTION_INFORMATION (64-bit layout; amd64 and
// arm64 are both LLP64, so the pointer lands at offset 8).
type ipOptionInformation struct {
	Ttl         uint8
	Tos         uint8
	Flags       uint8
	OptionsSize uint8
	OptionsData uintptr
}

// ICMP_ECHO_REPLY (64-bit) is 40 bytes: Address@0 Status@4 RoundTripTime@8
// DataSize@12 Reserved@14 Data@16 Options@24. We never build 386, whose
// ICMP_ECHO_REPLY32 layout differs.
const icmpEchoReplySize = 40

// Status values from ipexport.h that the probes distinguish.
const (
	ipSuccess             = 0
	ipDestNetUnreachable  = 11002
	ipDestHostUnreachable = 11003
	ipDestPortUnreachable = 11005
	ipReqTimedOut         = 11010
	ipTTLExpiredTransit   = 11013
)

// parseIcmpEchoReply reads the fields a probe needs out of the first reply in
// a reply buffer. Pure — unit-tested with a hand-built buffer.
func parseIcmpEchoReply(buf []byte) (addr net.IP, status uint32, rttMs uint32, ttl uint8, ok bool) {
	if len(buf) < icmpEchoReplySize {
		return nil, 0, 0, 0, false
	}
	a := make(net.IP, 4)
	copy(a, buf[0:4]) // IPAddr is network byte order in memory
	return a, binary.LittleEndian.Uint32(buf[4:8]), binary.LittleEndian.Uint32(buf[8:12]), buf[24], true
}

type icmpHandle struct{ h windows.Handle }

func openICMP() (*icmpHandle, error) {
	if err := procIcmpCreateFile.Find(); err != nil {
		return nil, fmt.Errorf("IcmpCreateFile unavailable: %w", err)
	}
	h, _, err := procIcmpCreateFile.Call()
	if windows.Handle(h) == windows.InvalidHandle || h == 0 {
		return nil, fmt.Errorf("IcmpCreateFile: %w", err)
	}
	return &icmpHandle{h: windows.Handle(h)}, nil
}

func (h *icmpHandle) Close() {
	if h != nil && h.h != 0 {
		_, _, _ = procIcmpCloseHandle.Call(uintptr(h.h))
		h.h = 0
	}
}

// echo sends ONE echo with the given TTL and waits (synchronously, bounded by
// timeout) for its reply. RTT is measured on our own clock — the API's
// RoundTripTime is whole milliseconds and reads 0 under 1 ms (rule 71: don't
// report a measurement the mechanism cannot make).
func (h *icmpHandle) echo(dst net.IP, ttl uint8, payload []byte, timeout time.Duration) (net.IP, uint32, time.Duration, error) {
	v4 := dst.To4()
	if v4 == nil {
		return nil, 0, 0, ErrIPv6Unsupported
	}
	addr := binary.LittleEndian.Uint32(v4) // memory layout == network order
	opts := ipOptionInformation{Ttl: ttl}
	reply := make([]byte, icmpEchoReplySize+len(payload)+8+16)
	ms := uint32(timeout / time.Millisecond)
	if ms == 0 {
		ms = 1
	}
	var data uintptr
	if len(payload) > 0 {
		data = uintptr(unsafe.Pointer(&payload[0]))
	}
	start := time.Now()
	n, _, callErr := procIcmpSendEcho2.Call(
		uintptr(h.h),
		0, 0, 0, // Event, ApcRoutine, ApcContext — synchronous
		uintptr(addr),
		data,
		uintptr(len(payload)),
		uintptr(unsafe.Pointer(&opts)),
		uintptr(unsafe.Pointer(&reply[0])),
		uintptr(len(reply)),
		uintptr(ms),
	)
	rtt := time.Since(start)
	from, status, _, _, ok := parseIcmpEchoReply(reply)
	if n == 0 {
		// A failed call may still have filled the reply (TTL expired is
		// reported this way on some builds); otherwise the errno is the status.
		if ok && status != ipSuccess && !from.Equal(net.IPv4zero) {
			return from, status, rtt, nil
		}
		var errno windows.Errno
		if errors.As(callErr, &errno) {
			return nil, uint32(errno), rtt, nil
		}
		return nil, 0, rtt, fmt.Errorf("IcmpSendEcho2: %w", callErr)
	}
	if !ok {
		return nil, 0, rtt, errors.New("IcmpSendEcho2 returned a short reply")
	}
	return from, status, rtt, nil
}
