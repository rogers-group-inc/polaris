package collectors

import "testing"

// Business rule 126 on the agent side: one routable address per family, and
// never the loopback / link-local the old fallback reported.
func TestPickAddresses(t *testing.T) {
	cases := []struct {
		name   string
		addrs  []string
		v4, v6 string
	}{
		{"dual stack, link-local first", []string{"fe80::1/64", "192.0.2.10/24", "2001:db8::10/64", "2001:db8::11/64"}, "192.0.2.10", "2001:db8::10"},
		{"loopback reports nothing", []string{"127.0.0.1/8", "::1/128"}, "", ""},
		{"IPv6-only NIC with only fe80", []string{"fe80::aa:bb%eth0/64"}, "", ""},
		{"IPv6-only routable", []string{"fe80::1/64", "fd00::5/64"}, "", "fd00::5"},
		{"APIPA and 0.0.0.0/8 dropped", []string{"169.254.3.4/16", "0.1.2.3/8", "198.51.100.7/24"}, "198.51.100.7", ""},
		{"multicast and junk dropped", []string{"ff02::1", "not-an-ip"}, "", ""},
	}
	for _, c := range cases {
		v4, v6 := pickAddresses(c.addrs)
		if v4 != c.v4 || v6 != c.v6 {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, v4, v6, c.v4, c.v6)
		}
	}
}
