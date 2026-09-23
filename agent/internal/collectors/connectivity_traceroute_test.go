package collectors

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/polaris/agent/internal/transport"
)

func opts() tracerouteOpts {
	return tracerouteOpts{maxHops: 30, probesPerHop: 3, probeTimeout: time.Second, inflightTTLs: 8, silentHopLimit: 8}
}

func ip(s string) net.IP { return net.ParseIP(s).To4() }

func TestAssembleHopsFullPath(t *testing.T) {
	dst := ip("8.8.8.8")
	rs := []probeResult{
		{ttl: 1, idx: 0, from: ip("10.0.0.1"), rtt: time.Millisecond},
		{ttl: 1, idx: 1, from: ip("10.0.0.1"), rtt: 2 * time.Millisecond},
		{ttl: 1, idx: 2},
		{ttl: 2, idx: 0}, {ttl: 2, idx: 1}, {ttl: 2, idx: 2},
		{ttl: 3, idx: 0, from: dst, rtt: 9 * time.Millisecond, reached: true},
		// A probe beyond the destination must be trimmed.
		{ttl: 4, idx: 0, from: dst, rtt: 9 * time.Millisecond, reached: true},
	}
	hops, complete := assembleHops(rs, dst, opts())
	if !complete || len(hops) != 3 {
		t.Fatalf("complete=%v hops=%d", complete, len(hops))
	}
	if hops[0].IP != "10.0.0.1" || hops[0].RttMs[0] != 1 || hops[0].RttMs[2] != -1 {
		t.Errorf("hop1 %+v", hops[0])
	}
	if hops[1].IP != "" || hops[1].RttMs[0] != -1 {
		t.Errorf("hop2 should be silent: %+v", hops[1])
	}
	if hops[2].IP != "8.8.8.8" {
		t.Errorf("hop3 %+v", hops[2])
	}
}

func TestAssembleHopsStopsOnSilenceAndTrimsTrailingStars(t *testing.T) {
	dst := ip("8.8.8.8")
	var rs []probeResult
	rs = append(rs, probeResult{ttl: 1, idx: 0, from: ip("10.0.0.1"), rtt: time.Millisecond})
	for ttl := 2; ttl <= 20; ttl++ {
		rs = append(rs, probeResult{ttl: ttl, idx: 0})
	}
	hops, complete := assembleHops(rs, dst, opts())
	if complete || len(hops) != 1 || hops[0].IP != "10.0.0.1" {
		t.Fatalf("complete=%v hops=%+v", complete, hops)
	}
}

func TestAssembleHopsStopsAtAHardError(t *testing.T) {
	dst := ip("8.8.8.8")
	rs := []probeResult{
		{ttl: 1, idx: 0, from: ip("10.0.0.1"), rtt: time.Millisecond},
		{ttl: 2, idx: 0, from: ip("10.0.0.2"), rtt: time.Millisecond, stop: true},
		{ttl: 3, idx: 0, from: ip("10.0.0.3"), rtt: time.Millisecond},
	}
	hops, complete := assembleHops(rs, dst, opts())
	if complete || len(hops) != 2 {
		t.Fatalf("complete=%v hops=%d", complete, len(hops))
	}
}

func TestEnrichRdnsTrimsTheDotAndDedupes(t *testing.T) {
	orig := lookupAddr
	defer func() { lookupAddr = orig }()
	calls := 0
	lookupAddr = func(_ context.Context, addr string) ([]string, error) {
		calls++
		return []string{"gw-" + addr + ".example."}, nil
	}
	hops := []transport.ConnectivityHop{{TTL: 1, IP: "10.0.0.1"}, {TTL: 2, IP: ""}, {TTL: 3, IP: "10.0.0.1"}}
	enrichRdns(context.Background(), hops)
	if hops[0].Rdns != "gw-10.0.0.1.example" || hops[2].Rdns != hops[0].Rdns || hops[1].Rdns != "" {
		t.Fatalf("%+v", hops)
	}
	if calls != 1 {
		t.Errorf("lookups %d, want 1", calls)
	}
}

func TestEchoPacketChecksumAndParse(t *testing.T) {
	pkt := buildEchoRequest(0x1234, 0x0001, []byte("abcd"))
	if icmpChecksum(pkt) != 0 {
		t.Fatal("a checksummed packet must sum to zero")
	}
	// Turn it into a reply and parse it bare and behind an IPv4 header.
	pkt[0] = icmpTypeEchoReply
	typ, _, id, seq, payload, ok := parseEchoReply(pkt)
	if !ok || typ != 0 || id != 0x1234 || seq != 1 || string(payload) != "abcd" {
		t.Fatalf("bare: %v %d %x %d %q", ok, typ, id, seq, payload)
	}
	withHdr := append(append([]byte{0x45}, make([]byte, 19)...), pkt...)
	typ, _, _, seq, payload, ok = parseEchoReply(withHdr)
	if !ok || typ != 0 || seq != 1 || string(payload) != "abcd" {
		t.Fatalf("with header: %v %d %d %q", ok, typ, seq, payload)
	}
}
