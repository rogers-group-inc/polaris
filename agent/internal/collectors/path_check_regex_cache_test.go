package collectors

import (
	"testing"

	"github.com/polaris/agent/internal/transport"
)

// CQ-G011: a check's body regex is compiled once, not on every probe.
func TestCompiledBodyRegexIsCached(t *testing.T) {
	a, err := compiledBodyRegex(`^ok-\d+$`)
	if err != nil {
		t.Fatal(err)
	}
	b, err := compiledBodyRegex(`^ok-\d+$`)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("the same pattern must return the same compiled *Regexp")
	}
	c, _ := compiledBodyRegex(`(?i)^ok-\d+$`)
	if c == a {
		t.Fatal("the case-insensitive pattern is a different key")
	}
	if _, err := compiledBodyRegex(`(`); err == nil {
		t.Fatal("an invalid pattern must error")
	}
	if _, ok := bodyRegexCache.Load(`(`); ok {
		t.Fatal("an invalid pattern must not be cached")
	}
}

func TestBodyMatchesRegexStillMatches(t *testing.T) {
	exp := &transport.PathCheckBodyExpect{Mode: "regex", Value: "status: up"}
	for i := 0; i < 3; i++ { // repeated probes hit the cache
		ok, err := bodyMatches([]byte("STATUS: UP"), exp)
		if err != nil || !ok {
			t.Fatalf("probe %d: got %v %v, want case-insensitive match", i, ok, err)
		}
	}
}
