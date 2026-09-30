package collectors

// The request options (agent 0.23.0): HEAD, a Host header override, followed
// redirects and a negated body match. Mirrored by the server's runner
// (src/services/pathCheckServerRunner.ts) — tests/unit/pathCheckServerRunner.test.ts
// pins the same behaviour there.

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/polaris/agent/internal/transport"
)

func TestValidateCheckDefRequestOptions(t *testing.T) {
	base := transport.PathCheckDef{ID: "c1", Kind: "https", Target: "https://x.example/", IntervalSec: 60, TimeoutMs: 5000}
	cases := []struct {
		name string
		mut  func(d *transport.PathCheckDef)
		ok   bool
	}{
		{"GET", func(d *transport.PathCheckDef) { d.Method = "GET" }, true},
		{"HEAD", func(d *transport.PathCheckDef) { d.Method = "HEAD" }, true},
		{"POST refused", func(d *transport.PathCheckDef) { d.Method = "POST" }, false},
		{"DELETE refused", func(d *transport.PathCheckDef) { d.Method = "DELETE" }, false},
		{"HEAD with a body match refused", func(d *transport.PathCheckDef) {
			d.Method = "HEAD"
			d.ExpectBody = &transport.PathCheckBodyExpect{Mode: "contains", Value: "ok"}
		}, false},
		{"host header", func(d *transport.PathCheckDef) { d.HostHeader = "app.example:8443" }, true},
		{"host header with a path refused", func(d *transport.PathCheckDef) { d.HostHeader = "app.example/evil" }, false},
		{"host header with CRLF refused", func(d *transport.PathCheckDef) { d.HostHeader = "a.example\r\nX-Evil: 1" }, false},
		{"host header bad port refused", func(d *transport.PathCheckDef) { d.HostHeader = "a.example:99999" }, false},
	}
	for _, c := range cases {
		d := base
		c.mut(&d)
		if err := ValidateCheckDef(&d); (err == nil) != c.ok {
			t.Errorf("%s: err=%v, want ok=%v", c.name, err, c.ok)
		}
	}
}

func TestRunHTTPNegatedBodyMatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("Down for maintenance"))
	}))
	defer srv.Close()
	fail := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", ExpectBody: &transport.PathCheckBodyExpect{Mode: "contains", Value: "maintenance", Negate: true}})
	if fail.OK || fail.BodyMatched == nil || *fail.BodyMatched || !strings.Contains(fail.Error, "Forbidden text found") {
		t.Fatalf("negated match on present text: ok=%v matched=%v err=%q", fail.OK, fail.BodyMatched, fail.Error)
	}
	pass := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", ExpectBody: &transport.PathCheckBodyExpect{Mode: "contains", Value: "error", Negate: true}})
	if !pass.OK || pass.BodyMatched == nil || !*pass.BodyMatched {
		t.Fatalf("negated match on absent text: ok=%v matched=%v err=%q", pass.OK, pass.BodyMatched, pass.Error)
	}
}

func TestRunHTTPHeadAndHostHeader(t *testing.T) {
	var gotMethod, gotHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotHost = r.Method, r.Host
		_, _ = w.Write([]byte("hello"))
	}))
	defer srv.Close()
	s := runHTTPAgainst(t, srv, transport.PathCheckDef{Kind: "http", Method: "HEAD", HostHeader: "intranet.example"})
	if !s.OK || gotMethod != "HEAD" || gotHost != "intranet.example" {
		t.Fatalf("ok=%v method=%q host=%q err=%q", s.OK, gotMethod, gotHost, s.Error)
	}
	if s.BodyBytes == nil || *s.BodyBytes != 0 {
		t.Fatalf("a HEAD reads no body, got %v", s.BodyBytes)
	}
}

func TestRunHTTPFollowsRedirectsOnlyWhenAsked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start":
			http.Redirect(w, r, "/mid", http.StatusFound)
		case "/mid":
			http.Redirect(w, r, "/end", http.StatusMovedPermanently)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		default:
			_, _ = w.Write([]byte("arrived"))
		}
	}))
	defer srv.Close()
	// A redirect re-resolves its host, so the loopback fixture needs the
	// refusal lifted — production never does this.
	orig := refuseAddrHook
	refuseAddrHook = func(net.IP) error { return nil }
	defer func() { refuseAddrHook = orig }()

	off := runHTTPAgainstPath(t, srv, "/start", transport.PathCheckDef{Kind: "http"})
	if off.OK || off.HTTPStatus == nil || *off.HTTPStatus != 302 {
		t.Fatalf("not following: want the 302 judged, got status=%v err=%q", off.HTTPStatus, off.Error)
	}
	on := runHTTPAgainstPath(t, srv, "/start", transport.PathCheckDef{Kind: "http", FollowRedirects: true, ExpectBody: &transport.PathCheckBodyExpect{Mode: "contains", Value: "arrived"}})
	if !on.OK || *on.HTTPStatus != 200 {
		t.Fatalf("following: ok=%v status=%v err=%q", on.OK, on.HTTPStatus, on.Error)
	}
	loop := runHTTPAgainstPath(t, srv, "/loop", transport.PathCheckDef{Kind: "http", FollowRedirects: true})
	if loop.OK || !strings.Contains(loop.Error, "more than 5 redirects") {
		t.Fatalf("a redirect loop must stop: err=%q", loop.Error)
	}
}

func TestRunHTTPRefusesARedirectIntoLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:1/admin", http.StatusFound)
	}))
	defer srv.Close()
	s := runHTTPAgainstPath(t, srv, "/", transport.PathCheckDef{Kind: "http", FollowRedirects: true})
	if s.OK || !strings.Contains(s.Error, "refused") {
		t.Fatalf("a redirect into loopback must be refused: err=%q", s.Error)
	}
}

func runHTTPAgainstPath(t *testing.T, srv *httptest.Server, path string, def transport.PathCheckDef) *transport.PathCheckSample {
	t.Helper()
	u, _ := url.Parse(srv.URL + path)
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

func TestSameOrigin(t *testing.T) {
	p := func(s string) *url.URL { u, _ := url.Parse(s); return u }
	if !sameOrigin(p("https://a.example/x"), p("https://A.example:443/y")) {
		t.Error("default port and case must not matter")
	}
	if sameOrigin(p("https://a.example/"), p("http://a.example/")) || sameOrigin(p("https://a.example/"), p("https://b.example/")) {
		t.Error("scheme and host must")
	}
}
