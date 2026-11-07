package transport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/polaris/agent/internal/pinned"
)

// pinnedServer starts a TLS test server and returns a client pinned to its
// leaf certificate, the way agent.conf pins the real server (CQ-G009: the
// transport had no tests at all).
func pinnedServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, *Client) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	c := NewClient(srv.URL+"/", []string{pinned.Prefix + hex.EncodeToString(sum[:])}, "tok-1")
	c.AgentVersion = "9.9.9"
	return srv, c
}

func TestHeartbeatSendsBearerAndVersion(t *testing.T) {
	_, c := pinnedServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/heartbeat" || r.Method != "POST" {
			t.Errorf("got %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tok-1" {
			t.Errorf("Authorization = %q", got)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["agentVersion"] != "9.9.9" {
			t.Errorf("agentVersion = %q", body["agentVersion"])
		}
		_, _ = w.Write([]byte(`{"ok":true,"configEtag":"e1"}`))
	})
	resp, err := c.Heartbeat()
	if err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.ConfigETag != "e1" {
		t.Fatalf("got %+v", resp)
	}
}

func TestBaseURLTrailingSlashTrimmed(t *testing.T) {
	srv, c := pinnedServer(t, func(http.ResponseWriter, *http.Request) {})
	if c.BaseURL() != srv.URL {
		t.Fatalf("BaseURL = %q, want %q", c.BaseURL(), srv.URL)
	}
}

func TestBearerMethodsRefuseWithoutToken(t *testing.T) {
	var hits atomic.Int32
	_, c := pinnedServer(t, func(http.ResponseWriter, *http.Request) { hits.Add(1) })
	c.SetBearer("")
	if _, err := c.Heartbeat(); err == nil {
		t.Error("Heartbeat must refuse without a bearer")
	}
	if _, err := c.PushSamples(&SamplesBody{}); err == nil {
		t.Error("PushSamples must refuse without a bearer")
	}
	if _, err := c.FetchConfig(""); err == nil {
		t.Error("FetchConfig must refuse without a bearer")
	}
	if _, err := c.FetchCommands(); err == nil {
		t.Error("FetchCommands must refuse without a bearer")
	}
	if hits.Load() != 0 {
		t.Fatalf("%d requests reached the server without a bearer", hits.Load())
	}
}

func TestEnrollSendsNoBearer(t *testing.T) {
	_, c := pinnedServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("enroll sent Authorization %q", got)
		}
		_, _ = w.Write([]byte(`{"bearer":"long","assetId":"a1"}`))
	})
	c.SetBearer("")
	resp, err := c.Enroll(&EnrollRequest{EnrollmentToken: "one-shot"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Bearer != "long" || resp.AssetID != "a1" {
		t.Fatalf("got %+v", resp)
	}
}

func TestFetchConfigNotModified(t *testing.T) {
	_, c := pinnedServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "e1" {
			t.Errorf("If-None-Match = %q", r.Header.Get("If-None-Match"))
		}
		w.WriteHeader(http.StatusNotModified)
	})
	cfg, err := c.FetchConfig("e1")
	if err != nil || cfg != nil {
		t.Fatalf("got %v %v, want nil nil on 304", cfg, err)
	}
}

func TestErrorStatusCarriesBody(t *testing.T) {
	_, c := pinnedServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "token revoked", http.StatusUnauthorized)
	})
	_, err := c.Heartbeat()
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "token revoked") {
		t.Fatalf("got %v, want the status and the body", err)
	}
}

func TestPinMismatchRefusesTheServer(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a request reached a server whose cert does not match the pin")
	}))
	defer srv.Close()
	c := NewClient(srv.URL, []string{pinned.Prefix + strings.Repeat("0", 64)}, "tok-1")
	if _, err := c.Heartbeat(); err == nil || !strings.Contains(err.Error(), "pin mismatch") {
		t.Fatalf("got %v, want a pin mismatch", err)
	}
}

// Cancelling the bound context aborts a request in flight instead of waiting
// out the 30 s client timeout — what an agent shutdown relies on.
func TestBindContextCancelsInFlight(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	_, c := pinnedServer(t, func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-release
	})
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	c.BindContext(ctx)

	done := make(chan error, 1)
	go func() {
		_, err := c.Heartbeat()
		done <- err
	}()
	<-entered
	cancel()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "context canceled") {
			t.Fatalf("got %v, want context canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the request did not stop when its context was cancelled")
	}
}

// SetBearer while requests are running: every request carries one complete
// token. Run with -race to check the lock itself.
func TestSetBearerConcurrentWithRequests(t *testing.T) {
	_, c := pinnedServer(t, func(w http.ResponseWriter, r *http.Request) {
		if a := r.Header.Get("Authorization"); a != "Bearer tok-1" && a != "Bearer tok-2" {
			t.Errorf("Authorization = %q", a)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				if _, err := c.Heartbeat(); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	for j := 0; j < 20; j++ {
		c.SetBearer("tok-2")
		c.SetBearer("tok-1")
	}
	wg.Wait()
}
