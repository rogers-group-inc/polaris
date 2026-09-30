//go:build linux

package collectors

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"

	"golang.org/x/sys/unix"
)

// The tracepath technique, which needs no privilege: an ordinary UDP socket
// with IP_TTL set per probe and IP_RECVERR enabled, so the kernel queues the
// ICMP Time Exceeded / Port Unreachable a router or the destination sends
// back on the socket's ERROR QUEUE, readable with MSG_ERRQUEUE. No raw socket,
// no CAP_NET_RAW, no shelling out to traceroute (whose file capabilities
// NoNewPrivileges would ignore anyway).

const tracerouteBasePort = 33434

// soEEOriginICMP is SO_EE_ORIGIN_ICMP from <linux/errqueue.h>.
const soEEOriginICMP = 2

// parseRecvErr decodes one IP_RECVERR control message: a 16-byte
// sock_extended_err (native-endian) followed by the offender's sockaddr_in.
// x/sys has the struct but no SO_EE_OFFENDER helper (a C macro), hence the
// hand-parse. Pure — unit-tested with a hand-built buffer.
func parseRecvErr(data []byte) (typ, code uint8, offender net.IP, ok bool) {
	if len(data) < 16 {
		return 0, 0, nil, false
	}
	origin := data[4]
	typ, code = data[5], data[6]
	if origin != soEEOriginICMP {
		return 0, 0, nil, false
	}
	if len(data) >= 16+8 && binary.NativeEndian.Uint16(data[16:18]) == unix.AF_INET {
		offender = net.IPv4(data[20], data[21], data[22], data[23]).To4()
	}
	return typ, code, offender, true
}

type pendingProbe struct {
	ttl, idx int
	sent     time.Time
	done     bool
}

// platformTraceroute probes up to o.inflightTTLs TTLs at a time, each on its
// own socket, o.probesPerHop datagrams per TTL to distinct ports so a reply's
// original destination port identifies the probe. A batch ends when every
// probe is answered or the probe timeout passes; the trace ends at the
// destination, a hard ICMP error, the silent-hop limit or maxHops.
func platformTraceroute(ctx context.Context, dst net.IP, o tracerouteOpts) ([]probeResult, error) {
	dst4 := dst.To4()
	if dst4 == nil {
		return nil, ErrIPv6Unsupported
	}
	var results []probeResult
	silent := 0
	for first := 1; first <= o.maxHops; first += o.inflightTTLs {
		if ctx.Err() != nil {
			return results, nil
		}
		lastTTL := first + o.inflightTTLs - 1
		if lastTTL > o.maxHops {
			lastTTL = o.maxHops
		}
		batch, err := traceBatch(ctx, dst4, first, lastTTL, o)
		results = append(results, batch...)
		if err != nil {
			return results, err
		}
		// Stop once the destination answered or a hop refused the path.
		end := false
		for ttl := first; ttl <= lastTTL && !end; ttl++ {
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
			return results, nil
		}
	}
	return results, nil
}

func traceBatch(ctx context.Context, dst4 net.IP, firstTTL, lastTTL int, o tracerouteOpts) ([]probeResult, error) {
	type sock struct {
		fd  int
		ttl int
	}
	var socks []sock
	defer func() {
		for _, s := range socks {
			unix.Close(s.fd)
		}
	}()
	pending := map[[2]int]*pendingProbe{} // (ttl, idx)
	payload := []byte("polaris-path-check-trace")
	for ttl := firstTTL; ttl <= lastTTL; ttl++ {
		fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_NONBLOCK|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			return nil, fmt.Errorf("traceroute socket: %w", err)
		}
		socks = append(socks, sock{fd: fd, ttl: ttl})
		if err := unix.SetsockoptInt(fd, unix.SOL_IP, unix.IP_TTL, ttl); err != nil {
			return nil, fmt.Errorf("IP_TTL: %w", err)
		}
		if err := unix.SetsockoptInt(fd, unix.SOL_IP, unix.IP_RECVERR, 1); err != nil {
			return nil, fmt.Errorf("IP_RECVERR: %w", err)
		}
		for idx := 0; idx < o.probesPerHop; idx++ {
			sa := &unix.SockaddrInet4{Port: probePort(ttl, idx, o.probesPerHop)}
			copy(sa.Addr[:], dst4)
			p := &pendingProbe{ttl: ttl, idx: idx, sent: time.Now()}
			if err := unix.Sendto(fd, payload, 0, sa); err != nil {
				// A send error (EHOSTUNREACH etc.) is itself an answer: nothing
				// will come back for this probe. Leave it unanswered.
				p.done = true
			}
			pending[[2]int{ttl, idx}] = p
		}
	}

	var results []probeResult
	deadline := time.Now().Add(o.probeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	buf := make([]byte, 512)
	oob := make([]byte, 512)
	for {
		open := 0
		for _, p := range pending {
			if !p.done {
				open++
			}
		}
		if open == 0 {
			break
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		fds := make([]unix.PollFd, len(socks))
		for i, s := range socks {
			fds[i] = unix.PollFd{Fd: int32(s.fd), Events: unix.POLLIN | unix.POLLERR}
		}
		n, err := unix.Poll(fds, int(remaining.Milliseconds())+1)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return results, fmt.Errorf("poll: %w", err)
		}
		if n == 0 {
			break
		}
		for i, f := range fds {
			if f.Revents == 0 {
				continue
			}
			s := socks[i]
			// Drain the error queue: time-exceeded from a router, or
			// port-unreachable from the destination itself.
			for {
				_, oobn, _, from, rerr := unix.Recvmsg(s.fd, buf, oob, unix.MSG_ERRQUEUE)
				if rerr != nil {
					break
				}
				orig, _ := from.(*unix.SockaddrInet4)
				msgs, perr := unix.ParseSocketControlMessage(oob[:oobn])
				if perr != nil || orig == nil {
					continue
				}
				idx := probeIndex(s.ttl, orig.Port, o.probesPerHop)
				p := pending[[2]int{s.ttl, idx}]
				if p == nil || p.done {
					continue
				}
				for _, m := range msgs {
					if m.Header.Level != unix.SOL_IP || m.Header.Type != unix.IP_RECVERR {
						continue
					}
					typ, code, offender, ok := parseRecvErr(m.Data)
					if !ok || offender == nil {
						continue
					}
					p.done = true
					r := probeResult{ttl: s.ttl, idx: idx, from: offender, rtt: time.Since(p.sent)}
					switch {
					case typ == icmpTypeTimeExceed:
					case typ == icmpTypeDestUnreach && code == 3: // port unreachable
						r.reached = true
					case typ == icmpTypeDestUnreach:
						r.stop = true
					}
					if offender.Equal(dst4) {
						r.reached = true
					}
					results = append(results, r)
				}
			}
			// POLLIN: the destination answered the UDP probe itself (a
			// service listening on a 33434+ port). Reached, whatever idx.
			if f.Revents&unix.POLLIN != 0 {
				if _, _, rerr := unix.Recvfrom(s.fd, buf, 0); rerr == nil {
					for _, p := range pending {
						if p.ttl == s.ttl && !p.done {
							p.done = true
							results = append(results, probeResult{ttl: s.ttl, idx: p.idx, from: dst4, rtt: time.Since(p.sent), reached: true})
							break
						}
					}
				}
			}
		}
	}
	for _, p := range pending {
		if !p.done {
			results = append(results, probeResult{ttl: p.ttl, idx: p.idx})
		}
	}
	return results, nil
}

// probePort / probeIndex: distinct destination port per (ttl, probe) so the
// original destination of a returned error names the probe. (Varying the port
// can change an ECMP flow hash, so probes of one TTL may see different
// routers — the classic traceroute artefact.)
func probePort(ttl, idx, probes int) int {
	return tracerouteBasePort + (ttl-1)*probes + idx
}

func probeIndex(ttl, port, probes int) int {
	return port - tracerouteBasePort - (ttl-1)*probes
}
