//go:build linux

package collectors

import "testing"

func TestParseSysfsLink(t *testing.T) {
	cases := []struct {
		name                              string
		operstate, carrier, speed, duplex string
		want                              linkInfo
	}{
		{"gigabit full", "up", "1", "1000", "full", linkInfo{oper: "up", speedBps: 1_000_000_000, duplex: "full"}},
		{"half duplex 100M", "up", "1", "100", "half", linkInfo{oper: "up", speedBps: 100_000_000, duplex: "half"}},
		// The kernel answers EINVAL for speed/duplex on a down link, so the
		// reader hands over empty strings.
		{"unplugged", "down", "0", "", "", linkInfo{oper: "down"}},
		{"speed unknown sentinel", "up", "1", "-1", "unknown", linkInfo{oper: "up"}},
		{"lower layer down", "lowerlayerdown", "", "", "", linkInfo{oper: "lowerLayerDown"}},
		// Loopback / tun report operstate "unknown" forever — carrier decides.
		{"unknown with carrier", "unknown", "1", "", "", linkInfo{oper: "up"}},
		{"unknown no carrier", "unknown", "0", "", "", linkInfo{oper: "down"}},
		// Nothing readable: oper stays empty so the admin heuristic stands.
		{"unknown, unreadable carrier", "unknown", "", "", "", linkInfo{}},
	}
	for _, c := range cases {
		got := parseSysfsLink(c.operstate, c.carrier, c.speed, c.duplex)
		if got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}
