//go:build windows

package collectors

import (
	"context"
	"log"
	"net"
	"sync"
)

// unhandledICMPLogged keys each status (or error text) already logged, so a
// trace that repeats one every probe logs it once per agent run.
var unhandledICMPLogged sync.Map

func logUnhandledICMPStatus(status uint32, ttl int, err error) {
	key := any(status)
	msg := "traceroute: IcmpSendEcho2 status %d at TTL %d is not handled; the probe is recorded as silent"
	args := []any{status, ttl}
	if err != nil {
		key = err.Error()
		msg = "traceroute: IcmpSendEcho2 failed at TTL %d (%v); the probe is recorded as silent"
		args = []any{ttl, err}
	}
	if _, seen := unhandledICMPLogged.LoadOrStore(key, true); !seen {
		log.Printf(msg, args...)
	}
}

// platformTraceroute on Windows: IcmpSendEcho2 with a per-request TTL — what
// tracert.exe does. Up to o.inflightTTLs TTLs run concurrently, each on its
// own handle (a handle is not shared across concurrent synchronous calls);
// probes within one TTL are sequential. tracerouteOptsFrom sets one TTL at a
// time, so a whole trace is strictly one probe after another, like tracert.
func platformTraceroute(ctx context.Context, dst net.IP, o tracerouteOpts) ([]probeResult, error) {
	dst4 := dst.To4()
	if dst4 == nil {
		return nil, ErrIPv6Unsupported
	}
	var results []probeResult
	silent := 0
	payload := []byte("polaris-path-check-trace")
	for first := 1; first <= o.maxHops; first += o.inflightTTLs {
		if ctx.Err() != nil {
			return results, nil
		}
		last := first + o.inflightTTLs - 1
		if last > o.maxHops {
			last = o.maxHops
		}
		var mu sync.Mutex
		var wg sync.WaitGroup
		var batch []probeResult
		var openErr error
		for ttl := first; ttl <= last; ttl++ {
			wg.Add(1)
			go func(ttl int) {
				defer wg.Done()
				h, err := openICMP()
				if err != nil {
					mu.Lock()
					openErr = err
					mu.Unlock()
					return
				}
				defer h.Close()
				// Sequential within a TTL, never a burst: three probes to one
				// hop at once lost two of three on a live MPLS path.
				for idx := 0; idx < o.probesPerHop; idx++ {
					if ctx.Err() != nil {
						return
					}
					from, status, rtt, err := h.echo(dst4, uint8(ttl), payload, o.probeTimeout)
					r := probeResult{ttl: ttl, idx: idx}
					if err == nil {
						switch status {
						case ipSuccess:
							r.from, r.rtt, r.reached = from, rtt, true
						case ipTTLExpiredTransit:
							r.from, r.rtt = from, rtt
						case ipReqTimedOut:
							// silent probe
						case ipDestHostUnreachable, ipDestNetUnreachable, ipDestPortUnreachable:
							if from != nil && !from.Equal(net.IPv4zero) {
								r.from, r.rtt, r.stop = from, rtt, true
							}
						default:
							// Still a silent probe, but say why once, so a
							// status this switch does not know is never
							// mistaken for a router that did not answer.
							logUnhandledICMPStatus(status, ttl, nil)
						}
					} else {
						logUnhandledICMPStatus(0, ttl, err)
					}
					mu.Lock()
					batch = append(batch, r)
					mu.Unlock()
				}
			}(ttl)
		}
		wg.Wait()
		results = append(results, batch...)
		if openErr != nil && len(batch) == 0 {
			return results, openErr
		}
		end := false
		for ttl := first; ttl <= last && !end; ttl++ {
			answered := false
			for _, r := range batch {
				if r.ttl != ttl || r.from == nil {
					continue
				}
				answered = true
				if r.reached || r.stop {
					end = true
				}
			}
			if answered {
				silent = 0
			} else {
				silent++
				if silent >= o.silentHopLimit {
					end = true
				}
			}
		}
		if end {
			break
		}
	}
	return results, nil
}
