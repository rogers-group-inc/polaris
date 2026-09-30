package collectors

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/polaris/agent/internal/transport"
)

// ─── Status spec ──────────────────────────────────────────────────────────
//
// MIRRORED from src/utils/httpCheck.ts parseStatusSpec (and the check modal's
// copy in public/js/path-checks.js). "200,204,300-399"; empty = any
// 2xx. Change all three together.

type statusRange struct{ lo, hi int }

var statusPartRe = regexp.MustCompile(`^(\d{3})(?:\s*-\s*(\d{3}))?$`)

func parseStatusSpec(spec string) ([]statusRange, error) {
	s := strings.TrimSpace(spec)
	if s == "" {
		return []statusRange{{200, 299}}, nil
	}
	var out []statusRange
	for _, raw := range strings.Split(s, ",") {
		part := strings.TrimSpace(raw)
		if part == "" {
			return nil, errors.New("empty entry in the status list")
		}
		m := statusPartRe.FindStringSubmatch(part)
		if m == nil {
			return nil, fmt.Errorf("%q is not a status code or range", part)
		}
		lo, _ := strconv.Atoi(m[1])
		hi := lo
		if m[2] != "" {
			hi, _ = strconv.Atoi(m[2])
		}
		if lo < 100 || hi > 599 {
			return nil, fmt.Errorf("%q is outside 100-599", part)
		}
		if lo > hi {
			return nil, fmt.Errorf("%q runs backwards", part)
		}
		out = append(out, statusRange{lo, hi})
	}
	if len(out) > 20 {
		return nil, errors.New("at most 20 codes or ranges")
	}
	return out, nil
}

func statusAccepted(code int, ranges []statusRange) bool {
	for _, r := range ranges {
		if code >= r.lo && code <= r.hi {
			return true
		}
	}
	return false
}

// ─── Body match ───────────────────────────────────────────────────────────

// bodyMatches mirrors src/utils/httpCheck.ts bodyMatches plus "exact" (equal
// after trimming trailing CR/LF, so a health endpoint's "OK\n" matches "OK").
// Regex is RE2 — the server refuses lookaround / backreferences at save.
func bodyMatches(body []byte, exp *transport.PathCheckBodyExpect) (bool, error) {
	if exp == nil || exp.Value == "" {
		return true, nil
	}
	text := string(body)
	switch exp.Mode {
	case "regex":
		pat := exp.Value
		if !exp.CaseSensitive {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return false, fmt.Errorf("invalid regex pattern: %w", err)
		}
		return re.MatchString(text), nil
	case "exact":
		got := strings.TrimRight(text, "\r\n")
		if exp.CaseSensitive {
			return got == exp.Value, nil
		}
		return strings.EqualFold(got, exp.Value), nil
	default: // contains
		if exp.CaseSensitive {
			return strings.Contains(text, exp.Value), nil
		}
		return strings.Contains(strings.ToLower(text), strings.ToLower(exp.Value)), nil
	}
}

// bodyExcerpt: the first 4 KB, cut on a rune boundary, as valid UTF-8.
func bodyExcerpt(body []byte) string {
	b := body
	if len(b) > pathCheckMaxExcerptBytes {
		b = b[:pathCheckMaxExcerptBytes]
		for len(b) > 0 && !utf8.Valid(b) {
			b = b[:len(b)-1]
		}
	}
	return strings.ToValidUTF8(string(b), "�")
}

// ─── Runner ───────────────────────────────────────────────────────────────

// leafFromHandshake returns the server's leaf certificate even when
// verification FAILED — an expired or untrusted certificate is exactly the
// case the operator needs tlsNotAfter / tlsIssuer for.
func leafFromHandshake(state tls.ConnectionState, err error) *x509.Certificate {
	if len(state.PeerCertificates) > 0 {
		return state.PeerCertificates[0]
	}
	var cve *tls.CertificateVerificationError
	if errors.As(err, &cve) && len(cve.UnverifiedCertificates) > 0 {
		return cve.UnverifiedCertificates[0]
	}
	return nil
}

func applyLeaf(leaf *x509.Certificate, s *transport.PathCheckSample) {
	if leaf == nil {
		return
	}
	s.TLSNotAfter = leaf.NotAfter.UTC().Format(time.RFC3339)
	if leaf.Issuer.CommonName != "" {
		s.TLSIssuer = leaf.Issuer.CommonName
	} else {
		s.TLSIssuer = leaf.Issuer.String()
	}
}

// sameOrigin: scheme + host + port, the default port made explicit.
func sameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return a.Scheme == b.Scheme && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

// httpOnce is one request of a run: its response (body read and closed) or
// an error. Timings and TLS facts land on s — the last hop's win.
type httpOnce struct {
	status int
	body   []byte
	rerr   error
	loc    string
}

func doHTTPOnce(ctx context.Context, def *transport.PathCheckDef, u *url.URL, ip net.IP, method, hostHeader, ua string, s *transport.PathCheckSample) (*httpOnce, error) {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	dialAddr := net.JoinHostPort(ip.String(), port)
	serverName := u.Hostname()
	if hostHeader != "" {
		// The Host override names the virtual host for the TLS handshake too.
		if h, _, err := net.SplitHostPort(hostHeader); err == nil {
			serverName = h
		} else {
			serverName = hostHeader
		}
	}
	var dialer net.Dialer
	tr := &http.Transport{
		// Measure the DIRECT path the host takes — an environment proxy would
		// turn every check into a check of the proxy.
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp4", dialAddr)
		},
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: !def.VerifyTLS, //nolint:gosec // operator-chosen per check; default on
			MinVersion:         tls.VersionTLS12,
			ServerName:         serverName,
		},
		DisableKeepAlives:     true,
		ForceAttemptHTTP2:     false,
		TLSHandshakeTimeout:   time.Duration(def.TimeoutMs) * time.Millisecond,
		ResponseHeaderTimeout: time.Duration(def.TimeoutMs) * time.Millisecond,
	}
	defer tr.CloseIdleConnections()
	// Redirects are followed by runHTTP itself, hop by hop, so every hop is
	// resolved and refused-checked like the first one.
	client := &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	var connStart, tlsStart, wrote time.Time
	var leaf *x509.Certificate
	trace := &httptrace.ClientTrace{
		ConnectStart: func(string, string) { connStart = time.Now() },
		ConnectDone: func(_, _ string, err error) {
			if err == nil && !connStart.IsZero() {
				s.ConnectMs = fptr(msSince(connStart))
			}
		},
		TLSHandshakeStart: func() { tlsStart = time.Now() },
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			if !tlsStart.IsZero() {
				s.TLSMs = fptr(msSince(tlsStart))
			}
			leaf = leafFromHandshake(state, err)
		},
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote = time.Now() },
		GotFirstResponseByte: func() {
			if !wrote.IsZero() {
				s.TTFBMs = fptr(msSince(wrote))
			}
		},
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), method, u.String(), nil)
	if err != nil {
		return nil, err
	}
	if hostHeader != "" {
		req.Host = hostHeader
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "*/*")

	resp, err := client.Do(req)
	applyLeaf(leaf, s)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out := &httpOnce{status: resp.StatusCode, loc: resp.Header.Get("Location")}
	if method != http.MethodHead {
		out.body, out.rerr = io.ReadAll(io.LimitReader(resp.Body, pathCheckMaxBodyBytes))
	}
	return out, nil
}

// runHTTP performs one check run against u: GET (or HEAD), dialing ip
// (already resolved and refused-checked) so resolvedIp is the address actually
// used and DNS is counted once. Redirects are followed only when the check
// says so — at most maxRedirects, each new host resolved and refused-checked
// again — and the Host override applies only on the target's own origin. The
// agent never authenticates: a check with a credential is server-only.
// Status is judged before body, on the LAST response.
func runHTTP(ctx context.Context, def *transport.PathCheckDef, u *url.URL, ip net.IP, ua string, s *transport.PathCheckSample) {
	start := time.Now()
	method := http.MethodGet
	if def.Method == http.MethodHead {
		method = http.MethodHead
	}
	u0 := u
	var res *httpOnce
	for hop := 0; ; hop++ {
		hostHeader := ""
		if sameOrigin(u, u0) {
			hostHeader = def.HostHeader
		}
		r, err := doHTTPOnce(ctx, def, u, ip, method, hostHeader, ua, s)
		if err != nil {
			s.Error = truncateError(err)
			return
		}
		res = r
		if !def.FollowRedirects || r.status < 300 || r.status > 399 || r.loc == "" {
			break
		}
		if hop >= maxRedirects {
			s.HTTPStatus = iptr(r.status)
			s.Error = fmt.Sprintf("more than %d redirects", maxRedirects)
			return
		}
		next, err := u.Parse(r.loc)
		if err != nil {
			s.Error = truncateError(fmt.Errorf("redirect to an invalid URL: %w", err))
			return
		}
		if next.Scheme != "http" && next.Scheme != "https" {
			s.Error = fmt.Sprintf("refused: redirect to %s: URL", next.Scheme)
			return
		}
		if next.User != nil {
			s.Error = "refused: redirect to a URL with credentials in it"
			return
		}
		nip, _, err := resolveTarget(ctx, next.Hostname())
		if err != nil {
			s.Error = truncateError(fmt.Errorf("redirect to %s: %w", next.Host, err))
			return
		}
		u, ip = next, nip
		s.ResolvedIP = nip.String()
	}

	body := res.body
	sum := sha256.Sum256(body)
	s.BodySha256 = hex.EncodeToString(sum[:])
	s.BodyBytes = iptr(len(body))
	s.HTTPStatus = iptr(res.status)
	s.LatencyMs = fptr(msSince(start))

	ranges, _ := parseStatusSpec(def.ExpectStatus) // validated by ValidateCheckDef
	switch {
	case !statusAccepted(res.status, ranges):
		spec := def.ExpectStatus
		if spec == "" {
			spec = "2xx"
		}
		s.Error = fmt.Sprintf("HTTP %d (expected %s)", res.status, spec)
	case res.rerr != nil:
		s.Error = truncateError(fmt.Errorf("reading the response body: %w", res.rerr))
	default:
		found, merr := bodyMatches(body, def.ExpectBody)
		// BodyMatched = "the body expectation HELD" — for a negated one, that
		// the text was absent. The server's runner reports it the same way.
		held := found
		if def.ExpectBody != nil && def.ExpectBody.Negate {
			held = !found
		}
		if def.ExpectBody != nil {
			s.BodyMatched = bptr(held)
		}
		switch {
		case merr != nil:
			s.Error = truncateError(merr)
		case !held && def.ExpectBody != nil && def.ExpectBody.Negate:
			s.Error = fmt.Sprintf("Forbidden text found in the first 64 KB of the response body (HTTP %d)", res.status)
		case !held:
			s.Error = fmt.Sprintf("Expected text not found in the first 64 KB of the response body (HTTP %d)", res.status)
		default:
			s.OK = true
		}
	}
	if !s.OK || def.KeepBodyExcerpt {
		s.BodyExcerpt = bodyExcerpt(body)
	}
}
