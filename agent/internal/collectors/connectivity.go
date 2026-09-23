// Agent-run connectivity checks — the probe half.
//
// The server ships each agent the checks it is a source of (GET /agents/config
// → connectivityChecks); the scheduler in cmd/polaris-agent/connectivity.go
// decides which are due and calls RunOnce. Satellite posture: a definition is
// validated STRICTLY before anything touches the network (ValidateCheckDef),
// and the agent only ever runs the fixed probe the kind names — never operator
// code. Every network operation is bound by the context the caller passes, so
// nothing here can outlive its deadline.
//
// The HTTP client used here is NOT the pinned Polaris transport: that one
// trusts exactly one leaf certificate and would refuse every real target. A
// fresh client per run, with normal chain validation (unless the check says
// verifyTls=false), no proxy, no redirects and no authentication.
//
// A result describes the PATH from this host to the target. It is never about
// this host's own health — the server keeps it off monitorStatus entirely
// (business rule 85).
package collectors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polaris/agent/internal/transport"
)

// TraceMode is decided by the scheduler (it needs the check's last verdict).
type TraceMode int

const (
	// TraceNever runs no traceroute this run.
	TraceNever TraceMode = iota
	// TraceAlways runs one (the every-Nth-run schedule, and the baseline run).
	TraceAlways
	// TraceOnFail runs one only if THIS run fails — the pass→fail transition.
	TraceOnFail
)

// ConnectivityOpts carries what RunOnce needs from outside the definition.
type ConnectivityOpts struct {
	UserAgent string
	Trace     TraceMode
	Now       func() time.Time // nil → time.Now
}

const (
	connectivityMaxBodyBytes    = 64 * 1024
	connectivityMaxExcerptBytes = 4 * 1024
	connectivityMaxErrorLen     = 512
	// TracerouteBudget bounds one traceroute. The windowed implementation
	// normally finishes in a few seconds; this is the ceiling.
	TracerouteBudget = 30 * time.Second
)

// ErrIPv6Unsupported is reported for an IPv6 literal or an IPv6-only name.
var ErrIPv6Unsupported = errors.New("ipv6 not supported in v1")

// ─── Definition validation ────────────────────────────────────────────────

func normalizeTracerouteDef(t transport.ConnectivityTracerouteDef) transport.ConnectivityTracerouteDef {
	if t.EveryNRuns <= 0 {
		t.EveryNRuns = 5
	}
	if t.MaxHops <= 0 {
		t.MaxHops = 30
	}
	if t.ProbesPerHop <= 0 {
		t.ProbesPerHop = 3
	}
	if t.ProbeTimeoutMs <= 0 {
		t.ProbeTimeoutMs = 1000
	}
	return t
}

// ValidateCheckDef enforces the definition schema. Anything outside it is
// refused — the run then reports "refused: …" instead of probing.
func ValidateCheckDef(def *transport.ConnectivityCheckDef) error {
	if def == nil {
		return errors.New("no definition")
	}
	if l := len(def.ID); l == 0 || l > 64 {
		return errors.New("id must be 1..64 characters")
	}
	switch def.Kind {
	case "http", "https", "tcp", "icmp":
	default:
		return fmt.Errorf("unknown kind %q", def.Kind)
	}
	if l := len(def.Target); l == 0 || l > 512 {
		return errors.New("target must be 1..512 characters")
	}
	if def.IntervalSec < 60 || def.IntervalSec > 3600 || def.IntervalSec%60 != 0 {
		return fmt.Errorf("intervalSec %d is not a whole number of minutes in 1..60", def.IntervalSec)
	}
	if def.TimeoutMs < 500 || def.TimeoutMs > 30000 {
		return fmt.Errorf("timeoutMs %d outside 500..30000", def.TimeoutMs)
	}
	if def.Kind == "http" || def.Kind == "https" {
		if _, err := parseStatusSpec(def.ExpectStatus); err != nil {
			return fmt.Errorf("expectStatus: %w", err)
		}
		if b := def.ExpectBody; b != nil {
			switch b.Mode {
			case "contains", "regex", "exact":
			default:
				return fmt.Errorf("unknown body match mode %q", b.Mode)
			}
			if b.Value == "" || len(b.Value) > 1024 {
				return errors.New("body match value must be 1..1024 characters")
			}
		}
	}
	t := def.Traceroute
	if t.EveryNRuns < 0 || t.EveryNRuns > 100 || t.MaxHops < 0 || t.MaxHops > 64 ||
		t.ProbesPerHop < 0 || t.ProbesPerHop > 5 || t.ProbeTimeoutMs < 0 || t.ProbeTimeoutMs > 5000 {
		return errors.New("traceroute settings out of range")
	}
	return nil
}

// DefHash is the scheduler's reset key: sha256 of the definition's JSON.
// A changed definition re-baselines the check (immediate run + traceroute).
func DefHash(def *transport.ConnectivityCheckDef) string {
	b, _ := json.Marshal(def)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ─── Target handling ──────────────────────────────────────────────────────

// refuseAddr rejects addresses that are only ever an SSRF target: loopback,
// link-local (including 169.254.169.254 cloud metadata), unspecified and
// multicast. Checked AFTER resolution, so "localhost" and a name pointed at
// 127.0.0.1 are both caught. RFC1918 is allowed — internal services are the
// point.
func refuseAddr(ip net.IP) error {
	switch {
	case ip.IsLoopback():
		return fmt.Errorf("refused: %s is a loopback address", ip)
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return fmt.Errorf("refused: %s is a link-local address", ip)
	case ip.IsUnspecified():
		return fmt.Errorf("refused: %s is the unspecified address", ip)
	case ip.IsMulticast():
		return fmt.Errorf("refused: %s is a multicast address", ip)
	}
	return nil
}

// splitTargetHostPort parses "host[:port]" for tcp (port required) and icmp
// (port forbidden).
func splitTargetHostPort(kind, target string) (string, int, error) {
	t := strings.TrimSpace(target)
	if kind == "icmp" {
		if strings.Contains(t, ":") && net.ParseIP(t) == nil {
			return "", 0, errors.New("an icmp target takes a host, not host:port")
		}
		return t, 0, nil
	}
	host, portStr, err := net.SplitHostPort(t)
	if err != nil {
		return "", 0, fmt.Errorf("a tcp target must be host:port: %w", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("port %q is not 1..65535", portStr)
	}
	return host, port, nil
}

// lookupHost is swapped by tests.
var lookupHost = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.IP)
	}
	return out, nil
}

// resolveTarget does ONE lookup (timed), prefers IPv4, and refuses the SSRF
// ranges. An IP literal skips the lookup (dnsMs stays nil).
func resolveTarget(ctx context.Context, host string) (net.IP, *float64, error) {
	if ip := net.ParseIP(host); ip != nil {
		if ip.To4() == nil {
			return nil, nil, ErrIPv6Unsupported
		}
		if err := refuseAddr(ip); err != nil {
			return nil, nil, err
		}
		return ip.To4(), nil, nil
	}
	start := time.Now()
	ips, err := lookupHost(ctx, host)
	dns := msSince(start)
	if err != nil {
		return nil, &dns, fmt.Errorf("dns lookup failed: %w", err)
	}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			if err := refuseAddr(v4); err != nil {
				return nil, &dns, err
			}
			return v4, &dns, nil
		}
	}
	return nil, &dns, ErrIPv6Unsupported
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

func fptr(v float64) *float64 { return &v }
func iptr(v int) *int         { return &v }
func bptr(v bool) *bool       { return &v }

// truncateError keeps an error message within the wire limit, on a UTF-8
// boundary.
func truncateError(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) <= connectivityMaxErrorLen {
		return s
	}
	s = s[:connectivityMaxErrorLen]
	for !utf8.ValidString(s) && len(s) > 0 {
		s = s[:len(s)-1]
	}
	return s
}

// ─── Run ──────────────────────────────────────────────────────────────────

// RunOnce runs one check and, per opts.Trace, one traceroute. It always
// returns a sample (a refused definition is a failed sample saying why); the
// traceroute is nil when none ran. ctx carries the run's deadline.
func RunOnce(ctx context.Context, def *transport.ConnectivityCheckDef, opts ConnectivityOpts) (*transport.ConnectivitySample, *transport.ConnectivityTraceroute) {
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	started := now()
	s := &transport.ConnectivitySample{CheckID: def.ID, Timestamp: started.UTC().Format(time.RFC3339Nano)}
	if err := ValidateCheckDef(def); err != nil {
		s.Error = truncateError(fmt.Errorf("refused: %w", err))
		return s, nil
	}
	timeout := time.Duration(def.TimeoutMs) * time.Millisecond
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var dst net.IP
	switch def.Kind {
	case "http", "https":
		u, host, err := parseCheckURL(def.Kind, def.Target)
		if err != nil {
			s.Error = truncateError(err)
			break
		}
		ip, dns, err := resolveTarget(runCtx, host)
		s.DNSMs = dns
		if err != nil {
			s.Error = truncateError(err)
			break
		}
		dst = ip
		s.ResolvedIP = ip.String()
		runHTTP(runCtx, def, u, ip, opts.UserAgent, s)
	case "tcp", "icmp":
		host, port, err := splitTargetHostPort(def.Kind, def.Target)
		if err != nil {
			s.Error = truncateError(err)
			break
		}
		ip, dns, err := resolveTarget(runCtx, host)
		s.DNSMs = dns
		if err != nil {
			s.Error = truncateError(err)
			break
		}
		dst = ip
		s.ResolvedIP = ip.String()
		if def.Kind == "tcp" {
			runTCP(runCtx, ip, port, s)
		} else {
			runICMP(runCtx, ip, timeout, s)
		}
	}
	// latencyMs for http covers DNS → body read; tcp/icmp set their own.
	if s.LatencyMs == nil && s.OK {
		s.LatencyMs = fptr(msSince(started))
	}

	want := opts.Trace == TraceAlways || (opts.Trace == TraceOnFail && !s.OK)
	tr := normalizeTracerouteDef(def.Traceroute)
	if !want || !tr.Enabled || dst == nil {
		return s, nil
	}
	reason := "scheduled"
	if opts.Trace == TraceOnFail {
		reason = "transition"
	}
	trCtx, trCancel := context.WithTimeout(ctx, TracerouteBudget)
	defer trCancel()
	trace := Traceroute(trCtx, def.ID, dst, tr, now)
	trace.Reason = reason
	s.TracerouteRan = true
	return s, trace
}

// runTCP measures one TCP connect. Latency = the connect time.
func runTCP(ctx context.Context, ip net.IP, port int, s *transport.ConnectivitySample) {
	var d net.Dialer
	start := time.Now()
	conn, err := d.DialContext(ctx, "tcp4", net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	if err != nil {
		s.Error = truncateError(fmt.Errorf("connect failed: %w", err))
		return
	}
	ms := msSince(start)
	_ = conn.Close()
	s.ConnectMs = fptr(ms)
	s.LatencyMs = fptr(ms)
	s.OK = true
}

// parseCheckURL validates an http/https target and returns its host.
func parseCheckURL(kind, target string) (*url.URL, string, error) {
	t := strings.TrimSpace(target)
	if !strings.Contains(t, "://") {
		t = kind + "://" + t
	}
	u, err := url.Parse(t)
	if err != nil {
		return nil, "", fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != kind {
		return nil, "", fmt.Errorf("a %s check needs a %s:// URL", kind, kind)
	}
	if u.User != nil {
		return nil, "", errors.New("refused: credentials in the target URL are not supported")
	}
	host := u.Hostname()
	if host == "" {
		return nil, "", errors.New("the URL has no host")
	}
	return u, host, nil
}
