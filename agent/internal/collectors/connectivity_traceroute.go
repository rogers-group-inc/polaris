package collectors

import (
	"context"
	"errors"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// ErrTracerouteUnsupported is reported on a platform with no unprivileged
// traceroute path (macOS in v1).
var ErrTracerouteUnsupported = errors.New("traceroute unsupported on this platform")

// probeResult is one probe of one TTL, as the platform layer saw it.
type probeResult struct {
	ttl, idx int
	from     net.IP        // nil = no reply before the probe timeout
	rtt      time.Duration // valid only when from != nil
	reached  bool          // the destination itself answered (echo reply / port unreachable)
	// stop: an ICMP error other than time-exceeded / port-unreachable from
	// this hop (host or net unreachable, admin prohibited) — the path ends
	// here and the trace is incomplete.
	stop bool
}

type tracerouteOpts struct {
	maxHops        int
	probesPerHop   int
	probeTimeout   time.Duration
	inflightTTLs   int // TTLs probed concurrently (router ICMP rate limits)
	silentHopLimit int // consecutive TTLs with no reply before giving up
}

func tracerouteOptsFrom(def transport.ConnectivityTracerouteDef) tracerouteOpts {
	def = normalizeTracerouteDef(def)
	return tracerouteOpts{
		maxHops:        def.MaxHops,
		probesPerHop:   def.ProbesPerHop,
		probeTimeout:   time.Duration(def.ProbeTimeoutMs) * time.Millisecond,
		inflightTTLs:   8,
		silentHopLimit: 8,
	}
}

// assembleHops turns probe results into the wire's hop list: one entry per
// TTL up to (and including) the first TTL the destination answered or the
// path stopped at, the hop's IP being the first responder at that TTL, and
// rttMs one value per probe in probe order (-1 = timeout). complete = the
// destination was reached. Pure — tested on every platform.
func assembleHops(results []probeResult, dst net.IP, o tracerouteOpts) ([]transport.ConnectivityHop, bool) {
	byTTL := map[int][]probeResult{}
	last := 0
	for _, r := range results {
		byTTL[r.ttl] = append(byTTL[r.ttl], r)
		if r.ttl > last {
			last = r.ttl
		}
	}
	var hops []transport.ConnectivityHop
	complete := false
	silent := 0
	for ttl := 1; ttl <= last && ttl <= o.maxHops; ttl++ {
		rs := byTTL[ttl]
		sort.Slice(rs, func(i, j int) bool { return rs[i].idx < rs[j].idx })
		rtts := make([]float64, o.probesPerHop)
		for i := range rtts {
			rtts[i] = -1
		}
		ip := ""
		reached, stop := false, false
		for _, r := range rs {
			if r.from == nil {
				continue
			}
			if ip == "" {
				ip = r.from.String()
			}
			if r.idx >= 0 && r.idx < len(rtts) {
				rtts[r.idx] = float64(r.rtt.Microseconds()) / 1000
			}
			if r.reached || (dst != nil && r.from.Equal(dst)) {
				reached = true
			}
			if r.stop {
				stop = true
			}
		}
		hops = append(hops, transport.ConnectivityHop{TTL: ttl, IP: ip, RttMs: rtts})
		if reached {
			complete = true
			break
		}
		if stop {
			break
		}
		if ip == "" {
			silent++
			if o.silentHopLimit > 0 && silent >= o.silentHopLimit {
				break
			}
		} else {
			silent = 0
		}
	}
	// Trailing silent TTLs past the last responder say nothing and cost
	// nothing to drop — keep the path readable. (The server's path hash drops
	// them too, so this changes no comparison.)
	for len(hops) > 0 && hops[len(hops)-1].IP == "" && !complete {
		hops = hops[:len(hops)-1]
	}
	return hops, complete
}

// lookupAddr is swapped by tests.
var lookupAddr = net.DefaultResolver.LookupAddr

// enrichRdns fills Rdns for each distinct hop IP: 1 s per lookup, at most 8 at
// once, 3 s overall. A failed lookup leaves it blank.
func enrichRdns(ctx context.Context, hops []transport.ConnectivityHop) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	names := map[string]string{}
	var mu sync.Mutex
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, h := range hops {
		if h.IP == "" {
			continue
		}
		mu.Lock()
		_, seen := names[h.IP]
		names[h.IP] = ""
		mu.Unlock()
		if seen {
			continue
		}
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			lctx, lcancel := context.WithTimeout(ctx, time.Second)
			defer lcancel()
			if res, err := lookupAddr(lctx, ip); err == nil && len(res) > 0 {
				mu.Lock()
				names[ip] = strings.TrimSuffix(res[0], ".")
				mu.Unlock()
			}
		}(h.IP)
	}
	wg.Wait()
	for i := range hops {
		hops[i].Rdns = names[hops[i].IP]
	}
}

// Traceroute runs one unprivileged traceroute to dst. It always returns a row;
// an unsupported platform or a socket failure is recorded in Note with
// whatever hops were gathered.
func Traceroute(ctx context.Context, checkID string, dst net.IP, def transport.ConnectivityTracerouteDef, now func() time.Time) *transport.ConnectivityTraceroute {
	o := tracerouteOptsFrom(def)
	tr := &transport.ConnectivityTraceroute{
		CheckID:       checkID,
		Timestamp:     now().UTC().Format(time.RFC3339Nano),
		DestinationIP: dst.String(),
		Reason:        "scheduled",
		Hops:          []transport.ConnectivityHop{},
	}
	results, err := platformTraceroute(ctx, dst, o)
	if err != nil {
		tr.Note = truncateNote(err.Error())
	}
	hops, complete := assembleHops(results, dst, o)
	if hops != nil {
		tr.Hops = hops
	}
	tr.Complete = complete
	if !complete && tr.Note == "" && len(hops) > 0 && hops[len(hops)-1].IP != "" && !net.ParseIP(hops[len(hops)-1].IP).Equal(dst) {
		tr.Note = "path ended before the destination (unreachable or filtered)"
	}
	enrichRdns(ctx, tr.Hops)
	return tr
}

func truncateNote(s string) string {
	if len(s) > 256 {
		return s[:256]
	}
	return s
}
