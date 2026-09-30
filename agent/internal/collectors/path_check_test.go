package collectors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// The same table the server's parser and the check modal's copy are pinned
// to (tests/unit/pathCheckStatusSpecParity.test.ts). Keep them identical.
func TestParseStatusSpec(t *testing.T) {
	ok := []struct {
		spec string
		in   []int
		out  []int
	}{
		{"", []int{200, 204, 299}, []int{199, 300, 404}},
		{"200", []int{200}, []int{201}},
		{"200, 204,300-399", []int{200, 204, 302, 399}, []int{201, 400}},
	}
	for _, c := range ok {
		r, err := parseStatusSpec(c.spec)
		if err != nil {
			t.Fatalf("%q: %v", c.spec, err)
		}
		for _, code := range c.in {
			if !statusAccepted(code, r) {
				t.Errorf("%q should accept %d", c.spec, code)
			}
		}
		for _, code := range c.out {
			if statusAccepted(code, r) {
				t.Errorf("%q should refuse %d", c.spec, code)
			}
		}
	}
	for _, bad := range []string{"20", "200-", "599-200", "abc", "200,,204", "700"} {
		if _, err := parseStatusSpec(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestBodyMatches(t *testing.T) {
	body := []byte("Status: OK\r\n")
	cases := []struct {
		exp  transport.PathCheckBodyExpect
		want bool
	}{
		{transport.PathCheckBodyExpect{Mode: "contains", Value: "ok"}, true},
		{transport.PathCheckBodyExpect{Mode: "contains", Value: "ok", CaseSensitive: true}, false},
		{transport.PathCheckBodyExpect{Mode: "regex", Value: `status:\s+ok`}, true},
		{transport.PathCheckBodyExpect{Mode: "exact", Value: "status: ok"}, true},
		{transport.PathCheckBodyExpect{Mode: "exact", Value: "Status: OK", CaseSensitive: true}, true},
		{transport.PathCheckBodyExpect{Mode: "exact", Value: "Status"}, false},
	}
	for _, c := range cases {
		e := c.exp
		got, err := bodyMatches(body, &e)
		if err != nil || got != c.want {
			t.Errorf("%+v: got %v err %v, want %v", c.exp, got, err, c.want)
		}
	}
	if _, err := bodyMatches(body, &transport.PathCheckBodyExpect{Mode: "regex", Value: "("}); err == nil {
		t.Error("invalid regex should error")
	}
}

func TestBodyExcerptCutsOnARuneBoundary(t *testing.T) {
	b := []byte(strings.Repeat("é", pathCheckMaxExcerptBytes)) // 2 bytes each
	got := bodyExcerpt(b)
	if len(got) > pathCheckMaxExcerptBytes || !strings.HasSuffix(got, "é") {
		t.Fatalf("excerpt not cut cleanly: len=%d", len(got))
	}
	if bodyExcerpt([]byte{0xff, 'a'}) != "�a" {
		t.Error("invalid UTF-8 should be replaced")
	}
}

func TestRefuseAddr(t *testing.T) {
	for _, s := range []string{"127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "::1"} {
		if refuseAddr(net.ParseIP(s)) == nil {
			t.Errorf("%s should be refused", s)
		}
	}
	for _, s := range []string{"10.0.0.1", "192.168.1.1", "8.8.8.8"} {
		if err := refuseAddr(net.ParseIP(s)); err != nil {
			t.Errorf("%s should be allowed: %v", s, err)
		}
	}
}

func TestResolveTargetRefusesAfterResolution(t *testing.T) {
	orig := lookupHost
	defer func() { lookupHost = orig }()
	lookupHost = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("127.0.0.1")}, nil }
	if _, _, err := resolveTarget(context.Background(), "sneaky.example"); err == nil {
		t.Fatal("a name resolving to loopback must be refused")
	}
	lookupHost = func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP("2001:db8::1")}, nil }
	if _, _, err := resolveTarget(context.Background(), "v6only.example"); !errors.Is(err, ErrIPv6Unsupported) {
		t.Fatalf("v6-only should be ErrIPv6Unsupported, got %v", err)
	}
	lookupHost = func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("2001:db8::1"), net.ParseIP("10.1.2.3")}, nil
	}
	ip, dns, err := resolveTarget(context.Background(), "dual.example")
	if err != nil || ip.String() != "10.1.2.3" || dns == nil {
		t.Fatalf("got %v %v %v", ip, dns, err)
	}
	if _, dns, _ := resolveTarget(context.Background(), "10.9.9.9"); dns != nil {
		t.Error("an IP literal takes no DNS time")
	}
}

func TestSplitTargetHostPort(t *testing.T) {
	if _, _, err := splitTargetHostPort("tcp", "db01.example"); err == nil {
		t.Error("tcp needs a port")
	}
	if h, p, err := splitTargetHostPort("tcp", "db01.example:5432"); err != nil || h != "db01.example" || p != 5432 {
		t.Errorf("got %s %d %v", h, p, err)
	}
	if _, _, err := splitTargetHostPort("icmp", "host:22"); err == nil {
		t.Error("icmp forbids a port")
	}
}

func validDef() transport.PathCheckDef {
	return transport.PathCheckDef{ID: "c1", Kind: "https", Target: "https://intranet.example/", IntervalSec: 60, TimeoutMs: 5000}
}

func TestValidateCheckDef(t *testing.T) {
	d := validDef()
	if err := ValidateCheckDef(&d); err != nil {
		t.Fatal(err)
	}
	bad := []func(*transport.PathCheckDef){
		func(d *transport.PathCheckDef) { d.Kind = "ftp" },
		func(d *transport.PathCheckDef) { d.IntervalSec = 90 },
		func(d *transport.PathCheckDef) { d.TimeoutMs = 100 },
		func(d *transport.PathCheckDef) { d.ExpectStatus = "abc" },
		func(d *transport.PathCheckDef) {
			d.ExpectBody = &transport.PathCheckBodyExpect{Mode: "glob", Value: "x"}
		},
		func(d *transport.PathCheckDef) { d.Traceroute.MaxHops = 500 },
		func(d *transport.PathCheckDef) { d.ID = "" },
	}
	for i, mut := range bad {
		d := validDef()
		mut(&d)
		if err := ValidateCheckDef(&d); err == nil {
			t.Errorf("case %d should be refused", i)
		}
	}
}

func TestRunOnceRefusesAnInvalidDefinitionWithoutProbing(t *testing.T) {
	d := validDef()
	d.Kind = "ftp"
	s, tr := RunOnce(context.Background(), &d, PathCheckOpts{Trace: TraceAlways})
	if s.OK || !strings.HasPrefix(s.Error, "refused:") || tr != nil {
		t.Fatalf("got %+v %v", s, tr)
	}
}

func TestDefHashIsStableAndSensitive(t *testing.T) {
	a, b := validDef(), validDef()
	if DefHash(&a) != DefHash(&b) {
		t.Fatal("same def, different hash")
	}
	b.Target = "https://other.example/"
	if DefHash(&a) == DefHash(&b) {
		t.Fatal("target change must change the hash")
	}
}

func TestTruncateError(t *testing.T) {
	if got := truncateError(errors.New(strings.Repeat("x", 600))); len(got) != pathCheckMaxErrorLen {
		t.Fatalf("len %d", len(got))
	}
}

// ─── runHTTP against a local server ───────────────────────────────────────
// runHTTP takes the already-resolved IP, which is how these tests reach a
// loopback server that resolveTarget would (rightly) refuse.

func runHTTPAgainst(t *testing.T, srv *httptest.Server, def transport.PathCheckDef) *transport.PathCheckSample {
	t.Helper()
	u, _ := url.Parse(srv.URL + "/health")
	def.Target = u.String()
	if def.ID == "" {
		def.ID = "c1"
	}
	if def.TimeoutMs == 0 {
		def.TimeoutMs = 5000
	}
	s := &transport.PathCheckSample{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	runHTTP(ctx, &def, u, net.ParseIP("127.0.0.1"), "polaris-agent/test", s)
	return s
}

func TestRunHTTPStatusBodyAndExcerpt(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.UserAgent()
		switch r.URL.Query().Get("x") {
		default:
			_, _ = w.Write([]byte("service ok"))
		}
	}))
	defer srv.Close()

	s := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", ExpectBody: &transport.PathCheckBodyExpect{Mode: "contains", Value: "OK"}})
	if !s.OK || *s.HTTPStatus != 200 || s.BodyMatched == nil || !*s.BodyMatched {
		t.Fatalf("got %+v", s)
	}
	sum := sha256.Sum256([]byte("service ok"))
	if s.BodySha256 != hex.EncodeToString(sum[:]) || *s.BodyBytes != len("service ok") {
		t.Errorf("hash/bytes wrong: %s %d", s.BodySha256, *s.BodyBytes)
	}
	if s.BodyExcerpt != "" {
		t.Error("a passing run keeps no excerpt unless asked")
	}
	if gotUA != "polaris-agent/test" {
		t.Errorf("user agent %q", gotUA)
	}
	if s.LatencyMs == nil || s.TTFBMs == nil || s.ConnectMs == nil {
		t.Error("timings missing")
	}

	kept := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", KeepBodyExcerpt: true})
	if kept.BodyExcerpt != "service ok" {
		t.Errorf("keepBodyExcerpt: %q", kept.BodyExcerpt)
	}

	miss := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", ExpectBody: &transport.PathCheckBodyExpect{Mode: "contains", Value: "nope"}})
	if miss.OK || !strings.Contains(miss.Error, "Expected text not found") || miss.BodyExcerpt != "service ok" {
		t.Errorf("body miss: %+v", miss)
	}
}

func TestRunHTTPJudgesStatusFirstAndNeverFollowsRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("followed"))
	}))
	defer srv.Close()
	s := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http"})
	if s.OK || *s.HTTPStatus != 302 || !strings.Contains(s.Error, "HTTP 302") {
		t.Fatalf("a redirect must be judged as itself: %+v", s)
	}
	ok := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", ExpectStatus: "200,300-399"})
	if !ok.OK {
		t.Fatalf("302 accepted by spec: %+v", ok)
	}
}

func TestRunHTTPCapsTheBodyAt64KB(t *testing.T) {
	big := strings.Repeat("a", pathCheckMaxBodyBytes+5000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(big)) }))
	defer srv.Close()
	s := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http"})
	sum := sha256.Sum256([]byte(big[:pathCheckMaxBodyBytes]))
	if *s.BodyBytes != pathCheckMaxBodyBytes || s.BodySha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("cap: bytes=%d", *s.BodyBytes)
	}
}

func TestRunHTTPReportsTheCertificateEvenWhenVerificationFails(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }))
	defer srv.Close()
	insecure := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "https", VerifyTLS: false})
	if !insecure.OK || insecure.TLSNotAfter == "" || insecure.TLSMs == nil {
		t.Fatalf("verifyTls=false: %+v", insecure)
	}
	strict := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "https", VerifyTLS: true})
	if strict.OK || !strings.Contains(strict.Error, "certificate") {
		t.Fatalf("verifyTls=true should fail on a self-signed cert: %+v", strict)
	}
	if strict.TLSNotAfter == "" {
		t.Error("tlsNotAfter must be reported for the certificate that failed")
	}
}

func TestParseCheckURL(t *testing.T) {
	if _, _, err := parseCheckURL("http", "http://u:p@host/"); err == nil {
		t.Error("userinfo refused")
	}
	if _, _, err := parseCheckURL("https", "http://host/"); err == nil {
		t.Error("scheme mismatch refused")
	}
	if _, h, err := parseCheckURL("https", "intranet.example/x"); err != nil || h != "intranet.example" {
		t.Errorf("scheme-less target: %s %v", h, err)
	}
}
